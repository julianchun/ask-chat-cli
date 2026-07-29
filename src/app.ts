import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import {
  createChromeSessionController,
  ChromeSessionConflictError,
  type ChromeSessionController,
  type ChromeSessionRequest
} from "./browser";
import { getScreenshotsDir } from "./config";
import {
  createConversationContinuity,
  type ConversationContinuity,
  type NamedConversation
} from "./conversations";
import {
  createExecutionQueue,
  type ExecutionQueue,
  type ExecutionQueueUpdate
} from "./execution-queue";
import {
  AskFailure,
  type AskExecutionStage,
  type AskFailureCode,
  type AskFailureContext
} from "./errors";
import { timestampForFile } from "./io";
import {
  getProvider,
  PROVIDER_NAMES,
  resolveProviderName,
  type ProviderDefinition,
  type ProviderName
} from "./providers";
import type { SessionOwnership } from "./session";
import {
  openChatPage,
  openWorkerPage,
  selectCurrentPage,
  type AuthState,
  type ProviderPageInspection,
  type ResponseResult
} from "./webchat";

export interface AppOptions {
  env?: NodeJS.ProcessEnv;
  chromeSession?: ChromeSessionController;
  conversationContinuity?: ConversationContinuity;
  executionQueue?: ExecutionQueue;
}

export interface PromptRunOptions {
  prompt: string;
  attachments: string[];
  provider?: ProviderName;
  headless?: boolean;
  newSession?: boolean;
  conversationName?: string;
  onContinuationUnavailable?: () => void;
  onQueueUpdate?: (update: ExecutionQueueUpdate) => void;
  timeoutMs: number;
  verbose?: boolean;
}

export interface OpenOptions extends PromptRunOptions {
  url: string;
  send: boolean;
}

export interface SimpleBrowserOptions {
  provider?: ProviderName;
  headless?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
}

export type ProviderReadiness =
  | "not-running"
  | "session-conflict"
  | "not-open"
  | "blocked"
  | "login-required"
  | "ready"
  | "not-ready";

export type MessageBoxStatus = "available" | "not-found" | "not-checked";

export interface BrowserSessionStatus {
  port: number;
  connected: boolean;
  sessionOwnership: SessionOwnership;
  headless?: boolean;
  browser?: string;
  userAgent?: string;
  pageCount: number;
}

export interface ProviderStatus {
  provider: ProviderName;
  providerDisplayName: string;
  status: ProviderReadiness;
  providerPageCount: number;
  currentPageUrl?: string;
  messageBox: MessageBoxStatus;
  promptInputVisible: boolean;
  authState: AuthState;
  readyToSend: boolean;
  readyForHeadless: boolean;
  loggedInLikely: boolean;
  note: string;
}

export interface BrowserStatusReport {
  session: BrowserSessionStatus;
  providers: ProviderStatus[];
}

export interface PromptRunResult extends ResponseResult {
  failure?: AskFailure;
}

const DEFAULT_STATUS_TIMEOUT_MS = 3_000;

export class AskApp {
  private readonly env: NodeJS.ProcessEnv;
  private readonly chromeSession: ChromeSessionController;
  private readonly conversations: ConversationContinuity;
  private readonly executionQueue: ExecutionQueue;

  constructor(options: AppOptions = {}) {
    this.env = options.env || process.env;
    this.chromeSession = options.chromeSession || createChromeSessionController(this.env);
    this.conversations = options.conversationContinuity || createConversationContinuity(this.env);
    this.executionQueue = options.executionQueue || createExecutionQueue(this.env);
  }

  async login(options: SimpleBrowserOptions = {}): Promise<void> {
    if (options.headless) {
      throw new Error("`ask login` requires a visible browser. Use `ask login --provider <provider>` without --headless.");
    }

    const lease = await this.executionQueue.acquireBrowserLease({
      headless: false,
      exclusive: true,
      action: "log in or change the shared Chrome session"
    });
    try {
      const provider = this.resolveProvider(options.provider);
      const browser = await this.chromeSession.connect({
        ...this.chromeOptions({ ...options, headless: false }),
        requireManaged: true,
        requireVisible: true,
        url: provider.homeUrl
      });
      try {
        await openChatPage(browser, provider, provider.homeUrl);
      } finally {
        await browser.close();
      }
    } finally {
      await lease.release();
    }
  }

