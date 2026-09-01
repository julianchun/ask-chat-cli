import fs from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "playwright-core";
import {
  authenticateChromeProfile,
  createChromeSessionController,
  ChromeSessionConflictError,
  ChromeSessionConfigMismatchError,
  type ChromeAuthenticationOptions,
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
  type ExecutionLease,
  type ExecutionQueue,
  type ExecutionQueueUpdate
} from "./execution-queue";
import {
  AskFailure,
  type AskExecutionStage,
  type AskFailureCode,
  type AskFailureContext,
  type PromptDeliveryState
} from "./errors";
import { timestampForFile } from "./io";
import {
  getProvider,
  PROVIDER_NAMES,
  resolveProviderName,
  type ProviderDefinition,
  type ProviderName
} from "./providers";
import {
  executeProviderPrompt,
  type ProviderCapabilitySnapshot,
  type ProviderExecutionResult
} from "./provider-execution";
import {
  DeliveryAmbiguityPersistenceError,
  recordDeliveryAmbiguity,
  reclaimDeliveryAmbiguityMarkerUnderLock,
  type StoredDeliveryAmbiguityMarker
} from "./delivery-ambiguity";
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
  authenticationBootstrap?: (options: ChromeAuthenticationOptions) => Promise<void>;
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
  /**
   * Kept for API compatibility. Authentication is never handed to a remotely
   * controlled worker; callers receive a safe pre-dispatch failure instead.
   */
  allowInteractiveAuth?: boolean;
  onReadinessUpdate?: (update: ReadinessUpdate) => void;
  timeoutMs: number;
  verbose?: boolean;
}

export type ReadinessPhase =
  | "recovering"
  | "awaiting-auth"
  | "resumed"
  | "submission-uncertain";

export interface ReadinessUpdate {
  phase: ReadinessPhase;
  provider: ProviderName;
  message: string;
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

/**
 * Narrow, read-only answer used by CLI auth-recovery election. It separates
 * an observed authentication failure from an ordinary capability/session
 * issue, so a follower never opens ordinary Chrome merely because readiness
 * inspection was inconclusive.
 */
export type ProviderReadinessCheck =
  | "ready"
  | "auth-required"
  | "auth-unconfirmed"
  | "unavailable";

export type MessageBoxStatus = "available" | "not-found" | "not-checked";

/**
 * The observed placement of the existing Chrome session. This is deliberately
 * separate from launch intent: users can move a headed Chrome window after ask
 * starts it, and status must report what CDP can prove at inspection time.
 */
export type BrowserSessionPlacement = "headless" | "background" | "visible" | "unknown";

export interface BrowserSessionStatus {
  port?: number;
  portPolicy: "automatic" | "pinned";
  connected: boolean;
  sessionOwnership: SessionOwnership;
  headless?: boolean;
  placement: BrowserSessionPlacement;
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
  deliveryState?: PromptDeliveryState;
}

const DEFAULT_STATUS_TIMEOUT_MS = 3_000;

interface PromptExecutionLifecycle {
  deadlineAt: number;
  preserveWorkerPage: boolean;
  recoveryAttempts: number;
  /** Armed before the one irreversible dispatch action; retained on unknown delivery. */
  ambiguityMarker?: StoredDeliveryAmbiguityMarker;
}

interface ChromeWindowBounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  windowState?: string;
}

interface ScreenGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface WindowPlacementInspection {
  windowId?: number;
  placement: Exclude<BrowserSessionPlacement, "headless">;
}

const PARKED_WINDOW_BOUNDS = {
  windowState: "minimized" as const
};

const LEGACY_PARKED_WINDOW_ORIGIN = {
  left: -10_000,
  top: -10_000
};

const VISIBLE_WINDOW_BOUNDS = {
  left: 80,
  top: 80,
  width: 1200,
  height: 800,
  windowState: "normal" as const
};

export class AskApp {
  private readonly env: NodeJS.ProcessEnv;
  private readonly chromeSession: ChromeSessionController;
  private readonly authenticationBootstrap: (options: ChromeAuthenticationOptions) => Promise<void>;
  private readonly conversations: ConversationContinuity;
  private readonly executionQueue: ExecutionQueue;

  constructor(options: AppOptions = {}) {
    this.env = options.env || process.env;
    this.chromeSession = options.chromeSession || createChromeSessionController(this.env);
    this.authenticationBootstrap = options.authenticationBootstrap || authenticateChromeProfile;
    this.conversations = options.conversationContinuity || createConversationContinuity(this.env);
    this.executionQueue = options.executionQueue || createExecutionQueue(this.env);
  }

  async login(options: SimpleBrowserOptions = {}): Promise<void> {
    return this.setup(options);
  }

  /**
   * Serializes a provider's ordinary-Chrome readiness recovery across Ask
   * processes. The CLI holds this lease only while it checks readiness and,
   * when needed, runs setup; prompt execution resumes after release.
   */
  async acquireProviderReadinessLease(provider: ProviderName, timeoutMs: number): Promise<ExecutionLease> {
    return this.executionQueue.acquireProviderReadinessLease(provider, Math.max(0, timeoutMs));
  }

  /**
   * Read-only provider readiness check for the CLI's coalesced first-use
   * recovery. It never launches, foregrounds, or modifies Chrome.
   */
  async inspectProviderReadiness(provider: ProviderName, timeoutMs: number): Promise<ProviderReadinessCheck> {
    const report = await this.status({ provider, timeoutMs });
    const status = report.providers[0];
    if (!status) {
      return "unavailable";
    }
    if (status.status === "ready") {
      return "ready";
    }
    if (status.authState === "guest" || status.authState === "login-required") {
      return "auth-required";
    }
    if (status.authState === "unknown") {
      return "auth-unconfirmed";
    }
    return "unavailable";
  }

