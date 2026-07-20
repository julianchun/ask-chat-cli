import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import {
  createChromeSessionController,
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
import { timestampForFile } from "./io";
import { getProvider, resolveProviderName, type ProviderDefinition, type ProviderName } from "./providers";
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

export interface BrowserStatus {
  provider: ProviderName;
  providerDisplayName: string;
  port: number;
  connected: boolean;
  sessionOwnership: SessionOwnership;
  headless?: boolean;
  browser?: string;
  userAgent?: string;
  pageCount: number;
  providerPageCount: number;
  currentPageUrl?: string;
  promptInputVisible: boolean;
  authState: AuthState;
  readyToSend: boolean;
  readyForHeadless: boolean;
  loggedInLikely: boolean;
  note: string;
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

  async ask(options: PromptRunOptions): Promise<ResponseResult> {
    const provider = this.resolveProvider(options.provider);
    const lease = await this.executionQueue.acquire({
      provider: provider.name,
      conversationName: options.conversationName,
      exclusiveProvider: options.newSession === false && !options.conversationName,
      headless: options.headless,
      onUpdate: options.onQueueUpdate
    });
    try {
      await this.assertHeadlessAllowedIfNeeded(provider, options);
      const browser = await this.chromeSession.connect({
        ...this.chromeOptions(options),
        requireManaged: true,
        requireVisible: !options.headless,
        url: provider.homeUrl
      });
      try {
        const session = await this.conversations.resolve(browser, provider, {
          requestedUrl: provider.homeUrl,
          newSession: options.newSession,
          conversationName: options.conversationName,
          onContinuationUnavailable: options.onContinuationUnavailable
        });
        const page = await openWorkerPage(browser, provider, session.url);
        try {
          await this.assertSignedInBeforeSend(page, provider, options);
          await provider.automation.attachFiles(page, options.attachments);
          const input = await provider.automation.fillPrompt(page, options.prompt, Math.min(options.timeoutMs, 30_000));
          const baseline = await provider.automation.captureAssistantResponseBaseline(page);
          await provider.automation.submitPrompt(page, input, Math.min(options.timeoutMs, 30_000));
          const result = await provider.automation.waitForAssistantCompletion(page, { timeoutMs: options.timeoutMs, baseline });
          if (result.timedOut) {
            await provider.automation.stopAssistantGeneration(page);
            return result;
          }
          await this.conversations.remember(provider, page, session.conversationName);
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
    const lease = await this.executionQueue.acquire({
      provider: provider.name,
      conversationName: options.conversationName,
      exclusiveProvider: options.newSession === false && !options.conversationName,
      headless: options.headless,
      onUpdate: options.onQueueUpdate
    });
    try {
      await this.assertHeadlessAllowedIfNeeded(provider, options);
      const browser = await this.chromeSession.connect({
        ...this.chromeOptions(options),
        requireManaged: true,
        requireVisible: true,
        url: options.url
      });
      try {
        const session = await this.conversations.resolve(browser, provider, {
          requestedUrl: options.url,
          newSession: options.newSession,
          conversationName: options.conversationName,
          onContinuationUnavailable: options.onContinuationUnavailable
        });
        const page = await openWorkerPage(browser, provider, session.url);
        try {
          await page.bringToFront();
          await this.assertSignedInBeforeSend(page, provider, options);
          await provider.automation.attachFiles(page, options.attachments);
          const input = await provider.automation.fillPrompt(page, options.prompt, Math.min(options.timeoutMs, 30_000));
          const baseline = await provider.automation.captureAssistantResponseBaseline(page);
          await provider.automation.submitPrompt(page, input, Math.min(options.timeoutMs, 30_000));
          const result = await provider.automation.waitForAssistantCompletion(page, { timeoutMs: options.timeoutMs, baseline });
          if (result.timedOut) {
            await provider.automation.stopAssistantGeneration(page);
            throw new Error(`Timed out waiting for ${provider.displayName}; the execution tab was closed.`);
          }
          await this.conversations.remember(provider, page, session.conversationName);
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

  async status(options: SimpleBrowserOptions = {}): Promise<BrowserStatus> {
    const provider = this.resolveProvider(options.provider);
    const session = await this.chromeSession.inspect(this.chromeOptions(options));
    const { port, classification } = session;

    if (!session.connected || classification.ownership === "absent") {
      return this.emptyStatus(provider, port, "absent", `No Chrome debugging session is available on port ${port}. Run \`ask login --provider ${provider.name}\` to open one.`);
    }

    const headless = Boolean(session.headless);

    if (classification.ownership !== "ask-managed") {
      return {
        ...this.emptyStatus(provider, port, classification.ownership, `Chrome debugging is present on port ${port}, but it is not an ask-managed session. ${classification.reason || "The session could not be verified."}`),
        connected: true,
        headless,
        browser: session.browser,
        userAgent: session.userAgent
      };
    }

    const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false });
    try {
      const pages = browser.contexts().flatMap((context) => context.pages());
      const providerPages = pages.filter((page) => provider.matchesPageUrl(page.url()));
      const page = providerPages.at(-1);
      const inspection = page
        ? await provider.automation.inspectPage(page, options.timeoutMs || DEFAULT_STATUS_TIMEOUT_MS)
        : this.emptyInspection();

      return {
        provider: provider.name,
        providerDisplayName: provider.displayName,
        port,
        connected: true,
        sessionOwnership: classification.ownership,
        headless,
        browser: session.browser,
        userAgent: session.userAgent,
        pageCount: pages.length,
        providerPageCount: providerPages.length,
        currentPageUrl: page?.url(),
        promptInputVisible: inspection.promptInputVisible,
        authState: inspection.authState,
        readyToSend: inspection.readyToSend,
        readyForHeadless: inspection.readyForHeadless,
        loggedInLikely: inspection.authState === "signed-in-likely",
        note: this.statusNote(provider, headless, Boolean(page), inspection)
      };
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

    const status = await this.status({ provider: provider.name, timeoutMs: Math.min(options.timeoutMs || DEFAULT_STATUS_TIMEOUT_MS, DEFAULT_STATUS_TIMEOUT_MS) });
    if (
      status.sessionOwnership === "ask-managed" &&
      status.headless &&
      status.providerPageCount === 0
    ) {
      return;
    }
    if (!status.readyForHeadless) {
      throw new Error(
        `${provider.displayName} is not ready for headless use (auth: ${status.authState}, prompt: ${status.promptInputVisible ? "found" : "not found"}). ` +
          `Run \`ask login --provider ${provider.name}\`, then \`ask status --provider ${provider.name}\`.`
      );
    }
  }

  private async acquireBrowserReadLease(options: SimpleBrowserOptions, action: string) {
    const session = await this.chromeSession.inspect(this.chromeOptions(options));
    const headless = options.headless === true ? true : Boolean(session.headless);
    return this.executionQueue.acquireBrowserLease({ headless, action });
  }

  private async assertSignedInBeforeSend(page: Page, provider: ProviderDefinition, options: SimpleBrowserOptions): Promise<void> {
    const inspection = await provider.automation.inspectPage(
      page,
      Math.min(options.timeoutMs || DEFAULT_STATUS_TIMEOUT_MS, DEFAULT_STATUS_TIMEOUT_MS)
    );
    if (inspection.authState === "signed-in-likely" && inspection.promptInputVisible) {
      return;
    }

    throw new Error(
      `${provider.displayName} is not ready to send from a signed-in session (auth: ${inspection.authState}, prompt: ${inspection.promptInputVisible ? "found" : "not found"}). ` +
        `Check the opened ask browser, sign in, then try again. ` +
        `Run \`ask login --provider ${provider.name}\`, then \`ask status --provider ${provider.name}\`.`
    );
  }
  private emptyInspection(): ProviderPageInspection {
    return {
      promptInputVisible: false,
      authState: "unknown",
      readyToSend: false,
      readyForHeadless: false
    };
  }

  private emptyStatus(provider: ProviderDefinition, port: number, ownership: SessionOwnership, note: string): BrowserStatus {
    return {
      provider: provider.name,
      providerDisplayName: provider.displayName,
      port,
      connected: false,
      sessionOwnership: ownership,
      pageCount: 0,
      providerPageCount: 0,
      promptInputVisible: false,
      authState: "unknown",
      readyToSend: false,
      readyForHeadless: false,
      loggedInLikely: false,
      note
    };
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

    return `${provider.displayName} is open, but no prompt input was found. Finish login, verification, or refresh the page.`;
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