  async open(options: OpenOptions): Promise<void> {
    const provider = this.resolveProvider(options.provider);
    if (options.send) {
      return this.openAndSend(provider, options);
    }
    const lease = await this.executionQueue.acquireBrowserLease({
      headless: Boolean(options.headless),
      action: "open the shared Chrome session in a different mode"
    });
    try {
      await this.assertHeadlessAllowedIfNeeded(provider, options);
      const browser = await this.chromeSession.connect({
        ...this.chromeOptions(options),
        requireManaged: true,
        requireVisible: !options.headless,
        url: options.url
      });
      try {
        const session = await this.conversations.resolve(browser, provider, {
          requestedUrl: options.url,
          newSession: options.newSession,
          conversationName: options.conversationName,
          onContinuationUnavailable: options.onContinuationUnavailable
        });
        if (session.conversationName && session.newSession && !options.send) {
          throw new Error(
            `Named conversation \"${session.conversationName}\" does not exist yet. ` +
              "Use `ask open --send --conversation <name> <prompt>` so ask can save the new conversation URL."
          );
        }
        const page = await openChatPage(browser, provider, session.url, { newSession: true });
        await provider.automation.attachFiles(page, options.attachments);
        if (options.prompt) {
          await provider.automation.fillPrompt(page, options.prompt, Math.min(options.timeoutMs, 30_000));
        }
        await this.conversations.remember(provider, page, session.conversationName);
      } finally {
        await browser.close();
      }
    } finally {
      await lease.release();
    }
  }

  async ask(options: PromptRunOptions): Promise<PromptRunResult> {
    const provider = this.resolveProvider(options.provider);
    const lease = await this.runStage(
      provider,
      "queue.acquire",
      "QUEUE_UNAVAILABLE",
      () => this.executionQueue.acquire({
        provider: provider.name,
        conversationName: options.conversationName,
        exclusiveProvider: options.newSession === false && !options.conversationName,
        headless: options.headless,
        onUpdate: options.onQueueUpdate
      }),
      "Could not acquire an execution slot.",
      "Wait for another execution to finish, then try again.",
      true,
      undefined,
      true
    );
    try {
      await this.assertHeadlessAllowedIfNeeded(provider, options);
      const browser = await this.connectBrowser(provider, {
        ...this.chromeOptions(options),
        requireManaged: true,
        requireVisible: !options.headless,
        url: provider.homeUrl
      });
      try {
        const session = await this.runStage(
          provider,
          "conversation.resolve",
          "CONVERSATION_STATE_FAILED",
          () => this.conversations.resolve(browser, provider, {
            requestedUrl: provider.homeUrl,
            newSession: options.newSession,
            conversationName: options.conversationName,
            onContinuationUnavailable: options.onContinuationUnavailable
          }),
          "Could not resolve the requested conversation.",
          `Retry with \`ask --provider ${provider.name} --new <prompt>\`.`,
          true
        );
        const page = await this.runStage(
          provider,
          "page.open",
          "BROWSER_UNAVAILABLE",
          () => openWorkerPage(browser, provider, session.url),
          `Could not open a ${provider.displayName} worker page.`,
          `Run \`ask status --provider ${provider.name} --verbose\`.`,
          true
        );
        try {
          const result = await this.executePromptOnPage(page, provider, options);
          if (result.timedOut) {
            return {
              ...result,
              failure: this.responseTimeoutFailure(provider, page, Boolean(result.text))
            };
          }
          await this.runStage(
            provider,
            "conversation.save",
            "CONVERSATION_STATE_FAILED",
            () => this.conversations.remember(provider, page, session.conversationName),
            `Received a response, but could not save the ${provider.displayName} conversation state.`,
            "The provider conversation still exists; retry without conversation continuation if needed.",
            false,
            this.failureContext(provider, page)
          );
          const conversationUrl = page.url();
          return {
            ...result,
            ...(provider.matchesConversationUrl(conversationUrl) ? { conversationUrl } : {})
          };
        } finally {
          await page.close().catch(() => undefined);
        }
      } finally {
        await browser.close();
      }
    } finally {
      await lease.release();
    }
  }

