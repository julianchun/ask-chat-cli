import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import {
  createChromeSessionController,
  type ChromeSessionController,
  type ChromeSessionRequest
} from "./browser";
import { getScreenshotsDir } from "./config";
import { createConversationContinuity, type ConversationContinuity } from "./conversations";
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
}

export interface PromptRunOptions {
  prompt: string;
  attachments: string[];
  provider?: ProviderName;
  headless?: boolean;
  newSession?: boolean;
  onContinuationUnavailable?: () => void;
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

  constructor(options: AppOptions = {}) {
    this.env = options.env || process.env;
    this.chromeSession = options.chromeSession || createChromeSessionController(this.env);
    this.conversations = options.conversationContinuity || createConversationContinuity(this.env);
  }

  async login(options: SimpleBrowserOptions = {}): Promise<void> {
    if (options.headless) {
      throw new Error("`ask login` requires a visible browser. Use `ask login --provider <provider>` without --headless.");
    }

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
  }

  async open(options: OpenOptions): Promise<void> {
    const provider = this.resolveProvider(options.provider);
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
        onContinuationUnavailable: options.onContinuationUnavailable
      });
      const page = await openChatPage(browser, provider, session.url, { newSession: session.newSession });
      if (options.send) {
        if (!options.prompt) {
          throw new Error("`ask open --send` requires a prompt.");
        }
        await this.assertSignedInBeforeSend(page, provider, options);
      }
      await provider.automation.attachFiles(page, options.attachments);
      if (options.prompt) {
        const input = await provider.automation.fillPrompt(page, options.prompt, Math.min(options.timeoutMs, 30_000));
        if (options.send) {
          await provider.automation.submitPrompt(page, input, Math.min(options.timeoutMs, 30_000));
        }
      }
      await this.conversations.remember(provider, page);
    } finally {
      await browser.close();
    }
  }

  async ask(options: PromptRunOptions): Promise<ResponseResult> {
    const provider = this.resolveProvider(options.provider);
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
        onContinuationUnavailable: options.onContinuationUnavailable
      });
      const page = await openWorkerPage(browser, provider, session.url, session.preferredUrl);
      await this.assertSignedInBeforeSend(page, provider, options);
      await provider.automation.attachFiles(page, options.attachments);
      const input = await provider.automation.fillPrompt(page, options.prompt, Math.min(options.timeoutMs, 30_000));
      const baseline = await provider.automation.captureAssistantResponseBaseline(page);
      await provider.automation.submitPrompt(page, input, Math.min(options.timeoutMs, 30_000));
      const result = await provider.automation.waitForAssistantCompletion(page, { timeoutMs: options.timeoutMs, baseline });
      await this.conversations.remember(provider, page);
      const conversationUrl = page.url();
      return {
        ...result,
        ...(provider.matchesConversationUrl(conversationUrl) ? { conversationUrl } : {})
      };
    } finally {
      await browser.close();
    }
  }

  async get(options: SimpleBrowserOptions = {}): Promise<string> {
    const provider = this.resolveProvider(options.provider);
    const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false, requireManaged: true });
    try {
      const page = selectCurrentPage(browser, provider, await this.conversations.preferredUrl(provider));
      return await provider.automation.extractLatestAssistantText(page);
    } finally {
      await browser.close();
    }
  }

  async dump(options: SimpleBrowserOptions = {}): Promise<string> {
    const provider = this.resolveProvider(options.provider);
    const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false, requireManaged: true });
    try {
      const page = selectCurrentPage(browser, provider, await this.conversations.preferredUrl(provider));
      return await page.content();
    } finally {
      await browser.close();
    }
  }

  async screenshot(output?: string, options: SimpleBrowserOptions = {}): Promise<string> {
    const provider = this.resolveProvider(options.provider);
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