  async setup(options: SimpleBrowserOptions = {}): Promise<void> {
    if (options.headless) {
      throw new Error("`ask setup` requires a visible ordinary sign-in browser.");
    }

    const provider = this.resolveProvider(options.provider);
    const timeoutMs = Math.max(0, options.timeoutMs ?? 600_000);
    const deadlineAt = Date.now() + timeoutMs;
    const lease = await this.executionQueue.acquireBrowserLease({
      headless: false,
      exclusive: true,
      waitForIdle: true,
      timeoutMs,
      action: "log in or change the shared Chrome session"
    });
    try {
      await this.authenticationBootstrap({
        env: this.env,
        url: provider.homeUrl,
        deadlineAt,
        verbose: options.verbose
      });
      const browser = await this.chromeSession.connect({
        ...this.chromeOptions(options, "visible"),
        timeoutMs: this.remainingMs(deadlineAt),
        requireManaged: true,
        url: provider.homeUrl
      });
      try {
        await this.showManagedChromeBrowser(browser);
        const page = await openChatPage(browser, provider, provider.homeUrl, {
          timeoutMs: this.remainingMs(deadlineAt)
        });
        try {
          const inspection = await this.waitForSetupReadiness(page, provider, deadlineAt);
          if (this.providerReadiness(inspection) !== "ready") {
            throw new Error(
              `${provider.displayName} is not ready in the Ask profile (auth: ${inspection.authState}, message box: ${inspection.promptInputVisible ? "available" : "not found"}). ` +
                `Run \`ask setup --provider ${provider.name}\` and finish signing in before fully quitting the ordinary Chrome window.`
            );
          }
          await this.parkManagedChromeWindow(page);
        } catch (error) {
          await this.closeManagedChromeBrowser(page);
          throw error;
        }
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
      headless: false,
      action: "open the shared Chrome session in a different mode"
    });
    try {
      const deadlineAt = Date.now() + Math.max(0, options.timeoutMs);
      const browser = await this.connectBrowser(provider, {
        ...this.chromeOptions(options, "visible"),
        timeoutMs: this.remainingMs(deadlineAt),
        requireManaged: true,
        url: options.url
      });
      try {
        await this.showManagedChromeBrowser(browser);
        const session = await this.beforeDeadline(
          deadlineAt,
          () => this.conversations.resolve(browser, provider, {
            requestedUrl: options.url,
            newSession: options.newSession,
            conversationName: options.conversationName,
            onContinuationUnavailable: options.onContinuationUnavailable
          }),
          `${provider.displayName} conversation resolution`
        );
        if (session.conversationName && session.newSession && !options.send) {
          throw new Error(
            `Named conversation \"${session.conversationName}\" does not exist yet. ` +
              "Use `ask open --send --conversation <name> <prompt>` so ask can save the new conversation URL."
          );
        }
        const page = await openChatPage(browser, provider, session.url, {
          newSession: true,
          timeoutMs: this.remainingMs(deadlineAt)
        });
        // Gemini's exactly-once send adapter deliberately fails closed because
        // its upload-completion signal is not yet verifiable. `open` without
        // --send is a manual draft flow, so preserve the legacy attachment
        // upload there instead of applying the send-only safety restriction.
        const useLegacyOpenAttachments = provider.name === "gemini" && options.attachments.length > 0;
        if (provider.execution && !useLegacyOpenAttachments) {
          await this.prepareVerifiedDraft(page, provider, options, deadlineAt);
        } else {
          await this.beforeDeadline(
            deadlineAt,
            () => provider.automation.attachFiles(page, options.attachments),
            `${provider.displayName} attachment preparation`
          );
          if (options.prompt) {
            await this.beforeDeadline(
              deadlineAt,
              () => provider.automation.fillPrompt(
                page,
                options.prompt,
                Math.min(this.remainingMs(deadlineAt), 30_000)
              ),
              `${provider.displayName} draft filling`
            );
          }
        }
        await this.beforeDeadline(
          deadlineAt,
          () => this.conversations.remember(provider, page, session.conversationName),
          `${provider.displayName} conversation persistence`
        );
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
        headless: Boolean(options.headless),
        onUpdate: options.onQueueUpdate
      }),
      "Could not acquire an execution slot.",
      "Wait for another execution to finish, then try again.",
      true,
      undefined,
      true
    );
    try {
      const lifecycle: PromptExecutionLifecycle = {
        deadlineAt: Date.now() + Math.max(0, options.timeoutMs),
        preserveWorkerPage: false,
        recoveryAttempts: 0
      };
      if (!provider.execution) {
        await this.assertHeadlessAllowedIfNeeded(provider, options);
      }
      const browser = await this.connectBrowser(provider, {
        ...this.chromeOptions(
          options,
          options.headless ? "headless" : "preserve",
          !options.headless
        ),
        timeoutMs: this.remainingMs(lifecycle.deadlineAt),
        requireManaged: true,
        url: provider.homeUrl
      });
      try {
        if (!options.headless) {
          await this.parkManagedChromeBrowser(browser);
        }
        const session = await this.runStage(
          provider,
          "conversation.resolve",
          "CONVERSATION_STATE_FAILED",
          () => this.beforeDeadline(
            lifecycle.deadlineAt,
            () => this.conversations.resolve(browser, provider, {
              requestedUrl: provider.homeUrl,
              newSession: options.newSession,
              conversationName: options.conversationName,
              onContinuationUnavailable: options.onContinuationUnavailable
            }),
            `${provider.displayName} conversation resolution`
          ),
          "Could not resolve the requested conversation.",
          `Retry with \`ask --provider ${provider.name} --new <prompt>\`.`,
          true
        );
        const page = await this.runStage(
          provider,
          "page.open",
          "BROWSER_UNAVAILABLE",
          () => openWorkerPage(browser, provider, session.url, {
            timeoutMs: this.remainingMs(lifecycle.deadlineAt),
            background: !options.headless,
            ...(!options.headless ? {
              onPageCreated: (workerPage: Page) => this.parkManagedChromeWindow(workerPage)
            } : {})
          }),
          `Could not open a ${provider.displayName} worker page.`,
          `Run \`ask status --provider ${provider.name} --verbose\`.`,
          true
        );
        try {
          // A newly created worker normally joins an already minimized window,
          // but minimize its target explicitly as well. This also covers Chrome
          // configurations that create a separate window for a new target.
          if (!options.headless) {
            await this.parkManagedChromeWindow(page);
          }
          let result: ResponseResult;
          let confirmedConversationUrl: string | undefined;
          if (provider.execution) {
            const execution = await this.executeCoordinatedPromptOnPage(
              page,
              provider,
              options,
              lifecycle,
              session.conversationName
            );
            if (execution.deliveryState === "unknown") {
              lifecycle.preserveWorkerPage = true;
              const conversationUrl = this.validConversationUrl(provider, execution.conversationUrl);
              this.assertUncertainPromptDeliveryIsArmed(page, provider, lifecycle, conversationUrl);
              if (conversationUrl) {
                this.startBestEffortConversationPersistence(
                  provider,
                  page,
                  session.conversationName
                );
              }
              throw this.deliveryUnknownFailure(
                provider,
                page,
                execution.dispatchStrategy,
                lifecycle.recoveryAttempts,
                conversationUrl
              );
            }
            result = execution.response;
            confirmedConversationUrl = this.validConversationUrl(provider, execution.conversationUrl);
          } else {
            result = await this.executePromptOnPage(
              page,
              provider,
              { ...options, timeoutMs: this.remainingMs(lifecycle.deadlineAt) }
            );
          }
          if (result.timedOut) {
            const conversationUrl =
              this.validConversationUrl(provider, page.url()) || confirmedConversationUrl;
            if (provider.execution && !conversationUrl) {
              lifecycle.preserveWorkerPage = true;
            }
            this.startConfirmedTimeoutCleanup(
              provider,
              page,
              session.conversationName,
              conversationUrl
            );
            return {
              ...result,
              deliveryState: "confirmed",
              ...(conversationUrl ? { conversationUrl } : {}),
              failure: this.responseTimeoutFailure(
                provider,
                page,
                Boolean(result.text),
                "confirmed",
                conversationUrl,
                lifecycle.preserveWorkerPage
              )
            };
          }
          const conversationUrl =
            this.validConversationUrl(provider, page.url()) || confirmedConversationUrl;
          try {
            await this.runStage(
              provider,
              "conversation.save",
              "CONVERSATION_STATE_FAILED",
              () => this.conversations.remember(provider, page, session.conversationName),
              `Received a response, but could not save the ${provider.displayName} conversation state.`,
              "The provider conversation still exists; retry without conversation continuation if needed.",
              false,
              {
                ...this.failureContext(provider, page),
                deliveryState: "confirmed",
                ...(conversationUrl ? { conversationUrl } : {})
              }
            );
          } catch (error) {
            if (provider.execution && !conversationUrl) {
              lifecycle.preserveWorkerPage = true;
            }
            throw error;
          }
          return {
            ...result,
            deliveryState: "confirmed",
            ...(conversationUrl ? { conversationUrl } : {})
          };
        } finally {
          // A response, timeout, or delivery-unknown result must never leave
          // the headed managed session in front of the user. Do this before
          // closing ordinary workers; preserved ambiguity workers stay minimized.
          if (!options.headless) {
            await this.parkManagedChromeWindow(page);
          }
          if (!lifecycle.preserveWorkerPage) {
            await page.close().catch(() => undefined);
          }
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
      const browser = await this.chromeSession.connect({
        ...this.chromeOptions(options, options.headless ? "headless" : "preserve"),
        launchIfNeeded: false,
        requireManaged: true
      });
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
        headless: false,
        onUpdate: options.onQueueUpdate
      }),
      "Could not acquire an execution slot.",
      "Wait for another execution to finish, then try again.",
      true,
      undefined,
      true
    );
    try {
      const lifecycle: PromptExecutionLifecycle = {
        deadlineAt: Date.now() + Math.max(0, options.timeoutMs),
        preserveWorkerPage: false,
        recoveryAttempts: 0
      };
      if (!provider.execution) {
        await this.assertHeadlessAllowedIfNeeded(provider, options);
      }
      const browser = await this.connectBrowser(provider, {
        // Keep an existing managed Chrome mode intact while requesting an
        // background launch for a fresh headed session. This is the same
        // policy as `ask`, including legacy provider execution paths.
        ...this.chromeOptions(options, "preserve", true),
        timeoutMs: this.remainingMs(lifecycle.deadlineAt),
        requireManaged: true,
        url: options.url
      });
      try {
        await this.parkManagedChromeBrowser(browser);
        const session = await this.runStage(
          provider,
          "conversation.resolve",
          "CONVERSATION_STATE_FAILED",
          () => this.beforeDeadline(
            lifecycle.deadlineAt,
            () => this.conversations.resolve(browser, provider, {
              requestedUrl: options.url,
              newSession: options.newSession,
              conversationName: options.conversationName,
              onContinuationUnavailable: options.onContinuationUnavailable
            }),
            `${provider.displayName} conversation resolution`
          ),
          "Could not resolve the requested conversation.",
          `Retry with \`ask open --provider ${provider.name} --new --send <prompt>\`.`,
          true
        );
        const page = await this.runStage(
          provider,
          "page.open",
          "BROWSER_UNAVAILABLE",
          () => openWorkerPage(browser, provider, session.url, {
            timeoutMs: this.remainingMs(lifecycle.deadlineAt),
            background: true,
            onPageCreated: (workerPage: Page) => this.parkManagedChromeWindow(workerPage)
          }),
          `Could not open a ${provider.displayName} worker page.`,
          `Run \`ask status --provider ${provider.name} --verbose\`.`,
          true
        );
        try {
          await this.parkManagedChromeWindow(page);
          let result: ResponseResult;
          let confirmedConversationUrl: string | undefined;
          if (provider.execution) {
            const execution = await this.executeCoordinatedPromptOnPage(
              page,
              provider,
              options,
              lifecycle,
              session.conversationName
            );
            if (execution.deliveryState === "unknown") {
              lifecycle.preserveWorkerPage = true;
              const conversationUrl = this.validConversationUrl(provider, execution.conversationUrl);
              this.assertUncertainPromptDeliveryIsArmed(page, provider, lifecycle, conversationUrl);
              if (conversationUrl) {
                this.startBestEffortConversationPersistence(
                  provider,
                  page,
                  session.conversationName
                );
              }
              throw this.deliveryUnknownFailure(
                provider,
                page,
                execution.dispatchStrategy,
                lifecycle.recoveryAttempts,
                conversationUrl
              );
            }
            result = execution.response;
            confirmedConversationUrl = this.validConversationUrl(provider, execution.conversationUrl);
          } else {
            result = await this.executePromptOnPage(
              page,
              provider,
              { ...options, timeoutMs: this.remainingMs(lifecycle.deadlineAt) }
            );
          }
          if (result.timedOut) {
            const conversationUrl =
              this.validConversationUrl(provider, page.url()) || confirmedConversationUrl;
            if (provider.execution && !conversationUrl) {
              lifecycle.preserveWorkerPage = true;
            }
            this.startConfirmedTimeoutCleanup(
              provider,
              page,
              session.conversationName,
              conversationUrl
            );
            throw this.responseTimeoutFailure(
              provider,
              page,
              Boolean(result.text),
              "confirmed",
              conversationUrl,
              lifecycle.preserveWorkerPage
            );
          }
          const conversationUrl =
            this.validConversationUrl(provider, page.url()) || confirmedConversationUrl;
          try {
            await this.runStage(
              provider,
              "conversation.save",
              "CONVERSATION_STATE_FAILED",
              () => this.conversations.remember(provider, page, session.conversationName),
              `Received a response, but could not save the ${provider.displayName} conversation state.`,
              "The provider conversation still exists; retry without conversation continuation if needed.",
              false,
              {
                ...this.failureContext(provider, page),
                deliveryState: "confirmed",
                ...(conversationUrl ? { conversationUrl } : {})
              }
            );
          } catch (error) {
            if (provider.execution && !conversationUrl) {
              lifecycle.preserveWorkerPage = true;
            }
            throw error;
          }
        } finally {
          await this.parkManagedChromeWindow(page);
          if (!lifecycle.preserveWorkerPage) {
            await page.close().catch(() => undefined);
          }
        }
      } finally {
        await browser.close();
      }
    } finally {
      await lease.release();
    }
  }

  private async executeCoordinatedPromptOnPage(
    page: Page,
    provider: ProviderDefinition,
    options: PromptRunOptions,
    lifecycle: PromptExecutionLifecycle,
    conversationName?: string
  ): Promise<ProviderExecutionResult> {
    const adapter = provider.execution;
    if (!adapter) {
      throw new Error(`${provider.displayName} does not have a coordinated execution adapter.`);
    }

    const timeoutMs = this.remainingMs(lifecycle.deadlineAt);
    if (timeoutMs <= 0) {
      throw this.failure(
        provider,
        lifecycle.recoveryAttempts > 0 ? "readiness.recover" : "readiness.discover",
        "BROWSER_UNAVAILABLE",
        `The command deadline expired before ${provider.displayName} became ready.`,
        "Retry with a larger --timeout.",
        true,
        {
          providerHost: this.pageHost(page) || this.providerHost(provider),
          deliveryState: "not-attempted"
        }
      );
    }

    try {
      const execution = await executeProviderPrompt(page, adapter, {
        prompt: options.prompt,
        attachments: options.attachments,
        timeoutMs,
        // Never hand authentication to a remotely controlled worker tab.
        // The CLI may run the ordinary-Chrome setup bootstrap after an
        // explicit pre-dispatch auth failure; direct callers fail safely.
        onPreSubmitRecovery: () => {
          lifecycle.recoveryAttempts += 1;
          this.emitReadiness(
            options,
            provider,
            "recovering",
            `${provider.displayName} was not ready; recovering the page once.`
          );
        },
        onBeforeDispatch: async () => {
          await this.armUncertainPromptDelivery(page, provider, lifecycle);
        },
        onSubmissionUncertain: () => {
          this.emitReadiness(
            options,
            provider,
            "submission-uncertain",
            `${provider.displayName} submission is uncertain; observing without sending again.`
          );
        },
        onDeliveryConfirmed: async () => {
          await this.reclaimConfirmedPromptDelivery(lifecycle);
        },
        onSubmissionConfirmed: async (conversationUrl) => {
          const confirmedUrl = this.validConversationUrl(provider, conversationUrl) ||
            this.validConversationUrl(provider, page.url());
          const save = this.rememberFirstConfirmedConversationUrl(
              provider,
              page,
              conversationName,
              lifecycle.deadlineAt,
              confirmedUrl
            );
          // A short, deadline-bounded navigation grace handles ChatGPT adding
          // the user turn just before its SPA assigns `/c/...`. The coordinator
          // can then begin response observation with the URL already persisted.
          await save;
        }
      });
      return execution;
    } catch (error) {
      const deliveryWasConfirmed = error instanceof AskFailure &&
        error.context?.deliveryState === "confirmed";
      const deliveryWasUnknown = error instanceof AskFailure &&
        error.context?.deliveryState === "unknown";
      if (deliveryWasUnknown) {
        lifecycle.preserveWorkerPage = true;
        const conversationUrl = this.validConversationUrl(provider, page.url()) ||
          this.validConversationUrl(provider, error.context?.conversationUrl);
        this.assertUncertainPromptDeliveryIsArmed(page, provider, lifecycle, conversationUrl);
        if (conversationUrl) {
          this.startBestEffortConversationPersistence(provider, page, conversationName);
        }
        throw this.deliveryUnknownFailure(
          provider,
          page,
          error.context?.capability || "unknown-dispatch",
          lifecycle.recoveryAttempts,
          conversationUrl
        );
      }
      const confirmedConversationUrl = deliveryWasConfirmed
        ? this.validConversationUrl(provider, page.url()) ||
          this.validConversationUrl(provider, error.context.conversationUrl)
        : undefined;
      if (confirmedConversationUrl) {
        this.startBestEffortConversationPersistence(provider, page, conversationName);
      } else if (deliveryWasConfirmed) {
        lifecycle.preserveWorkerPage = true;
      }
      const context: AskFailureContext = {
        providerHost: this.pageHost(page) || this.providerHost(provider),
        deliveryState: error instanceof AskFailure
          ? error.context?.deliveryState || "not-attempted"
          : "not-attempted",
        recoveryAttempts: lifecycle.recoveryAttempts,
        ...(confirmedConversationUrl ? { conversationUrl: confirmedConversationUrl } : {})
      };
      if (error instanceof AskFailure) {
        throw this.mergeFailureContext(error, context);
      }
      throw this.failure(
        provider,
        lifecycle.recoveryAttempts > 0 ? "readiness.recover" : "readiness.discover",
        "BROWSER_UNAVAILABLE",
        `Could not inspect or prepare the ${provider.displayName} page.`,
        `Run \`ask status --provider ${provider.name} --verbose\`.`,
        true,
        context,
        error,
        1,
        this.safeErrorDetail(error)
      );
    }
  }

  /**
   * Pre-arm a durable marker immediately before the one dispatch permit is
   * consumed. A process crash between this return and click is conservative;
   * a crash after click cannot lose the marker. No prompt, DOM, cookie, or
   * account information crosses this boundary.
   */
  private async armUncertainPromptDelivery(
    page: Page,
    provider: ProviderDefinition,
    lifecycle: PromptExecutionLifecycle
  ): Promise<void> {
    if (lifecycle.ambiguityMarker) {
      return;
    }
    try {
      const knownConversationUrl = this.validConversationUrl(provider, page.url());
      lifecycle.ambiguityMarker = await recordDeliveryAmbiguity({
        env: this.env,
        provider: provider.name,
        ...(knownConversationUrl ? { knownConversationUrl } : {}),
        deadlineAt: lifecycle.deadlineAt,
        resolveTargetId: () => this.cdpTargetIdForPage(page, lifecycle.deadlineAt),
        resolveSessionGeneration: () => this.currentManagedSessionGeneration(lifecycle.deadlineAt)
      });
    } catch (error) {
      // A marker write failure happens before dispatch, but retain the opened
      // worker tab anyway: a late atomic rename may still complete and must
      // never be hidden by cleanup.
      lifecycle.preserveWorkerPage = true;
      const safeMessage = error instanceof DeliveryAmbiguityPersistenceError
        ? "Ask could not safely record the uncertain prompt delivery."
        : "Ask could not safely protect the uncertain prompt delivery.";
      throw this.failure(
        provider,
        "prompt.confirm",
        "BROWSER_UNAVAILABLE",
        safeMessage,
        `Do not resend the prompt. Inspect the preserved ${provider.displayName} tab, keep Ask Chrome open, then close that tab yourself once you have resolved delivery.`,
        false,
        {
          ...this.failureContext(provider, page),
          deliveryState: "not-attempted"
        },
        error,
        1
      );
    }
  }

  private assertUncertainPromptDeliveryIsArmed(
    page: Page,
    provider: ProviderDefinition,
    lifecycle: PromptExecutionLifecycle,
    conversationUrl?: string
  ): void {
    if (lifecycle.ambiguityMarker) {
      return;
    }
    lifecycle.preserveWorkerPage = true;
    throw this.failure(
      provider,
      "prompt.confirm",
      "BROWSER_UNAVAILABLE",
      "Ask could not verify that the uncertain prompt-delivery marker was armed before dispatch.",
      `Do not resend the prompt. Inspect the preserved ${provider.displayName} tab and keep Ask Chrome open until delivery is resolved.`,
      false,
      {
        ...this.failureContext(provider, page),
        deliveryState: "unknown",
        ...(conversationUrl ? { conversationUrl } : {})
      }
    );
  }

  private async reclaimConfirmedPromptDelivery(lifecycle: PromptExecutionLifecycle): Promise<void> {
    const marker = lifecycle.ambiguityMarker;
    if (!marker) {
      return;
    }
    // Serialize reclamation with Browser.close. If it loses its deadline or
    // encounters I/O trouble, the coordinator contains the error and leaves
    // the conservative record in place for a later guarded retry.
    await reclaimDeliveryAmbiguityMarkerUnderLock(this.env, marker, { deadlineAt: lifecycle.deadlineAt });
    lifecycle.ambiguityMarker = undefined;
  }

  private async cdpTargetIdForPage(page: Page, deadlineAt: number): Promise<string> {
    return this.beforeDeadline(deadlineAt, async () => {
      let session: CDPSession | undefined;
      try {
        session = await page.context().newCDPSession(page);
        const response = await session.send("Target.getTargetInfo") as {
          targetInfo?: { targetId?: unknown };
        };
        const targetId = response.targetInfo?.targetId;
        if (typeof targetId === "string" && targetId) {
          return targetId;
        }
        // Playwright does not expose a public CDP target id. Browser.getWindowForTarget
        // is supported by the same page-scoped session and yields a stable target id on
        // Chromium builds where Target.getTargetInfo is unavailable.
        const window = await session.send("Browser.getWindowForTarget") as { targetId?: unknown };
        if (typeof window.targetId === "string" && window.targetId) {
          return window.targetId;
        }
        throw new Error("Chrome did not report a target id for the preserved worker tab.");
      } finally {
        await session?.detach().catch(() => undefined);
      }
    }, "Chrome target identification for the uncertain prompt");
  }

  private async currentManagedSessionGeneration(deadlineAt: number): Promise<string> {
    const inspection = await this.beforeDeadline(
      deadlineAt,
      () => this.chromeSession.inspect({
        desiredMode: "preserve",
        timeoutMs: this.remainingMs(deadlineAt),
        requireManaged: true
      }),
      "managed Chrome generation inspection"
    );
    const generation = inspection.managedSession?.generation || inspection.classification.state?.generation;
    if (
      !inspection.connected ||
      inspection.classification.ownership !== "ask-managed" ||
      typeof generation !== "string" ||
      !generation
    ) {
      throw new Error("The live Ask Chrome session generation could not be verified.");
    }
    return generation;
  }

  private async prepareVerifiedDraft(
    page: Page,
    provider: ProviderDefinition,
    options: PromptRunOptions,
    deadlineAt: number
  ): Promise<void> {
    const adapter = provider.execution;
    if (!adapter) {
      return;
    }

    let recoveryAttempts = 0;
    while (true) {
      try {
        if (this.remainingMs(deadlineAt) <= 0) {
          throw this.failure(
            provider,
            "readiness.discover",
            "BROWSER_UNAVAILABLE",
            `The command deadline expired before ${provider.displayName} became ready.`,
            "Retry with a larger --timeout.",
            true,
            {
              providerHost: this.pageHost(page) || this.providerHost(provider),
              deliveryState: "not-attempted",
              recoveryAttempts
            }
          );
        }
        await this.beforeDeadline(
          deadlineAt,
          () => adapter.discoverCapabilities(page),
          `${provider.displayName} capability discovery`
        );
        await this.beforeDeadline(
          deadlineAt,
          () => adapter.attachAndVerify(page, options.attachments, deadlineAt),
          `${provider.displayName} attachment verification`
        );
        if (options.prompt) {
          await this.beforeDeadline(
            deadlineAt,
            () => adapter.fillAndVerifyDraft(page, options.prompt, deadlineAt),
            `${provider.displayName} draft verification`
          );
        }
        return;
      } catch (error) {
        const retryable = !(error instanceof AskFailure) || error.retryable;
        if (
          recoveryAttempts >= 1 ||
          !retryable ||
          !adapter.recoverBeforeSubmit ||
          this.remainingMs(deadlineAt) <= 0
        ) {
          if (error instanceof AskFailure) {
            throw this.mergeFailureContext(error, {
              providerHost: this.pageHost(page) || this.providerHost(provider),
              deliveryState: "not-attempted",
              recoveryAttempts
            });
          }
          throw this.failure(
            provider,
            recoveryAttempts > 0 ? "readiness.recover" : "readiness.discover",
            "BROWSER_UNAVAILABLE",
            `Could not prepare the ${provider.displayName} draft.`,
            `Run \`ask status --provider ${provider.name} --verbose\`.`,
            true,
            {
              providerHost: this.pageHost(page) || this.providerHost(provider),
              deliveryState: "not-attempted",
              recoveryAttempts
            },
            error,
            1,
            this.safeErrorDetail(error)
          );
        }

        recoveryAttempts += 1;
        this.emitReadiness(
          options,
          provider,
          "recovering",
          `${provider.displayName} was not ready; recovering the page once.`
        );
        try {
          await this.beforeDeadline(
            deadlineAt,
            () => adapter.recoverBeforeSubmit!(page, error, deadlineAt),
            `${provider.displayName} pre-submit recovery`
          );
        } catch (recoveryError) {
          if (recoveryError instanceof AskFailure) {
            throw this.mergeFailureContext(recoveryError, {
              providerHost: this.pageHost(page) || this.providerHost(provider),
              deliveryState: "not-attempted",
              recoveryAttempts
            });
          }
          throw this.failure(
            provider,
            "readiness.recover",
            "BROWSER_UNAVAILABLE",
            `Could not recover the ${provider.displayName} page.`,
            `Run \`ask status --provider ${provider.name} --verbose\`.`,
            true,
            {
              providerHost: this.pageHost(page) || this.providerHost(provider),
              deliveryState: "not-attempted",
              recoveryAttempts
            },
            recoveryError,
            1,
            this.safeErrorDetail(recoveryError)
          );
        }
      }
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
    return result;
  }

  async dump(options: SimpleBrowserOptions = {}): Promise<string> {
    const provider = this.resolveProvider(options.provider);
    const lease = await this.acquireBrowserReadLease(options, "read from the shared Chrome session");
    try {
      const browser = await this.chromeSession.connect({
        ...this.chromeOptions(options, options.headless ? "headless" : "preserve"),
        launchIfNeeded: false,
        requireManaged: true
      });
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
      const browser = await this.chromeSession.connect({
        ...this.chromeOptions(options, options.headless ? "headless" : "preserve"),
        launchIfNeeded: false,
        requireManaged: true
      });
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
    const deadlineAt = Date.now() + Math.max(0, options.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS);
    const providers = options.provider
      ? [this.resolveProvider(options.provider)]
      : PROVIDER_NAMES.map((providerName) => getProvider(providerName));
    const inspectedSession = await this.beforeDeadline(
      deadlineAt,
      () => this.chromeSession.inspect(this.chromeOptions({
        ...options,
        timeoutMs: this.remainingMs(deadlineAt)
      }, "preserve")),
      "Chrome session inspection"
    );
    const { port, classification } = inspectedSession;
    const initialSession: BrowserSessionStatus = {
      port,
      portPolicy: inspectedSession.portPolicy ||
        (this.env.ASK_REMOTE_DEBUGGING_PORT ? "pinned" : "automatic"),
      connected: inspectedSession.connected,
      sessionOwnership: classification.ownership,
      headless: inspectedSession.headless,
      placement: inspectedSession.headless ? "headless" : "unknown",
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
            port === undefined
              ? `No automatic Chrome debugging session exists yet. Run \`ask --provider ${provider.name} <prompt>\` to start one, or use \`ask login --provider ${provider.name}\` optionally.`
              : `No Chrome debugging session is available on port ${port}. Run \`ask --provider ${provider.name} <prompt>\` to recover it automatically.`
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

    const browser = await this.beforeDeadline(
      deadlineAt,
      () => this.chromeSession.connect({
        ...this.chromeOptions({
          ...options,
          timeoutMs: this.remainingMs(deadlineAt)
        }, "preserve"),
        launchIfNeeded: false
      }),
      "Chrome status connection"
    );
    try {
      const pages = browser.contexts().flatMap((context) => context.pages());
      const session: BrowserSessionStatus = {
        ...initialSession,
        connected: true,
        pageCount: pages.length,
        placement: await this.inspectBrowserPlacement(
          pages,
          Boolean(inspectedSession.headless),
          deadlineAt
        )
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

          const inspection = provider.execution
            ? this.capabilityInspection(await this.beforeDeadline(
                deadlineAt,
                () => provider.execution!.discoverCapabilities(page),
                `${provider.displayName} capability discovery`
              ))
            : await this.beforeDeadline(
                deadlineAt,
                () => provider.automation.inspectPage(
                  page,
                  Math.max(1, this.remainingMs(deadlineAt))
                ),
                `${provider.displayName} page inspection`
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
            note: this.statusNote(provider, session.placement, true, inspection)
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
    const session = await this.chromeSession.inspect(
      this.chromeOptions(options, options.headless ? "headless" : "preserve")
    );
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

  private capabilityInspection(capabilities: ProviderCapabilitySnapshot): ProviderPageInspection {
    const readyToSend =
      this.hasStrongProviderAuth(capabilities) &&
      capabilities.prompt.available &&
      capabilities.response.available &&
      (capabilities.clickDispatch.available || capabilities.enterDispatch.available);
    return {
      promptInputVisible: capabilities.prompt.available,
      authState: capabilities.auth.state,
      readyToSend,
      readyForHeadless: readyToSend
    };
  }

  private hasStrongProviderAuth(capabilities: ProviderCapabilitySnapshot): boolean {
    return capabilities.auth.state === "signed-in-likely" &&
      capabilities.auth.confidence === "strong";
  }

  private async connectBrowser(provider: ProviderDefinition, options: ChromeSessionRequest) {
    try {
      return await this.chromeSession.connect(options);
    } catch (error) {
      const conflict = error instanceof ChromeSessionConflictError;
      const configMismatch = error instanceof ChromeSessionConfigMismatchError;
      throw this.failure(
        provider,
        "browser.connect",
        configMismatch
          ? "SESSION_CONFIG_MISMATCH"
          : conflict ? "SESSION_CONFLICT" : "BROWSER_UNAVAILABLE",
        configMismatch
          ? "The requested Chrome port conflicts with the live ask-managed session."
          : conflict
            ? "The Chrome debugging session is not managed by ask."
            : "Could not start or connect to the ask-managed Chrome session.",
        configMismatch
          ? "Use the live ask session's port, close it explicitly, or unset ASK_REMOTE_DEBUGGING_PORT."
          : conflict
            ? "Run `ask status --verbose`, or configure a separate ASK_HOME and ASK_REMOTE_DEBUGGING_PORT."
            : `Retry the command; use \`ask login --provider ${provider.name}\` only when you want to inspect authentication.`,
        !conflict && !configMismatch,
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
    hasPartialResponse: boolean,
    deliveryState: PromptDeliveryState,
    conversationUrl?: string,
    workerPagePreserved = false
  ): AskFailure {
    return this.failure(
      provider,
      "response.wait",
      hasPartialResponse ? "RESPONSE_TIMEOUT" : "RESPONSE_NOT_DETECTED",
      hasPartialResponse
        ? `Timed out waiting for ${provider.displayName}; returned the latest partial response.`
        : `Timed out without detecting a ${provider.displayName} response.`,
      deliveryState === "confirmed"
        ? workerPagePreserved
          ? `Prompt delivery was confirmed; do not resend it. Inspect the preserved ${provider.displayName} tab, or run \`ask get --provider ${provider.name}\`.`
          : `Prompt delivery was confirmed; do not resend it. Reopen or continue the saved conversation, or run \`ask get --provider ${provider.name}\`.`
        : `Retry with a larger \`--timeout\`, or run \`ask status --provider ${provider.name} --verbose\`.`,
      deliveryState !== "confirmed",
      {
        ...this.failureContext(provider, page),
        deliveryState,
        ...(conversationUrl ? { conversationUrl } : {})
      },
      undefined,
      2
    );
  }

  private deliveryUnknownFailure(
    provider: ProviderDefinition,
    page: Page,
    dispatchStrategy: string,
    recoveryAttempts: number,
    conversationUrl?: string
  ): AskFailure {
    return this.failure(
      provider,
      "prompt.confirm",
      "PROMPT_DELIVERY_UNKNOWN",
      `${provider.displayName} may have received the prompt, but delivery could not be confirmed safely.`,
      `Do not resend automatically. Inspect the preserved ${provider.displayName} tab${conversationUrl ? " or reopen the reported conversation" : ""}, then close that tab yourself once delivery is resolved. Use \`ask get --provider ${provider.name}\` if needed.`,
      false,
      {
        ...this.failureContext(provider, page),
        deliveryState: "unknown",
        recoveryAttempts,
        capability: dispatchStrategy,
        ...(conversationUrl ? { conversationUrl } : {})
      }
    );
  }

  private mergeFailureContext(error: AskFailure, context: AskFailureContext): AskFailure {
    return new AskFailure({
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

  private validConversationUrl(
    provider: ProviderDefinition,
    value: string | undefined
  ): string | undefined {
    return provider.matchesConversationUrl(value) ? value : undefined;
  }

  private async rememberFirstConfirmedConversationUrl(
    provider: ProviderDefinition,
    page: Page,
    conversationName: string | undefined,
    commandDeadlineAt: number,
    initialUrl?: string
  ): Promise<string | undefined> {
    let conversationUrl = this.validConversationUrl(provider, initialUrl) ||
      this.validConversationUrl(provider, page.url());
    if (!conversationUrl) {
      const timeoutMs = Math.min(250, this.remainingMs(commandDeadlineAt));
      if (timeoutMs <= 0) {
        return undefined;
      }
      try {
        await page.waitForURL(
          (url) => Boolean(this.validConversationUrl(provider, url.toString())),
          { timeout: timeoutMs }
        );
      } catch {
        return undefined;
      }
      conversationUrl = this.validConversationUrl(provider, page.url());
    }
    if (conversationUrl) {
      await this.conversations.remember(provider, page, conversationName);
    }
    return conversationUrl;
  }

  private startConfirmedTimeoutCleanup(
    provider: ProviderDefinition,
    page: Page,
    conversationName: string | undefined,
    conversationUrl: string | undefined
  ): void {
    try {
      void provider.automation.stopAssistantGeneration(page).catch(() => undefined);
    } catch {
      // Generation stopping is best effort after the shared command deadline.
    }
    if (!conversationUrl) {
      return;
    }
    this.startBestEffortConversationPersistence(provider, page, conversationName);
  }

  private startBestEffortConversationPersistence(
    provider: ProviderDefinition,
    page: Page,
    conversationName?: string
  ): void {
    try {
      // Start the write while the page URL is still available, but never let
      // persistence delay a deadline or ambiguity result.
      void this.conversations.remember(provider, page, conversationName).catch(() => undefined);
    } catch {
      // Conversation persistence is best effort after the shared command deadline.
    }
  }

  private remainingMs(deadlineAt: number): number {
    return Math.max(0, deadlineAt - Date.now());
  }

  private async waitForSetupReadiness(
    page: Page,
    provider: ProviderDefinition,
    deadlineAt: number
  ): Promise<ProviderPageInspection> {
    const verificationDeadlineAt = Math.min(deadlineAt, Date.now() + 15_000);
    let inspection: ProviderPageInspection = {
      promptInputVisible: false,
      authState: "unknown",
      readyToSend: false,
      readyForHeadless: false
    };
    while (this.remainingMs(verificationDeadlineAt) > 0) {
      inspection = provider.execution
        ? this.capabilityInspection(await this.beforeDeadline(
            verificationDeadlineAt,
            () => provider.execution!.discoverCapabilities(page),
            `${provider.displayName} setup verification`
          ))
        : await this.beforeDeadline(
            verificationDeadlineAt,
            () => provider.automation.inspectPage(page, this.remainingMs(verificationDeadlineAt)),
            `${provider.displayName} setup verification`
          );
      if (
        this.providerReadiness(inspection) === "ready" ||
        inspection.authState === "guest" ||
        inspection.authState === "login-required" ||
        inspection.authState === "blocked"
      ) {
        return inspection;
      }
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(250, this.remainingMs(verificationDeadlineAt))
      ));
    }
    return inspection;
  }

  /**
   * Inspect headed-window placement without changing it. The launch `background`
   * flag is intentionally not consulted here: a user may have moved a reused
   * session since it was launched.
   */
  private async inspectBrowserPlacement(
    pages: readonly Page[],
    headless: boolean,
    deadlineAt: number
  ): Promise<BrowserSessionPlacement> {
    if (headless) {
      return "headless";
    }
    if (pages.length === 0) {
      return "unknown";
    }

    const inspectedWindowIds = new Set<number>();
    let hasVisibleWindow = false;
    let hasBackgroundWindow = false;
    let hasIncompleteWindow = false;
    // Never spend an entire status deadline trying to determine placement.
    // Provider readiness remains more useful than a best-effort visual detail.
    const placementDeadlineAt = Math.min(deadlineAt, Date.now() + 500);

    for (const page of pages) {
      const inspection = await this.inspectWindowPlacement(page, placementDeadlineAt);
      if (inspection.windowId !== undefined && inspectedWindowIds.has(inspection.windowId)) {
        continue;
      }
      if (inspection.windowId !== undefined) {
        inspectedWindowIds.add(inspection.windowId);
      }

      if (inspection.placement === "visible") {
        // A single confirmed visible window wins over background or incomplete
        // targets, but keep inspecting the remaining current windows.
        hasVisibleWindow = true;
      } else if (inspection.placement === "background") {
        hasBackgroundWindow = true;
      } else {
        hasIncompleteWindow = true;
      }
    }

    if (hasVisibleWindow) {
      return "visible";
    }
    return hasBackgroundWindow && !hasIncompleteWindow ? "background" : "unknown";
  }

  private async inspectWindowPlacement(
    page: Page,
    deadlineAt: number
  ): Promise<WindowPlacementInspection> {
    let session: CDPSession | undefined;
    try {
      session = await this.beforeDeadline(
        deadlineAt,
        () => page.context().newCDPSession(page),
        "Chrome window placement session"
      );
      const target = await this.beforeDeadline(
        deadlineAt,
        () => session!.send("Browser.getWindowForTarget"),
        "Chrome window placement target lookup"
      ) as { windowId?: unknown };
      if (typeof target.windowId !== "number") {
        return { placement: "unknown" };
      }
      const result = await this.beforeDeadline(
        deadlineAt,
        () => session!.send("Browser.getWindowBounds", { windowId: target.windowId as number }),
        "Chrome window bounds lookup"
      ) as { bounds?: unknown };
      return {
        windowId: target.windowId,
        placement: await this.classifyWindowPlacement(page, result.bounds, deadlineAt)
      };
    } catch {
      return { placement: "unknown" };
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  private async classifyWindowPlacement(
    page: Page,
    rawBounds: unknown,
    deadlineAt: number
  ): Promise<Exclude<BrowserSessionPlacement, "headless">> {
    const bounds = this.parseChromeWindowBounds(rawBounds);
    if (!bounds) {
      return "unknown";
    }

    const state = bounds.windowState?.toLowerCase();
    if (state === "minimized") {
      return "background";
    }
    if (state === "maximized" || state === "fullscreen") {
      return "visible";
    }
    if (state !== "normal" || !this.hasUsableWindowRectangle(bounds)) {
      return "unknown";
    }

    // Chrome can clamp an off-screen placement by a pixel or two, so recognize
    // the distinctive range used by Ask even when screen geometry is absent.
    if (this.isKnownParkedWindow(bounds)) {
      return "background";
    }

    const screen = await this.readScreenGeometry(page, deadlineAt);
    if (!screen) {
      return "unknown";
    }

    return this.rectanglesIntersect(bounds, screen) ? "visible" : "background";
  }

  private parseChromeWindowBounds(value: unknown): ChromeWindowBounds | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const candidate = value as Record<string, unknown>;
    return {
      ...(typeof candidate.left === "number" ? { left: candidate.left } : {}),
      ...(typeof candidate.top === "number" ? { top: candidate.top } : {}),
      ...(typeof candidate.width === "number" ? { width: candidate.width } : {}),
      ...(typeof candidate.height === "number" ? { height: candidate.height } : {}),
      ...(typeof candidate.windowState === "string" ? { windowState: candidate.windowState } : {})
    };
  }

  private hasUsableWindowRectangle(bounds: ChromeWindowBounds): bounds is Required<
    Pick<ChromeWindowBounds, "left" | "top" | "width" | "height">
  > & ChromeWindowBounds {
    return Number.isFinite(bounds.left) &&
      Number.isFinite(bounds.top) &&
      Number.isFinite(bounds.width) &&
      Number.isFinite(bounds.height) &&
      (bounds.width || 0) > 0 &&
      (bounds.height || 0) > 0;
  }

  private isKnownParkedWindow(bounds: Required<
    Pick<ChromeWindowBounds, "left" | "top" | "width" | "height">
  >): boolean {
    return bounds.left <= LEGACY_PARKED_WINDOW_ORIGIN.left + 1_000 &&
      bounds.top <= LEGACY_PARKED_WINDOW_ORIGIN.top + 1_000;
  }

  private async readScreenGeometry(page: Page, deadlineAt: number): Promise<ScreenGeometry | undefined> {
    try {
      const geometry = await this.beforeDeadline(
        deadlineAt,
        () => page.evaluate(() => {
          const currentScreen = window.screen as Screen & {
            availLeft?: number;
            availTop?: number;
            left?: number;
            top?: number;
          };
          return {
            left: currentScreen.availLeft ?? currentScreen.left,
            top: currentScreen.availTop ?? currentScreen.top,
            width: currentScreen.availWidth,
            height: currentScreen.availHeight
          };
        }),
        "screen geometry lookup"
      );
      if (!geometry || typeof geometry !== "object") {
        return undefined;
      }
      const candidate = geometry as Record<string, unknown>;
      const values = [candidate.left, candidate.top, candidate.width, candidate.height];
      if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
        return undefined;
      }
      if ((candidate.width as number) <= 0 || (candidate.height as number) <= 0) {
        return undefined;
      }
      return {
        left: candidate.left as number,
        top: candidate.top as number,
        width: candidate.width as number,
        height: candidate.height as number
      };
    } catch {
      return undefined;
    }
  }

  private rectanglesIntersect(
    windowBounds: Required<Pick<ChromeWindowBounds, "left" | "top" | "width" | "height">>,
    screen: ScreenGeometry
  ): boolean {
    return windowBounds.left < screen.left + screen.width &&
      windowBounds.left + windowBounds.width > screen.left &&
      windowBounds.top < screen.top + screen.height &&
      windowBounds.top + windowBounds.height > screen.top;
  }

  private async parkManagedChromeBrowser(browser: Awaited<ReturnType<ChromeSessionController["connect"]>>): Promise<void> {
    // A reused session can have more than one headed Chrome window. Move every
    // page target rather than assuming the first target owns the only window;
    // duplicate window ids are harmless and the CDP operation is best effort.
    const pages = browser.contexts().flatMap((context) => context.pages());
    await Promise.all(pages.map((page) => this.parkManagedChromeWindow(page)));
  }

  private async showManagedChromeBrowser(browser: Awaited<ReturnType<ChromeSessionController["connect"]>>): Promise<void> {
    const pages = browser.contexts().flatMap((context) => context.pages());
    await Promise.all(pages.map((page) => this.setManagedChromeWindowBounds(page, VISIBLE_WINDOW_BOUNDS)));
  }

  private async parkManagedChromeWindow(page: Page): Promise<void> {
    await this.setManagedChromeWindowBounds(page, PARKED_WINDOW_BOUNDS);
  }

  private async setManagedChromeWindowBounds(
    page: Page,
    bounds:
      | { windowState: "minimized" }
      | {
          left: number;
          top: number;
          width: number;
          height: number;
          windowState: "normal";
        }
  ): Promise<void> {
    let session: CDPSession | undefined;
    try {
      session = await page.context().newCDPSession(page);
      const result = await session.send("Browser.getWindowForTarget") as { windowId?: number };
      if (typeof result.windowId === "number") {
        await session.send("Browser.setWindowBounds", {
          windowId: result.windowId,
          bounds
        });
      }
    } catch {
      // Window placement is a best-effort UX improvement. The CDP method is
      // experimental and unavailable in some Chrome/platform combinations.
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  private async closeManagedChromeBrowser(_page: Page): Promise<void> {
    try {
      // The session controller owns lifecycle verification and the persistent
      // uncertain-delivery guard. App code must not issue Browser.close from a
      // page CDP session because that would bypass the cross-process lock.
      await this.chromeSession.close({ desiredMode: "preserve" });
    } catch (error) {
      if (error instanceof ChromeSessionConflictError) {
        // A live uncertain-delivery marker is actionable: do not replace it
        // with the unrelated setup-readiness error that triggered cleanup.
        throw error;
      }
      // Setup already has a useful readiness error. Failure to close the
      // verified managed browser must not hide it; the next setup attempt will
      // close an owned session before reopening the ordinary login window.
    }
  }

  private async beforeDeadline<T>(
    deadlineAt: number,
    operation: () => Promise<T>,
    description: string
  ): Promise<T> {
    const timeoutMs = this.remainingMs(deadlineAt);
    if (timeoutMs <= 0) {
      throw new Error(`The command deadline expired before ${description}.`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`The command deadline expired during ${description}.`)),
            timeoutMs
          );
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private emitReadiness(
    options: Pick<PromptRunOptions, "onReadinessUpdate">,
    provider: ProviderDefinition,
    phase: ReadinessPhase,
    message: string
  ): void {
    try {
      options.onReadinessUpdate?.({ phase, provider: provider.name, message });
    } catch {
      // Progress rendering cannot change provider execution semantics.
    }
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

  private statusNote(
    provider: ProviderDefinition,
    placement: BrowserSessionPlacement,
    hasProviderPage: boolean,
    inspection: ProviderPageInspection
  ): string {
    if (!hasProviderPage) {
      return `No ${provider.displayName} page is open in the ask-managed Chrome session.`;
    }

    if (inspection.authState === "blocked") {
      return `${provider.displayName} appears blocked by verification, limits, or an error page. Complete verification with \`ask setup --provider ${provider.name}\`, then retry.`;
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

    if (inspection.authState === "signed-in-likely" && placement === "headless") {
      return `${provider.displayName} appears signed in and ready, but Chrome is headless. Use \`ask login --provider ${provider.name}\` when you need to inspect it.`;
    }

    if (inspection.authState === "signed-in-likely") {
      const location = placement === "background"
        ? "in the background ask Chrome session"
        : placement === "visible"
        ? "in the visible ask Chrome session"
        : "but Chrome window placement could not be determined";
      return `${provider.displayName} appears signed in and ready ${location}.`;
    }

    if (inspection.readyToSend && placement === "headless") {
      return `${provider.displayName} is ready to send, but auth is unknown and Chrome is headless. Run \`ask login --provider ${provider.name}\` to inspect it.`;
    }

    if (inspection.readyToSend) {
      return `${provider.displayName} is ready to send, but auth is unknown. Inspect the Ask Chrome session if signed-in behavior matters.`;
    }

    if (inspection.promptInputVisible) {
      return `${provider.displayName} has a message box, but signed-in readiness could not be confirmed. Finish login or verification with \`ask setup --provider ${provider.name}\`.`;
    }

    return `${provider.displayName} is open, but no message box was found. Finish login, verification, or refresh the page.`;
  }

  private defaultScreenshotPath(provider: ProviderDefinition): string {
    return path.join(getScreenshotsDir(this.env), `${provider.screenshotPrefix}-${timestampForFile()}.png`);
  }

  private chromeOptions(
    options: SimpleBrowserOptions = {},
    desiredMode: ChromeSessionRequest["desiredMode"] = "preserve",
    background = false
  ): ChromeSessionRequest {
    return {
      desiredMode,
      ...(background ? { background: true } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      verbose: options.verbose
    };
  }
}