  async get(options: SimpleBrowserOptions = {}): Promise<string> {
    const provider = this.resolveProvider(options.provider);
    const lease = await this.acquireBrowserReadLease(options, "read from the shared Chrome session");
    try {
      const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false, requireManaged: true });
      try {
        const page = selectCurrentPage(browser, provider, await this.conversations.preferredUrl(provider));
        return await provider.automation.extractLatestAssistantText(page);
      } finally {
        await browser.close();
      }
    } finally {
      await lease.release();
    }
  }

  async listConversations(providerName?: ProviderName): Promise<NamedConversation[]> {
    return this.conversations.list(providerName);
  }

  async forgetConversation(name: string, providerName?: ProviderName): Promise<boolean> {
    const provider = this.resolveProvider(providerName);
    const lease = await this.executionQueue.acquireConversationLease(provider.name, name);
    try {
      return await this.conversations.forget(provider.name, name);
    } finally {
      await lease.release();
    }
  }

  private async openAndSend(provider: ProviderDefinition, options: OpenOptions): Promise<void> {
    if (!options.prompt) {
      throw new Error("`ask open --send` requires a prompt.");
    }
    const lease = await this.runStage(
      provider,
      "queue.acquire",
      "QUEUE_UNAVAILABLE",
      () => this.executionQueue.acquire({
        provider: provider.name,
        conversationName: options.conversationName,
        exclusiveProvider: options.newSession === false && !options.conversationName,
        headless: options.headless,
        onUpdate: options.onQueueUpdate
      }),
      "Could not acquire an execution slot.",
      "Wait for another execution to finish, then try again.",
      true,
      undefined,
      true
    );
    try {
      await this.assertHeadlessAllowedIfNeeded(provider, options);
      const browser = await this.connectBrowser(provider, {
        ...this.chromeOptions(options),
        requireManaged: true,
        requireVisible: true,
        url: options.url
      });
      try {
        const session = await this.runStage(
          provider,
          "conversation.resolve",
          "CONVERSATION_STATE_FAILED",
          () => this.conversations.resolve(browser, provider, {
            requestedUrl: options.url,
            newSession: options.newSession,
            conversationName: options.conversationName,
            onContinuationUnavailable: options.onContinuationUnavailable
          }),
          "Could not resolve the requested conversation.",
          `Retry with \`ask open --provider ${provider.name} --new --send <prompt>\`.`,
          true
        );
        const page = await this.runStage(
          provider,
          "page.open",
          "BROWSER_UNAVAILABLE",
          () => openWorkerPage(browser, provider, session.url),
          `Could not open a ${provider.displayName} worker page.`,
          `Run \`ask status --provider ${provider.name} --verbose\`.`,
          true
        );
        try {
          await page.bringToFront();
          const result = await this.executePromptOnPage(page, provider, options);
          if (result.timedOut) {
            throw this.responseTimeoutFailure(provider, page, Boolean(result.text));
          }
          await this.runStage(
            provider,
            "conversation.save",
            "CONVERSATION_STATE_FAILED",
            () => this.conversations.remember(provider, page, session.conversationName),
            `Received a response, but could not save the ${provider.displayName} conversation state.`,
            "The provider conversation still exists; retry without conversation continuation if needed.",
            false,
            this.failureContext(provider, page)
          );
        } finally {
          await page.close().catch(() => undefined);
        }
      } finally {
        await browser.close();
      }
    } finally {
      await lease.release();
    }
  }

  private async executePromptOnPage(
    page: Page,
    provider: ProviderDefinition,
    options: PromptRunOptions
  ): Promise<ResponseResult> {
    await this.assertSignedInBeforeSend(page, provider, options);
    await this.runStage(
      provider,
      "attachment.upload",
      "ATTACHMENT_UPLOAD_FAILED",
      () => provider.automation.attachFiles(page, options.attachments),
      `${provider.displayName} could not attach the requested file.`,
      "Check that each attachment exists and is supported, then try again.",
      true,
      this.failureContext(provider, page)
    );
    const input = await this.runStage(
      provider,
      "prompt.find",
      "PROMPT_INPUT_NOT_FOUND",
      () => provider.automation.fillPrompt(page, options.prompt, Math.min(options.timeoutMs, 30_000)),
      `Could not find a visible ${provider.displayName} message box.`,
      `Run \`ask status --provider ${provider.name} --verbose\`.`,
      true,
      this.failureContext(provider, page, { promptInputVisible: false })
    );
    const baseline = await this.runStage(
      provider,
      "response.baseline",
      "RESPONSE_NOT_DETECTED",
      () => provider.automation.captureAssistantResponseBaseline(page),
      `Could not inspect the current ${provider.displayName} response state.`,
      `Run \`ask status --provider ${provider.name} --verbose\`.`,
      true,
      this.failureContext(provider, page)
    );
    await this.runStage(
      provider,
      "prompt.submit",
      "PROMPT_SUBMIT_FAILED",
      () => provider.automation.submitPrompt(page, input, Math.min(options.timeoutMs, 30_000)),
      `${provider.displayName} did not accept the prompt.`,
      "Wait for attachments to finish processing, then try again.",
      true,
      this.failureContext(provider, page)
    );
    const result = await this.runStage(
      provider,
      "response.wait",
      "RESPONSE_NOT_DETECTED",
      () => provider.automation.waitForAssistantCompletion(page, { timeoutMs: options.timeoutMs, baseline }),
      `Could not detect a ${provider.displayName} response.`,
      `Run \`ask status --provider ${provider.name} --verbose\`.`,
      true,
      this.failureContext(provider, page)
    );
    if (result.timedOut) {
      await provider.automation.stopAssistantGeneration(page);
    }
    return result;
  }

  async dump(options: SimpleBrowserOptions = {}): Promise<string> {
    const provider = this.resolveProvider(options.provider);
    const lease = await this.acquireBrowserReadLease(options, "read from the shared Chrome session");
    try {
      const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false, requireManaged: true });
      try {
        const page = selectCurrentPage(browser, provider, await this.conversations.preferredUrl(provider));
        return await page.content();
      } finally {
        await browser.close();
      }
    } finally {
      await lease.release();
    }
  }

  async screenshot(output?: string, options: SimpleBrowserOptions = {}): Promise<string> {
    const provider = this.resolveProvider(options.provider);
    const lease = await this.acquireBrowserReadLease(options, "capture the shared Chrome session");
    try {
      const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false, requireManaged: true });
      try {
        const page = selectCurrentPage(browser, provider, await this.conversations.preferredUrl(provider));
        const screenshotPath = output ? path.resolve(output) : this.defaultScreenshotPath(provider);
        await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath, fullPage: true });
        return screenshotPath;
      } finally {
        await browser.close();
      }
    } finally {
      await lease.release();
    }
  }

  async status(options: SimpleBrowserOptions = {}): Promise<BrowserStatusReport> {
    const providers = options.provider
      ? [this.resolveProvider(options.provider)]
      : PROVIDER_NAMES.map((providerName) => getProvider(providerName));
    const inspectedSession = await this.chromeSession.inspect(this.chromeOptions(options));
    const { port, classification } = inspectedSession;
    const initialSession: BrowserSessionStatus = {
      port,
      connected: inspectedSession.connected,
      sessionOwnership: classification.ownership,
      headless: inspectedSession.headless,
      browser: inspectedSession.browser,
      userAgent: inspectedSession.userAgent,
      pageCount: 0
    };

    if (!inspectedSession.connected || classification.ownership === "absent") {
      return {
        session: { ...initialSession, connected: false, sessionOwnership: "absent" },
        providers: providers.map((provider) =>
          this.emptyProviderStatus(
            provider,
            "not-running",
            `No Chrome debugging session is available on port ${port}. Run \`ask login --provider ${provider.name}\` to open one.`
          )
        )
      };
    }

    if (classification.ownership !== "ask-managed") {
      return {
        session: initialSession,
        providers: providers.map((provider) =>
          this.emptyProviderStatus(
            provider,
            "session-conflict",
            `Chrome debugging is present on port ${port}, but it is not an ask-managed session. ${classification.reason || "The session could not be verified."}`
          )
        )
      };
    }

    const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false });
    try {
      const pages = browser.contexts().flatMap((context) => context.pages());
      const session: BrowserSessionStatus = {
        ...initialSession,
        connected: true,
        pageCount: pages.length
      };
      const providerStatuses = await Promise.all(
        providers.map(async (provider): Promise<ProviderStatus> => {
          const providerPages = pages.filter((page) => provider.matchesPageUrl(page.url()));
          const page = providerPages.at(-1);
          if (!page) {
            return this.emptyProviderStatus(
              provider,
              "not-open",
              `No ${provider.displayName} page is open in the ask-managed Chrome session.`
            );
          }

          const inspection = await provider.automation.inspectPage(
            page,
            options.timeoutMs || DEFAULT_STATUS_TIMEOUT_MS
          );
          return {
            provider: provider.name,
            providerDisplayName: provider.displayName,
            status: this.providerReadiness(inspection),
            providerPageCount: providerPages.length,
            currentPageUrl: page.url(),
            messageBox: inspection.promptInputVisible ? "available" : "not-found",
            promptInputVisible: inspection.promptInputVisible,
            authState: inspection.authState,
            readyToSend: inspection.readyToSend,
            readyForHeadless: inspection.readyForHeadless,
            loggedInLikely: inspection.authState === "signed-in-likely",
            note: this.statusNote(provider, Boolean(inspectedSession.headless), true, inspection)
          };
        })
      );

      return { session, providers: providerStatuses };
    } finally {
      await browser.close();
    }
  }

  async ensureLoggedInDebugPort(options: SimpleBrowserOptions = {}): Promise<void> {
    await this.chromeSession.waitUntilReady(options.timeoutMs || 15_000);
  }

  private async assertHeadlessAllowedIfNeeded(provider: ProviderDefinition, options: SimpleBrowserOptions): Promise<void> {
    if (!options.headless) {
      return;
    }

    const report = await this.runStage(
      provider,
      "auth.inspect",
      "AUTH_UNCONFIRMED",
      () => this.status({
        provider: provider.name,
        timeoutMs: Math.min(options.timeoutMs || DEFAULT_STATUS_TIMEOUT_MS, DEFAULT_STATUS_TIMEOUT_MS)
      }),
      `Could not determine whether ${provider.displayName} is ready for headless use.`,
      `Run \`ask status --provider ${provider.name} --verbose\`.`,
      true,
      { providerHost: this.providerHost(provider) }
    );
    const status = report.providers[0];
    if (!status) {
      throw this.failure(
        provider,
        "auth.inspect",
        "AUTH_UNCONFIRMED",
        `${provider.displayName} readiness could not be determined.`,
        `Run \`ask status --provider ${provider.name} --verbose\`.`,
        true
      );
    }
    if (report.session.connected && report.session.sessionOwnership !== "ask-managed") {
      throw this.failure(
        provider,
        "browser.connect",
        "SESSION_CONFLICT",
        "The Chrome debugging session is not managed by ask.",
        "Run `ask status --verbose`, or configure a separate ASK_HOME and ASK_REMOTE_DEBUGGING_PORT.",
        false,
        { providerHost: this.providerHost(provider) }
      );
    }
    if (
      report.session.sessionOwnership === "ask-managed" &&
      report.session.headless &&
      status.providerPageCount === 0
    ) {
      return;
    }
    if (!status.readyForHeadless) {
      const messageBoxMissing =
        status.authState === "signed-in-likely" && !status.promptInputVisible;
      throw this.failure(
        provider,
        messageBoxMissing ? "prompt.find" : "auth.inspect",
        messageBoxMissing ? "PROMPT_INPUT_NOT_FOUND" : this.authFailureCode(status.authState),
        messageBoxMissing
          ? `${provider.displayName} appears signed in, but its message box was not found.`
          : `${provider.displayName} is not ready for headless use (auth: ${status.authState}, message box: ${status.promptInputVisible ? "available" : "not found"}). ` +
            `Run \`ask login --provider ${provider.name}\`, then \`ask status --provider ${provider.name}\`.`,
        messageBoxMissing
          ? `Run \`ask status --provider ${provider.name} --verbose\`; the provider UI may have changed.`
          : `Run \`ask login --provider ${provider.name}\`, then retry.`,
        status.authState !== "blocked",
        {
          providerHost: this.providerHost(provider),
          authState: status.authState,
          promptInputVisible: status.promptInputVisible
        }
      );
    }
  }

  private async acquireBrowserReadLease(options: SimpleBrowserOptions, action: string) {
    const session = await this.chromeSession.inspect(this.chromeOptions(options));
    const headless = options.headless === true ? true : Boolean(session.headless);
    return this.executionQueue.acquireBrowserLease({ headless, action });
  }

  private async assertSignedInBeforeSend(page: Page, provider: ProviderDefinition, options: SimpleBrowserOptions): Promise<void> {
    const inspection = await this.runStage(
      provider,
      "auth.inspect",
      "AUTH_UNCONFIRMED",
      () => provider.automation.inspectPage(
        page,
        Math.min(options.timeoutMs || DEFAULT_STATUS_TIMEOUT_MS, DEFAULT_STATUS_TIMEOUT_MS)
      ),
      `Could not determine whether ${provider.displayName} is signed in.`,
      `Run \`ask status --provider ${provider.name} --verbose\`.`,
      true,
      this.failureContext(provider, page)
    );
    if (inspection.authState === "signed-in-likely" && inspection.promptInputVisible) {
      return;
    }

    const messageBoxMissing =
      inspection.authState === "signed-in-likely" && !inspection.promptInputVisible;
    throw this.failure(
      provider,
      messageBoxMissing ? "prompt.find" : "auth.inspect",
      messageBoxMissing ? "PROMPT_INPUT_NOT_FOUND" : this.authFailureCode(inspection.authState),
      messageBoxMissing
        ? `${provider.displayName} appears signed in, but its message box was not found.`
        : `${provider.displayName} is not ready to send from a signed-in session (auth: ${inspection.authState}, message box: ${inspection.promptInputVisible ? "available" : "not found"}). ` +
          `Check the opened ask browser, sign in, then try again. ` +
          `Run \`ask login --provider ${provider.name}\`, then \`ask status --provider ${provider.name}\`.`,
      messageBoxMissing
        ? `Run \`ask status --provider ${provider.name} --verbose\`; the provider UI may have changed.`
        : inspection.authState === "blocked"
        ? "Complete provider verification in the visible ask browser, then retry."
        : `Run \`ask login --provider ${provider.name}\`, then retry.`,
      inspection.authState !== "blocked",
      this.failureContext(provider, page, inspection)
    );
  }
  private emptyProviderStatus(
    provider: ProviderDefinition,
    status: ProviderReadiness,
    note: string
  ): ProviderStatus {
    return {
      provider: provider.name,
      providerDisplayName: provider.displayName,
      status,
      providerPageCount: 0,
      messageBox: "not-checked",
      promptInputVisible: false,
      authState: "unknown",
      readyToSend: false,
      readyForHeadless: false,
      loggedInLikely: false,
      note
    };
  }

  private providerReadiness(inspection: ProviderPageInspection): ProviderReadiness {
    if (inspection.authState === "blocked") {
      return "blocked";
    }
    if (inspection.authState === "guest" || inspection.authState === "login-required") {
      return "login-required";
    }
    if (inspection.authState === "signed-in-likely" && inspection.readyToSend) {
      return "ready";
    }
    return "not-ready";
  }

  private async connectBrowser(provider: ProviderDefinition, options: ChromeSessionRequest) {
    try {
      return await this.chromeSession.connect(options);
    } catch (error) {
      const conflict = error instanceof ChromeSessionConflictError;
      throw this.failure(
        provider,
        "browser.connect",
        conflict ? "SESSION_CONFLICT" : "BROWSER_UNAVAILABLE",
        conflict
          ? "The Chrome debugging session is not managed by ask."
          : "Could not start or connect to the ask-managed Chrome session.",
        conflict
          ? "Run `ask status --verbose`, or configure a separate ASK_HOME and ASK_REMOTE_DEBUGGING_PORT."
          : `Run \`ask login --provider ${provider.name}\`, then retry.`,
        !conflict,
        { providerHost: this.providerHost(provider) },
        error,
        1,
        this.safeErrorDetail(error)
      );
    }
  }

  private async runStage<T>(
    provider: ProviderDefinition,
    stage: AskExecutionStage,
    code: AskFailureCode,
    operation: () => Promise<T>,
    message: string,
    hint: string,
    retryable: boolean,
    context?: AskFailureContext,
    includeCauseDetail = false
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AskFailure) {
        if (!context) {
          throw error;
        }
        throw new AskFailure({
          code: error.code,
          stage: error.stage,
          provider: error.provider,
          providerDisplayName: error.providerDisplayName,
          message: error.message,
          retryable: error.retryable,
          hint: error.hint,
          detail: error.detail,
          context: { ...context, ...error.context },
          cause: error.cause,
          exitCode: error.exitCode
        });
      }
      throw this.failure(
        provider,
        stage,
        code,
        message,
        hint,
        retryable,
        context,
        error,
        1,
        includeCauseDetail ? this.safeErrorDetail(error) : undefined
      );
    }
  }

  private failure(
    provider: ProviderDefinition,
    stage: AskExecutionStage,
    code: AskFailureCode,
    message: string,
    hint: string,
    retryable: boolean,
    context?: AskFailureContext,
    cause?: unknown,
    exitCode = 1,
    detail?: string
  ): AskFailure {
    return new AskFailure({
      code,
      stage,
      provider: provider.name,
      providerDisplayName: provider.displayName,
      message,
      retryable,
      hint,
      detail,
      context,
      cause,
      exitCode
    });
  }

  private responseTimeoutFailure(
    provider: ProviderDefinition,
    page: Page,
    hasPartialResponse: boolean
  ): AskFailure {
    return this.failure(
      provider,
      "response.wait",
      hasPartialResponse ? "RESPONSE_TIMEOUT" : "RESPONSE_NOT_DETECTED",
      hasPartialResponse
        ? `Timed out waiting for ${provider.displayName}; returned the latest partial response.`
        : `Timed out without detecting a ${provider.displayName} response.`,
      `Retry with a larger \`--timeout\`, or run \`ask status --provider ${provider.name} --verbose\`.`,
      true,
      this.failureContext(provider, page),
      undefined,
      2
    );
  }

  private authFailureCode(authState: AuthState): AskFailureCode {
    if (authState === "blocked") {
      return "PROVIDER_BLOCKED";
    }
    if (authState === "guest" || authState === "login-required") {
      return "AUTH_REQUIRED";
    }
    return "AUTH_UNCONFIRMED";
  }

  private failureContext(
    provider: ProviderDefinition,
    page?: Page,
    inspection: Partial<ProviderPageInspection> = {}
  ): AskFailureContext {
    return {
      providerHost: this.pageHost(page) || this.providerHost(provider),
      ...(inspection.authState ? { authState: inspection.authState } : {}),
      ...(typeof inspection.promptInputVisible === "boolean"
        ? { promptInputVisible: inspection.promptInputVisible }
        : {})
    };
  }

  private pageHost(page?: Page): string | undefined {
    if (!page) {
      return undefined;
    }
    try {
      return new URL(page.url()).hostname;
    } catch {
      return undefined;
    }
  }

  private providerHost(provider: ProviderDefinition): string {
    return new URL(provider.homeUrl).hostname;
  }

  private safeErrorDetail(error: unknown): string | undefined {
    if (!(error instanceof Error)) {
      return undefined;
    }
    const detail = error.message
      .replace(
        /\b(authorization|proxy-authorization|cookie|set-cookie)\b(\s*[:=]\s*)[^\r\n]*/gi,
        "$1$2[redacted]"
      )
      .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "$1 [redacted]")
      .replace(
        /\b(password|passwd|token|api[_-]?key|secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1$2[redacted]"
      )
      .replace(
        /([?&](?:access_token|auth|authorization|cookie|key|password|secret|token)=)[^&#\s]*/gi,
        "$1[redacted]"
      )
      .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[redacted]@")
      .replace(/\s+/g, " ")
      .trim();
    if (!detail) {
      return undefined;
    }
    return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail;
  }

  private resolveProvider(providerName?: ProviderName): ProviderDefinition {
    return getProvider(resolveProviderName(providerName, this.env));
  }

  private statusNote(provider: ProviderDefinition, headless: boolean, hasProviderPage: boolean, inspection: ProviderPageInspection): string {
    if (!hasProviderPage) {
      return `No ${provider.displayName} page is open in the ask-managed Chrome session.`;
    }

    if (inspection.authState === "blocked") {
      return `${provider.displayName} appears blocked by verification, limits, or an error page. Inspect the visible browser.`;
    }

    if (inspection.authState === "login-required") {
      return `${provider.displayName} requires login or verification. Run \`ask login --provider ${provider.name}\`.`;
    }

    if (inspection.authState === "guest") {
      return `${provider.displayName} is ready to send, but it appears to be a guest or signed-out session.`;
    }

    if (
      inspection.authState === "signed-in-likely" &&
      !inspection.promptInputVisible
    ) {
      return `${provider.displayName} appears signed in, but its message box was not found. The provider UI may have changed.`;
    }

    if (inspection.authState === "signed-in-likely" && !inspection.readyToSend) {
      return `${provider.displayName} appears signed in, but its message box is not ready to send.`;
    }

    if (inspection.authState === "signed-in-likely" && headless) {
      return `${provider.displayName} appears signed in and ready, but Chrome is headless. Use \`ask login --provider ${provider.name}\` when you need to inspect it.`;
    }

    if (inspection.authState === "signed-in-likely") {
      return `${provider.displayName} appears signed in and ready in the visible ask Chrome session.`;
    }

    if (inspection.readyToSend && headless) {
      return `${provider.displayName} is ready to send, but auth is unknown and Chrome is headless. Run \`ask login --provider ${provider.name}\` to inspect it.`;
    }

    if (inspection.readyToSend) {
      return `${provider.displayName} is ready to send, but auth is unknown. Inspect the visible browser if signed-in behavior matters.`;
    }

    return `${provider.displayName} is open, but no message box was found. Finish login, verification, or refresh the page.`;
  }

  private defaultScreenshotPath(provider: ProviderDefinition): string {
    return path.join(getScreenshotsDir(this.env), `${provider.screenshotPrefix}-${timestampForFile()}.png`);
  }

  private chromeOptions(options: SimpleBrowserOptions = {}): ChromeSessionRequest {
    return {
      headless: options.headless,
      verbose: options.verbose
    };
  }
}
