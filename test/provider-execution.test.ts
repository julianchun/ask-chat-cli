import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Locator, Page } from "playwright-core";
import {
  PromptDispatchPermit,
  createChatGptExecutionAdapter,
  createGeminiExecutionAdapter,
  executeProviderPrompt,
  isSubmissionConfirmed,
  type ProviderExecutionAdapter,
  type ProviderExecutionEvidence
} from "../src/provider-execution";

interface FixtureElement {
  count?: number;
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
  value?: string;
  files?: string[];
  label?: string;
  trialFails?: boolean;
  throwOnActualClick?: Error;
  onFill?: (value: string) => void;
  onClick?: (trial: boolean) => void;
  onPress?: (key: string) => void;
}

const ATTACHMENT_REMOVE_TESTID_SELECTOR =
  '[data-testid*="composer"] button[data-testid*="remove"], main form button[data-testid*="remove"]';
const ATTACHMENT_ROOT_SELECTOR = [
  '[data-testid*="composer"] [data-testid="file-thumbnail"]',
  'main form [data-testid="file-thumbnail"]',
  '[data-testid*="composer"] [data-testid="attachment-pill"]',
  'main form [data-testid="attachment-pill"]',
  '[data-testid*="composer"] [data-testid="attachment-preview"]',
  'main form [data-testid="attachment-preview"]',
  '[data-testid*="composer"] [data-testid="upload-preview"]',
  'main form [data-testid="upload-preview"]'
].join(", ");

class FixtureLocator {
  constructor(
    private readonly page: FixturePage,
    private readonly selector: string
  ) {}

  private get element(): FixtureElement | undefined {
    return this.page.elements.get(this.selector);
  }

  last(): FixtureLocator {
    return this;
  }

  nth(): FixtureLocator {
    return this;
  }

  async count(): Promise<number> {
    return this.element?.count ?? (this.element ? 1 : 0);
  }

  async isVisible(): Promise<boolean> {
    return Boolean(this.element && this.element.visible !== false);
  }

  async isEnabled(): Promise<boolean> {
    return Boolean(this.element && this.element.enabled !== false);
  }

  async isEditable(): Promise<boolean> {
    return Boolean(this.element?.editable);
  }

  async click(options: { trial?: boolean; timeout?: number } = {}): Promise<void> {
    const element = this.element;
    if (!element || element.visible === false || element.enabled === false) {
      throw new Error("not actionable");
    }
    const trial = Boolean(options.trial);
    if (trial && element.trialFails) {
      throw new Error("trial actionability failed");
    }
    const isDispatchControl = this.selector.includes("send-button") ||
      this.selector.includes("submit-button") ||
      this.selector.includes('aria-label="Send message"') ||
      this.selector.includes('aria-label="傳送訊息"');
    if (trial) {
      this.page.trialClicks += 1;
    } else {
      this.page.actualClicks += 1;
      if (isDispatchControl) {
        this.page.dispatchClicks += 1;
      }
    }
    element.onClick?.(trial);
    if (!trial && element.throwOnActualClick) {
      throw element.throwOnActualClick;
    }
  }

  async fill(value: string, _options?: { timeout?: number }): Promise<void> {
    const element = this.element;
    if (!element?.editable) {
      throw new Error("not editable");
    }
    element.value = value;
    element.onFill?.(value);
  }

  async press(key: string, _options?: { timeout?: number }): Promise<void> {
    const element = this.element;
    if (!element) {
      throw new Error("detached");
    }
    this.page.pressed.push(key);
    element.onPress?.(key);
  }

  async inputValue(): Promise<string> {
    const element = this.element;
    if (!element?.editable) {
      throw new Error("not an input");
    }
    return element.value || "";
  }

  async setInputFiles(files: string[]): Promise<void> {
    const element = this.element;
    if (!element) {
      throw new Error("detached");
    }
    element.files = [...files];
  }

  async evaluate<Result>(fn: (element: HTMLElement) => Result): Promise<Result> {
    const element = this.element;
    if (!element) {
      throw new Error("detached");
    }
    if (this.selector === 'input[type="file"]') {
      return [...(element.files || [])] as Result;
    }
    return fn({ textContent: element.value || "" } as HTMLElement);
  }
}

class FixturePage {
  readonly elements = new Map<string, FixtureElement>();
  readonly pressed: string[] = [];
  readonly keyboard = {
    insertText: async (value: string) => {
      const composer = this.elements.get("#prompt-textarea") ||
        this.elements.get('main rich-textarea [contenteditable="true"][role="textbox"]');
      if (composer) {
        composer.value = value;
      }
    }
  };
  actualClicks = 0;
  dispatchClicks = 0;
  trialClicks = 0;
  reloads = 0;
  waits = 0;
  currentUrl = "https://chatgpt.com/";
  uiAttachmentNames: string[] = [];
  pendingAttachmentNames: string[] = [];
  user = { count: 0, latestId: undefined as string | undefined, latestText: undefined as string | undefined };
  assistant = { count: 0, latestId: undefined as string | undefined, latestText: undefined as string | undefined };
  geminiAssistant = { count: 0, latestId: undefined as string | undefined, latestText: undefined as string | undefined };
  onReload?: () => void;
  onWait?: () => void;

  locator(selector: string): FixtureLocator {
    return new FixtureLocator(this, selector);
  }

  getByRole(): FixtureLocator {
    return new FixtureLocator(this, "role:textbox");
  }

  url(): string {
    return this.currentUrl;
  }

  async reload(): Promise<void> {
    this.reloads += 1;
    this.onReload?.();
  }

  async waitForTimeout(): Promise<void> {
    this.waits += 1;
    this.onWait?.();
    await Promise.resolve();
  }

  async evaluate<Arg, Result>(_fn: (arg: Arg) => Result, arg?: Arg): Promise<Result> {
    if (arg === "gemini-assistant-turns") {
      return { ...this.geminiAssistant } as Result;
    }
    if (Array.isArray(arg)) {
      const identities = arg as Array<{ name: string; patternSource: string }>;
      return this.uiAttachmentNames.flatMap((label, identity) => identities.flatMap((requested) => {
        const matcher = new RegExp(requested.patternSource, "u");
        if (label.normalize("NFC") !== requested.name && !matcher.test(label.normalize("NFC"))) {
          return [];
        }
        return [{
          name: requested.name,
          pending: this.pendingAttachmentNames.includes(label),
          identity: `${identity}`
        }];
      })) as Result;
    }
    return {
      user: { ...this.user },
      assistant: { ...this.assistant }
    } as Result;
  }
}

function installReadyZhTwFixture(page: FixturePage): void {
  page.elements.set("main", { visible: true, enabled: true });
  page.elements.set("#prompt-textarea", {
    visible: true,
    enabled: true,
    editable: true,
    value: "",
    label: "傳送訊息給 ChatGPT"
  });
  page.elements.set('[data-testid="accounts-profile-button"]', {
    visible: true,
    enabled: true,
    label: "開啟個人資料選單"
  });
  page.elements.set('button[data-testid="send-button"]', {
    visible: true,
    enabled: true,
    label: "傳送提示"
  });
}

const GEMINI_PROMPT_SELECTOR = 'main rich-textarea [contenteditable="true"][role="textbox"]';
const GEMINI_SEND_SELECTOR = 'main [data-testid="composer"] button[data-testid="send-button"]';
const GEMINI_LIVE_SEND_SELECTOR = 'main .text-input-field button[aria-label="Send message"]';

function installReadyGeminiFixture(page: FixturePage): void {
  page.currentUrl = "https://gemini.google.com/app";
  page.elements.set("main", { visible: true, enabled: true });
  page.elements.set(GEMINI_PROMPT_SELECTOR, {
    visible: true,
    enabled: true,
    editable: true,
    value: "",
    label: "輸入提示"
  });
  page.elements.set('a[href*="SignOutOptions"]', {
    visible: true,
    enabled: true,
    label: "Google 帳戶"
  });
  page.elements.set(GEMINI_SEND_SELECTOR, {
    visible: true,
    enabled: true,
    label: "傳送"
  });
}

function adapterFor(page: FixturePage, options: {
  attachmentVerificationMs?: number;
  draftVerificationMs?: number;
  pollMs?: number;
  onAttach?: (paths: readonly string[]) => void;
  onWaitForResponse?: () => unknown | Promise<unknown>;
} = {}) {
  const attachFiles = vi.fn(async (_target: Page, paths: string[]) => {
    options.onAttach?.(paths);
  });
  const waitForAssistantCompletion = vi.fn(async () => {
    await options.onWaitForResponse?.();
    return { text: "fixture answer", timedOut: false };
  });
  const adapter = createChatGptExecutionAdapter({
    automation: { attachFiles, waitForAssistantCompletion },
    attachmentVerificationMs: options.attachmentVerificationMs,
    draftVerificationMs: options.draftVerificationMs,
    pollMs: options.pollMs ?? 0
  });
  return { adapter, attachFiles, waitForAssistantCompletion };
}

function geminiAdapterFor(page: FixturePage, options: {
  draftVerificationMs?: number;
  readinessDiscoveryMs?: number;
  pollMs?: number;
  onWaitForResponse?: () => unknown | Promise<unknown>;
} = {}) {
  const waitForAssistantCompletion = vi.fn(async () => {
    await options.onWaitForResponse?.();
    return { text: "Gemini fixture answer", timedOut: false };
  });
  const extractLatestAssistantText = vi.fn(async () => page.geminiAssistant.latestText || "");
  const adapter = createGeminiExecutionAdapter({
    automation: { waitForAssistantCompletion, extractLatestAssistantText },
    draftVerificationMs: options.draftVerificationMs,
    readinessDiscoveryMs: options.readinessDiscoveryMs ?? 0,
    pollMs: options.pollMs ?? 0,
    matchesConversationUrl: (value) => Boolean(value?.startsWith("https://gemini.google.com/app/"))
  });
  return { adapter, waitForAssistantCompletion, extractLatestAssistantText };
}

function makeStrongEvidence(name: string): ProviderExecutionEvidence {
  return { name, claim: "submission", strength: "strong" };
}

function coordinatorFixtureAdapter(): ProviderExecutionAdapter {
  return {
    provider: "chatgpt",
    displayName: "ChatGPT",
    matchesConversationUrl: (value) => Boolean(value?.startsWith("https://chatgpt.com/c/")),
    discoverCapabilities: async () => ({
      url: "https://chatgpt.com/",
      auth: { state: "signed-in-likely", confidence: "strong", evidence: [] },
      prompt: { available: true, strategy: "fixture.prompt", evidence: [] },
      attachment: { available: true, strategy: "fixture.attachment", evidence: [] },
      clickDispatch: { available: true, strategy: "fixture.send", evidence: [] },
      enterDispatch: { available: false, evidence: [] },
      response: { available: true, strategy: "fixture.response", evidence: [] },
      evidence: []
    }),
    attachAndVerify: async () => ({ files: [] }),
    fillAndVerifyDraft: async (_page, prompt) => ({
      strategy: "fixture.prompt",
      text: prompt,
      evidence: {
        name: "fixture.draft",
        claim: "prompt-input",
        strength: "strong"
      }
    }),
    captureBaseline: async () => ({
      url: "https://chatgpt.com/",
      user: { count: 0 },
      assistant: { count: 0 },
      busy: false
    }),
    preselectDispatch: async () => ({
      name: "fixture.send",
      kind: "click",
      evidence: {
        name: "fixture.send",
        claim: "dispatch",
        strength: "strong"
      },
      dispatch: async () => undefined
    }),
    observeSubmission: async () => ({ evidence: [makeStrongEvidence("fixture.user-turn")] }),
    waitForResponse: async () => ({ text: "fixture answer", timedOut: false })
  };
}

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })
  ));
});

describe("PromptDispatchPermit", () => {
  it("can be consumed by exactly one preselected strategy", () => {
    const permit = new PromptDispatchPermit();

    permit.consume("chatgpt.send-testid");

    expect(permit.consumed).toBe(true);
    expect(permit.strategy).toBe("chatgpt.send-testid");
    expect(() => permit.consume("chatgpt.composer-enter")).toThrow("already consumed");
  });
});

describe("submission evidence policy", () => {
  it("accepts one strong signal or two independent weak signals", () => {
    expect(isSubmissionConfirmed([makeStrongEvidence("new-user-turn")])).toBe(true);
    expect(isSubmissionConfirmed([
      { name: "draft-one", claim: "submission", strength: "weak", independenceKey: "draft" },
      { name: "draft-two", claim: "submission", strength: "weak", independenceKey: "draft" }
    ])).toBe(false);
    expect(isSubmissionConfirmed([
      { name: "draft", claim: "submission", strength: "weak", independenceKey: "draft" },
      { name: "url", claim: "submission", strength: "weak", independenceKey: "navigation" }
    ])).toBe(true);
  });
});

describe("provider coordinator deadline", () => {
  it.each([
    { phase: "readiness", stage: "readiness.discover", code: "BROWSER_UNAVAILABLE" },
    { phase: "attachment", stage: "attachment.upload", code: "ATTACHMENT_UPLOAD_FAILED" },
    { phase: "draft", stage: "prompt.verify", code: "PROMPT_FILL_UNCONFIRMED" },
    { phase: "baseline", stage: "response.baseline", code: "PROMPT_SUBMIT_FAILED" }
  ] as const)("bounds a hanging $phase operation before dispatch", async ({ phase, stage, code }) => {
    const page = new FixturePage();
    const adapter = coordinatorFixtureAdapter();
    let dispatchCount = 0;
    let recoveryCount = 0;
    adapter.preselectDispatch = async () => ({
      name: "fixture.send",
      kind: "click",
      evidence: {
        name: "fixture.send",
        claim: "dispatch",
        strength: "strong"
      },
      dispatch: async () => {
        dispatchCount += 1;
      }
    });
    if (phase === "readiness") {
      adapter.discoverCapabilities = () => neverSettles();
    } else if (phase === "attachment") {
      adapter.attachAndVerify = () => neverSettles();
    } else if (phase === "draft") {
      adapter.fillAndVerifyDraft = () => neverSettles();
    } else {
      adapter.captureBaseline = () => neverSettles();
    }

    const startedAt = Date.now();
    await expect(executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "bounded",
      attachments: [],
      timeoutMs: 20,
      onPreSubmitRecovery: () => {
        recoveryCount += 1;
      }
    })).rejects.toMatchObject({ code, stage });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(dispatchCount).toBe(0);
    expect(recoveryCount).toBe(0);
  });

  it("bounds a hanging dispatched action and enters observe-only unknown state", async () => {
    const page = new FixturePage();
    const adapter = coordinatorFixtureAdapter();
    let dispatchCount = 0;
    let observationCount = 0;
    adapter.preselectDispatch = async () => ({
      name: "fixture.send",
      kind: "click",
      evidence: {
        name: "fixture.send",
        claim: "dispatch",
        strength: "strong"
      },
      dispatch: () => {
        dispatchCount += 1;
        return neverSettles();
      }
    });
    adapter.observeSubmission = async () => {
      observationCount += 1;
      return { evidence: [] };
    };

    const startedAt = Date.now();
    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "bounded",
      attachments: [],
      timeoutMs: 20,
      submissionPollMs: 0
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result).toMatchObject({
      deliveryState: "unknown",
      dispatchStrategy: "fixture.send"
    });
    expect(dispatchCount).toBe(1);
    expect(observationCount).toBe(0);
  });

  it("reports the latest auth state when a recovery handoff reaches the deadline", async () => {
    const page = new FixturePage();
    const adapter = coordinatorFixtureAdapter();
    const signedIn = await adapter.discoverCapabilities(page as unknown as Page);
    const guest = {
      ...signedIn,
      auth: { state: "guest" as const, confidence: "strong" as const, evidence: [] }
    };
    const blocked = {
      ...signedIn,
      auth: { state: "blocked" as const, confidence: "strong" as const, evidence: [] }
    };
    let discoveryCount = 0;
    adapter.discoverCapabilities = async () => {
      discoveryCount += 1;
      if (discoveryCount === 1) {
        return signedIn;
      }
      if (discoveryCount === 2) {
        return guest;
      }
      return blocked;
    };
    adapter.fillAndVerifyDraft = async () => {
      throw new Error("composer replaced");
    };
    adapter.recoverBeforeSubmit = async () => undefined;
    let dispatchCount = 0;
    adapter.preselectDispatch = async () => ({
      name: "fixture.send",
      kind: "click",
      evidence: {
        name: "fixture.send",
        claim: "dispatch",
        strength: "strong"
      },
      dispatch: async () => {
        dispatchCount += 1;
      }
    });

    await expect(executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "never dispatch",
      attachments: [],
      timeoutMs: 25,
      authPollMs: 0,
      onAuthHandoff: async (waitForReady) => {
        await waitForReady();
      }
    })).rejects.toMatchObject({
      code: "AUTH_HANDOFF_TIMEOUT",
      context: {
        authState: "blocked",
        deliveryState: "not-attempted"
      }
    });
    expect(dispatchCount).toBe(0);
  });

  it("preserves the original structured preparation stage when recovery also fails", async () => {
    const page = new FixturePage();
    const adapter = coordinatorFixtureAdapter();
    adapter.captureBaseline = async () => {
      throw new Error("baseline page replaced");
    };
    adapter.recoverBeforeSubmit = async () => {
      throw new Error("reload aborted");
    };

    await expect(executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "diagnostic prompt",
      attachments: [],
      timeoutMs: 100
    })).rejects.toMatchObject({
      code: "PROMPT_SUBMIT_FAILED",
      stage: "response.baseline",
      message: "ChatGPT failed while preparing the response baseline before dispatch.",
      context: { deliveryState: "not-attempted" }
    });
  });

  it.each([
    { label: "with partial text", partial: "partial fixture answer" },
    { label: "without partial text", partial: "" }
  ])("preserves a confirmed timed-out response $label when the waiter hangs", async ({ partial }) => {
    const page = new FixturePage();
    page.currentUrl = "https://chatgpt.com/c/hung-response";
    const adapter = coordinatorFixtureAdapter();
    let dispatchCount = 0;
    adapter.preselectDispatch = async () => ({
      name: "fixture.send",
      kind: "click",
      evidence: {
        name: "fixture.send",
        claim: "dispatch",
        strength: "strong"
      },
      dispatch: async () => {
        dispatchCount += 1;
      }
    });
    adapter.capturePartialResponse = async () => partial;
    adapter.waitForResponse = () => neverSettles();

    const startedAt = Date.now();
    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "bounded response",
      attachments: [],
      timeoutMs: 35,
      submissionPollMs: 0
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result).toMatchObject({
      deliveryState: "confirmed",
      conversationUrl: "https://chatgpt.com/c/hung-response",
      response: {
        text: partial,
        timedOut: true,
        conversationUrl: "https://chatgpt.com/c/hung-response"
      }
    });
    expect(dispatchCount).toBe(1);
  });
});

describe("Gemini execution adapter", () => {
  it("discovers structural click-only capabilities in English and Traditional Chinese fixtures", async () => {
    for (const label of ["Send", "傳送"] as const) {
      const page = new FixturePage();
      installReadyGeminiFixture(page);
      page.elements.get(GEMINI_SEND_SELECTOR)!.label = label;
      const { adapter } = geminiAdapterFor(page);

      const capabilities = await adapter.discoverCapabilities(page as unknown as Page);

      expect(capabilities.auth).toMatchObject({ state: "signed-in-likely", confidence: "strong" });
      expect(capabilities.prompt).toMatchObject({
        available: true,
        strategy: "gemini.rich-textarea-role-textbox"
      });
      expect(capabilities.clickDispatch).toMatchObject({
        available: true,
        strategy: "gemini.composer-send-testid"
      });
      expect(capabilities.enterDispatch).toMatchObject({ available: false });
      expect(capabilities.attachment).toMatchObject({ available: false });
      expect(page.trialClicks).toBe(1);
    }
  });

  it("supports the scoped send control observed in the live Gemini input area", async () => {
    const page = new FixturePage();
    installReadyGeminiFixture(page);
    page.elements.delete(GEMINI_SEND_SELECTOR);
    page.elements.set(GEMINI_LIVE_SEND_SELECTOR, {
      visible: true,
      enabled: true,
      label: "Send message"
    });
    const { adapter } = geminiAdapterFor(page, { draftVerificationMs: 0 });

    const capabilities = await adapter.discoverCapabilities(page as unknown as Page);
    expect(capabilities.clickDispatch).toMatchObject({
      available: true,
      strategy: "gemini.input-area-send-aria-en"
    });
    await adapter.fillAndVerifyDraft(page as unknown as Page, "live structure", Date.now() + 100);
    const dispatch = await adapter.preselectDispatch(page as unknown as Page, Date.now() + 100);
    expect(dispatch).toMatchObject({ name: "gemini.input-area-send-aria-en", kind: "click" });
    await dispatch.dispatch();
    expect(page.dispatchClicks).toBe(1);
    expect(page.pressed).toEqual([]);
  });

  it("reports deferred click readiness when Gemini has not rendered the empty-composer send button", async () => {
    const page = new FixturePage();
    installReadyGeminiFixture(page);
    page.elements.delete(GEMINI_SEND_SELECTOR);
    const { adapter } = geminiAdapterFor(page);

    await expect(adapter.discoverCapabilities(page as unknown as Page)).resolves.toMatchObject({
      prompt: { available: true },
      clickDispatch: { available: true, strategy: "gemini.send-after-draft" },
      enterDispatch: { available: false }
    });
  });

  it("waits briefly for Gemini hydration before classifying a signed-in worker page", async () => {
    const page = new FixturePage();
    page.currentUrl = "https://gemini.google.com/app";
    page.elements.set("main", { visible: true, enabled: true });
    page.onWait = () => installReadyGeminiFixture(page);
    const { adapter } = geminiAdapterFor(page, {
      readinessDiscoveryMs: 100,
      pollMs: 1
    });

    await expect(adapter.discoverCapabilities(page as unknown as Page)).resolves.toMatchObject({
      auth: { state: "signed-in-likely", confidence: "strong" },
      prompt: { available: true }
    });
    expect(page.waits).toBeGreaterThan(0);
  });

  it("reports signed-out, auth-conflict, and blocked Gemini states before dispatch", async () => {
    const signedOut = new FixturePage();
    signedOut.currentUrl = "https://gemini.google.com/app";
    signedOut.elements.set("main", { visible: true, enabled: true });
    signedOut.elements.set('[data-testid="sign-in-button"]', { visible: true, enabled: true });
    const { adapter: signedOutAdapter } = geminiAdapterFor(signedOut);
    await expect(signedOutAdapter.discoverCapabilities(signedOut as unknown as Page)).resolves.toMatchObject({
      auth: { state: "login-required", confidence: "strong" }
    });
    await expect(executeProviderPrompt(signedOut as unknown as Page, signedOutAdapter, {
      prompt: "must not dispatch",
      attachments: [],
      timeoutMs: 30
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED", context: { deliveryState: "not-attempted" } });

    const conflict = new FixturePage();
    installReadyGeminiFixture(conflict);
    conflict.elements.set('[data-testid="sign-in-button"]', { visible: true, enabled: true });
    const { adapter: conflictAdapter } = geminiAdapterFor(conflict);
    await expect(conflictAdapter.discoverCapabilities(conflict as unknown as Page)).resolves.toMatchObject({
      auth: { state: "unknown", confidence: "conflicting" }
    });

    const blocked = new FixturePage();
    installReadyGeminiFixture(blocked);
    blocked.elements.delete('a[href*="SignOutOptions"]');
    blocked.elements.set('iframe[src*="recaptcha"]', { visible: true, enabled: true });
    const { adapter: blockedAdapter } = geminiAdapterFor(blocked);
    await expect(executeProviderPrompt(blocked as unknown as Page, blockedAdapter, {
      prompt: "blocked",
      attachments: [],
      timeoutMs: 30
    })).rejects.toMatchObject({ code: "PROVIDER_BLOCKED", context: { deliveryState: "not-attempted" } });
    expect(blocked.dispatchClicks).toBe(0);
  });

  it("requires visible, enabled, editable composer readback and rejects a mismatch", async () => {
    const page = new FixturePage();
    installReadyGeminiFixture(page);
    const { adapter } = geminiAdapterFor(page, { draftVerificationMs: 0 });

    await expect(adapter.fillAndVerifyDraft(page as unknown as Page, "第一行\n第二行", Date.now() + 100)).resolves.toMatchObject({
      strategy: "gemini.rich-textarea-role-textbox",
      text: "第一行\n第二行"
    });

    page.elements.get(GEMINI_PROMPT_SELECTOR)!.onFill = () => {
      page.elements.get(GEMINI_PROMPT_SELECTOR)!.value = "different";
    };
    await expect(adapter.fillAndVerifyDraft(page as unknown as Page, "expected", Date.now() + 100)).rejects.toMatchObject({
      code: "PROMPT_FILL_UNCONFIRMED",
      stage: "prompt.verify"
    });

    page.elements.get(GEMINI_PROMPT_SELECTOR)!.editable = false;
    await expect(adapter.fillAndVerifyDraft(page as unknown as Page, "not editable", Date.now() + 100)).rejects.toMatchObject({
      code: "PROMPT_INPUT_NOT_FOUND",
      stage: "prompt.find"
    });

    page.elements.get(GEMINI_PROMPT_SELECTOR)!.editable = true;
    page.elements.get(GEMINI_PROMPT_SELECTOR)!.count = 2;
    await expect(adapter.fillAndVerifyDraft(page as unknown as Page, "ambiguous composer", Date.now() + 100)).rejects.toMatchObject({
      code: "PROMPT_INPUT_NOT_FOUND",
      stage: "prompt.find"
    });
  });

  it("fails before dispatch for an ambiguous or absent Gemini click control and never uses Enter", async () => {
    const ambiguous = new FixturePage();
    installReadyGeminiFixture(ambiguous);
    ambiguous.elements.get(GEMINI_SEND_SELECTOR)!.count = 2;
    const { adapter: ambiguousAdapter } = geminiAdapterFor(ambiguous, { draftVerificationMs: 0 });
    await expect(executeProviderPrompt(ambiguous as unknown as Page, ambiguousAdapter, {
      prompt: "ambiguous",
      attachments: [],
      timeoutMs: 30
    })).rejects.toMatchObject({ code: "PROMPT_SUBMIT_FAILED", stage: "prompt.submit" });
    expect(ambiguous.dispatchClicks).toBe(0);
    expect(ambiguous.pressed).toEqual([]);

    const absent = new FixturePage();
    installReadyGeminiFixture(absent);
    absent.elements.delete(GEMINI_SEND_SELECTOR);
    const { adapter: absentAdapter } = geminiAdapterFor(absent, { draftVerificationMs: 0 });
    await expect(executeProviderPrompt(absent as unknown as Page, absentAdapter, {
      prompt: "absent",
      attachments: [],
      timeoutMs: 30
    })).rejects.toMatchObject({ code: "PROMPT_SUBMIT_FAILED", stage: "prompt.submit" });
    expect(absent.dispatchClicks).toBe(0);
    expect(absent.pressed).toEqual([]);
  });

  it.each([
    { label: "click throws after the page may have received it", mode: "throw" as const },
    { label: "delayed acknowledgement", mode: "delayed" as const },
    { label: "no-op", mode: "noop" as const }
  ])("keeps Gemini $label observe-only and dispatches at most once", async ({ mode }) => {
    const page = new FixturePage();
    installReadyGeminiFixture(page);
    if (mode === "throw") {
      page.elements.get(GEMINI_SEND_SELECTOR)!.throwOnActualClick = new Error("frame detached after click");
    }
    if (mode === "delayed") {
      page.onWait = () => {
        if (page.waits >= 2) {
          page.geminiAssistant = { count: 1, latestId: "delayed-1", latestText: "Starting" };
        }
      };
    }
    const { adapter, waitForAssistantCompletion } = geminiAdapterFor(page, { draftVerificationMs: 0 });
    const uncertain = vi.fn();
    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "once",
      attachments: [],
      timeoutMs: mode === "noop" ? 15 : 100,
      submissionPollMs: mode === "delayed" ? 1 : 0,
      submissionConfirmationMs: 0,
      onSubmissionUncertain: uncertain
    });

    expect(page.dispatchClicks).toBe(1);
    expect(page.pressed).toEqual([]);
    expect(page.reloads).toBe(0);
    if (mode === "delayed") {
      expect(result.deliveryState).toBe("confirmed");
      expect(waitForAssistantCompletion).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({ deliveryState: "unknown", dispatchStrategy: "gemini.composer-send-testid" });
      expect(waitForAssistantCompletion).not.toHaveBeenCalled();
    }
    expect(uncertain).toHaveBeenCalledTimes(1);
  });

  it("accepts a newly identified assistant turn strongly and valid independent weak pairs", async () => {
    const strong = new FixturePage();
    installReadyGeminiFixture(strong);
    strong.elements.get(GEMINI_SEND_SELECTOR)!.onClick = (trial) => {
      if (!trial) {
        strong.geminiAssistant = { count: 1, latestId: "response-1", latestText: "Answer" };
      }
    };
    const { adapter: strongAdapter } = geminiAdapterFor(strong, { draftVerificationMs: 0 });
    const strongResult = await executeProviderPrompt(strong as unknown as Page, strongAdapter, {
      prompt: "assistant confirmation",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0
    });
    expect(strongResult).toMatchObject({ deliveryState: "confirmed" });
    expect(strongResult.evidence).toContainEqual(expect.objectContaining({
      name: "gemini.assistant-turn-count-advanced",
      strength: "strong"
    }));

    const weak = new FixturePage();
    installReadyGeminiFixture(weak);
    weak.elements.get(GEMINI_SEND_SELECTOR)!.onClick = (trial) => {
      if (!trial) {
        weak.currentUrl = "https://gemini.google.com/app/fixture-1";
        weak.elements.get(GEMINI_PROMPT_SELECTOR)!.value = "";
      }
    };
    const { adapter: weakAdapter } = geminiAdapterFor(weak, { draftVerificationMs: 0 });
    const weakResult = await executeProviderPrompt(weak as unknown as Page, weakAdapter, {
      prompt: "weak pair",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0
    });
    expect(weakResult).toMatchObject({ deliveryState: "confirmed" });
    expect(weakResult.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "gemini.conversation-url-changed", independenceKey: "navigation" }),
      expect.objectContaining({ name: "gemini.draft-cleared", independenceKey: "draft" })
    ]));
  });

  it("does not confirm an identical Gemini prompt by text alone and saves a provider URL before response waiting", async () => {
    const noIdentity = new FixturePage();
    installReadyGeminiFixture(noIdentity);
    noIdentity.geminiAssistant = { count: 1, latestId: "old-response", latestText: "repeat" };
    const { adapter: noIdentityAdapter, waitForAssistantCompletion: noIdentityWaiter } = geminiAdapterFor(noIdentity, {
      draftVerificationMs: 0
    });
    const unknown = await executeProviderPrompt(noIdentity as unknown as Page, noIdentityAdapter, {
      prompt: "repeat",
      attachments: [],
      timeoutMs: 15,
      submissionPollMs: 0,
      submissionConfirmationMs: 0
    });
    expect(unknown.deliveryState).toBe("unknown");
    expect(noIdentityWaiter).not.toHaveBeenCalled();

    const persist = new FixturePage();
    installReadyGeminiFixture(persist);
    const order: string[] = [];
    persist.elements.get(GEMINI_SEND_SELECTOR)!.onClick = (trial) => {
      if (!trial) {
        persist.currentUrl = "https://gemini.google.com/app/fixture-save";
        persist.geminiAssistant = { count: 1, latestId: "new-response", latestText: "Starting" };
      }
    };
    const { adapter: persistAdapter } = geminiAdapterFor(persist, {
      draftVerificationMs: 0,
      onWaitForResponse: () => order.push("response")
    });
    const confirmed = vi.fn(async (url: string) => {
      order.push(`saved:${url}`);
    });
    const result = await executeProviderPrompt(persist as unknown as Page, persistAdapter, {
      prompt: "persist",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0,
      onSubmissionConfirmed: confirmed
    });
    expect(result.deliveryState).toBe("confirmed");
    expect(confirmed).toHaveBeenCalledWith("https://gemini.google.com/app/fixture-save");
    expect(order).toEqual(["saved:https://gemini.google.com/app/fixture-save", "response"]);
  });

  it("fails Gemini attachments closed before clicking unless a verified surface is introduced", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-gemini-execution-"));
    temporaryDirectories.push(directory);
    const attachment = path.join(directory, "fixture.pdf");
    await fs.promises.writeFile(attachment, "fixture", "utf8");
    const page = new FixturePage();
    installReadyGeminiFixture(page);
    const { adapter } = geminiAdapterFor(page, { draftVerificationMs: 0 });

    await expect(executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "attachment",
      attachments: [attachment],
      timeoutMs: 100
    })).rejects.toMatchObject({ code: "ATTACHMENT_UPLOAD_FAILED", stage: "attachment.upload" });
    expect(page.dispatchClicks).toBe(0);
    expect(page.pressed).toEqual([]);
    expect(page.reloads).toBe(0);
  });
});

describe("ChatGPT execution adapter", () => {
  it("fills the composer without a separate click that can stall during hydration", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.get("#prompt-textarea")!.throwOnActualClick = new Error("hydration click stalled");
    const { adapter } = adapterFor(page, { draftVerificationMs: 100 });

    await expect(adapter.fillAndVerifyDraft(
      page as unknown as Page,
      "first background prompt",
      Date.now() + 100
    )).resolves.toMatchObject({
      strategy: "chatgpt.prompt-id",
      text: "first background prompt"
    });
    expect(page.actualClicks).toBe(0);
  });

  it("discovers strong locale-resistant capabilities on a zh-TW fixture", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.set('input[type="file"]', { visible: false, enabled: true, files: [] });
    const { adapter } = adapterFor(page);

    const capabilities = await adapter.discoverCapabilities(page as unknown as Page);

    expect(capabilities.auth).toMatchObject({ state: "signed-in-likely", confidence: "strong" });
    expect(capabilities.prompt).toMatchObject({ available: true, strategy: "chatgpt.prompt-id" });
    expect(capabilities.attachment.available).toBe(true);
    expect(capabilities.clickDispatch).toMatchObject({ available: true, strategy: "chatgpt.send-testid" });
    expect(capabilities.response).toMatchObject({ available: true, strategy: "chatgpt.conversation-main" });
    expect(page.trialClicks).toBe(1);
    expect(page.actualClicks).toBe(0);
  });

  it("marks conflicting auth evidence unknown and does not accept a read-only composer", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.set('a[href*="/auth/login"]', { visible: true, enabled: true, label: "登入" });
    page.elements.get("#prompt-textarea")!.editable = false;
    const { adapter } = adapterFor(page);

    const capabilities = await adapter.discoverCapabilities(page as unknown as Page);

    expect(capabilities.auth).toMatchObject({ state: "unknown", confidence: "conflicting" });
    expect(capabilities.prompt.available).toBe(false);
  });

  it("discovers an English signed-out page as strongly auth-required", async () => {
    const page = new FixturePage();
    page.elements.set("main", { visible: true, enabled: true });
    page.elements.set('a[href*="/auth/login"]', {
      visible: true,
      enabled: true,
      label: "Log in"
    });
    const { adapter } = adapterFor(page);

    const capabilities = await adapter.discoverCapabilities(page as unknown as Page);

    expect(capabilities.auth).toMatchObject({
      state: "login-required",
      confidence: "strong"
    });
    expect(capabilities.prompt.available).toBe(false);
    await expect(executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "must not send",
      attachments: [],
      timeoutMs: 100
    })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      context: { deliveryState: "not-attempted" }
    });
    expect(page.actualClicks).toBe(0);
  });

  it("captures URL plus user and assistant turn identity/count", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.currentUrl = "https://chatgpt.com/c/existing";
    page.user = { count: 2, latestId: "user-2", latestText: "second question" };
    page.assistant = { count: 2, latestId: "assistant-2", latestText: "second answer" };
    const { adapter } = adapterFor(page);

    await expect(adapter.captureBaseline(page as unknown as Page)).resolves.toEqual({
      url: "https://chatgpt.com/c/existing",
      user: { count: 2, latestId: "user-2", latestText: "second question" },
      assistant: { count: 2, latestId: "assistant-2", latestText: "second answer" },
      busy: false
    });
  });

  it("verifies attachment names after upload", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-execution-"));
    temporaryDirectories.push(directory);
    const attachment = path.join(directory, "規格.pdf");
    await fs.promises.writeFile(attachment, "fixture", "utf8");
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.set('input[type="file"]', { visible: false, enabled: true, files: [] });
    const { adapter, attachFiles } = adapterFor(page, {
      attachmentVerificationMs: 0,
      onAttach: (paths) => {
        const names = paths.map((filePath) => path.basename(filePath));
        page.elements.get('input[type="file"]')!.files = names;
        page.uiAttachmentNames = names;
      }
    });

    const verification = await adapter.attachAndVerify(
      page as unknown as Page,
      [attachment],
      Date.now() + 100
    );

    expect(attachFiles).toHaveBeenCalledTimes(1);
    expect(verification.files).toEqual([
      expect.objectContaining({ path: attachment, name: "規格.pdf" })
    ]);
  });

  it("clears stale composer attachments before uploading exact requested files", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-execution-"));
    temporaryDirectories.push(directory);
    const firstDirectory = path.join(directory, "first");
    const secondDirectory = path.join(directory, "second");
    await fs.promises.mkdir(firstDirectory);
    await fs.promises.mkdir(secondDirectory);
    const firstAttachment = path.join(firstDirectory, "same.pdf");
    const secondAttachment = path.join(secondDirectory, "same.pdf");
    await fs.promises.writeFile(firstAttachment, "first", "utf8");
    await fs.promises.writeFile(secondAttachment, "second", "utf8");
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.set('input[type="file"]', {
      visible: false,
      enabled: true,
      files: ["same.pdf"]
    });
    page.uiAttachmentNames = ["same.pdf"];
    page.elements.set(ATTACHMENT_ROOT_SELECTOR, { visible: true, enabled: true });
    page.elements.set(ATTACHMENT_REMOVE_TESTID_SELECTOR, {
      visible: true,
      enabled: true,
      onClick: (trial) => {
        if (!trial) {
          page.uiAttachmentNames = [];
          page.pendingAttachmentNames = [];
          page.elements.delete(ATTACHMENT_ROOT_SELECTOR);
          page.elements.delete(ATTACHMENT_REMOVE_TESTID_SELECTOR);
        }
      }
    });
    const { adapter, attachFiles } = adapterFor(page, {
      attachmentVerificationMs: 100,
      onAttach: (paths) => {
        const names = paths.map((filePath) => path.basename(filePath));
        page.elements.get('input[type="file"]')!.files = names;
        page.uiAttachmentNames = names;
      }
    });

    await expect(adapter.attachAndVerify(
      page as unknown as Page,
      [firstAttachment, secondAttachment],
      Date.now() + 100
    )).resolves.toMatchObject({
      files: [
        expect.objectContaining({ path: firstAttachment }),
        expect.objectContaining({ path: secondAttachment })
      ]
    });
    expect(attachFiles).toHaveBeenCalledTimes(1);
    expect(attachFiles).toHaveBeenCalledWith(
      page as unknown as Page,
      [firstAttachment, secondAttachment]
    );
  });

  it("fails closed instead of reusing an unremovable same-name attachment", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-execution-"));
    temporaryDirectories.push(directory);
    const attachment = path.join(directory, "report.pdf");
    await fs.promises.writeFile(attachment, "new report", "utf8");
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.set('input[type="file"]', { visible: false, enabled: true, files: [] });
    page.uiAttachmentNames = ["report.pdf"];
    const { adapter, attachFiles } = adapterFor(page, { attachmentVerificationMs: 0 });

    await expect(adapter.attachAndVerify(
      page as unknown as Page,
      [attachment],
      Date.now() + 100
    )).rejects.toMatchObject({
      code: "ATTACHMENT_UPLOAD_FAILED",
      stage: "attachment.upload",
      message: expect.stringContaining("pre-existing")
    });
    expect(attachFiles).not.toHaveBeenCalled();
  });

  it("does not accept a longer filename containing the requested basename", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-execution-"));
    temporaryDirectories.push(directory);
    const attachment = path.join(directory, "report.pdf");
    await fs.promises.writeFile(attachment, "fixture", "utf8");
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.set('input[type="file"]', { visible: false, enabled: true, files: [] });
    page.uiAttachmentNames = ["annual-report.pdf", "report.pdf.bak"];
    const { adapter, attachFiles } = adapterFor(page, {
      attachmentVerificationMs: 0
    });

    await expect(adapter.attachAndVerify(
      page as unknown as Page,
      [attachment],
      Date.now() + 100
    )).rejects.toMatchObject({
      code: "ATTACHMENT_UPLOAD_FAILED",
      stage: "attachment.upload"
    });
    expect(attachFiles).toHaveBeenCalledTimes(1);
  });

  it("does not treat input.files alone as a finished composer attachment", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-execution-"));
    temporaryDirectories.push(directory);
    const attachment = path.join(directory, "selected-only.pdf");
    await fs.promises.writeFile(attachment, "fixture", "utf8");
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.set('input[type="file"]', { visible: false, enabled: true, files: [] });
    const { adapter, attachFiles } = adapterFor(page, {
      attachmentVerificationMs: 0,
      onAttach: (paths) => {
        page.elements.get('input[type="file"]')!.files = paths.map((filePath) => path.basename(filePath));
      }
    });

    await expect(adapter.attachAndVerify(
      page as unknown as Page,
      [attachment],
      Date.now() + 100
    )).rejects.toMatchObject({
      code: "ATTACHMENT_UPLOAD_FAILED",
      stage: "attachment.upload"
    });
    expect(attachFiles).toHaveBeenCalledTimes(1);
  });

  it("waits until the composer attachment is no longer uploading", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-execution-"));
    temporaryDirectories.push(directory);
    const attachment = path.join(directory, "uploading.pdf");
    await fs.promises.writeFile(attachment, "fixture", "utf8");
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.set('input[type="file"]', { visible: false, enabled: true, files: [] });
    page.onWait = () => {
      page.pendingAttachmentNames = [];
    };
    const { adapter } = adapterFor(page, {
      attachmentVerificationMs: 100,
      pollMs: 1,
      onAttach: (paths) => {
        const names = paths.map((filePath) => path.basename(filePath));
        page.uiAttachmentNames = names;
        page.pendingAttachmentNames = names;
      }
    });

    await expect(adapter.attachAndVerify(
      page as unknown as Page,
      [attachment],
      Date.now() + 100
    )).resolves.toMatchObject({
      files: [expect.objectContaining({ name: "uploading.pdf" })]
    });
    expect(page.waits).toBeGreaterThan(0);
  });

  it("uses one bounded reload for an SPA composer replacement before dispatch", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    let replaceComposer = true;
    page.elements.get("#prompt-textarea")!.onFill = () => {
      if (replaceComposer) {
        page.elements.set("#prompt-textarea", {
          visible: true,
          enabled: true,
          editable: true,
          value: ""
        });
      }
    };
    page.onReload = () => {
      replaceComposer = false;
      page.elements.set("#prompt-textarea", {
        visible: true,
        enabled: true,
        editable: true,
        value: ""
      });
    };
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        page.user = { count: 1, latestId: "user-new", latestText: "SPA prompt" };
      }
    };
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });
    const recovery = vi.fn();

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "SPA prompt",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0,
      onPreSubmitRecovery: recovery
    });

    expect(result.deliveryState).toBe("confirmed");
    expect(page.reloads).toBe(1);
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(page.dispatchClicks).toBe(1);
    expect(page.pressed).toEqual([]);
  });

  it("rechecks strong auth after recovery and never dispatches if reload signs out", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    let replaceComposer = true;
    page.elements.get("#prompt-textarea")!.onFill = () => {
      if (replaceComposer) {
        page.elements.set("#prompt-textarea", {
          visible: true,
          enabled: true,
          editable: true,
          value: ""
        });
      }
    };
    page.onReload = () => {
      replaceComposer = false;
      page.elements.delete('[data-testid="accounts-profile-button"]');
      page.elements.set('a[href*="/auth/login"]', {
        visible: true,
        enabled: true,
        label: "Log in"
      });
      page.elements.set("#prompt-textarea", {
        visible: true,
        enabled: true,
        editable: true,
        value: ""
      });
    };
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });

    await expect(executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "must remain authenticated",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0
    })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      context: {
        authState: "guest",
        deliveryState: "not-attempted"
      }
    });

    expect(page.reloads).toBe(1);
    expect(page.dispatchClicks).toBe(0);
    expect(page.pressed).toEqual([]);
  });

  it("hands authentication off and resumes when recovery reloads into a guest page", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    let replaceComposer = true;
    page.elements.get("#prompt-textarea")!.onFill = () => {
      if (replaceComposer) {
        page.elements.set("#prompt-textarea", {
          visible: true,
          enabled: true,
          editable: true,
          value: ""
        });
      }
    };
    page.onReload = () => {
      replaceComposer = false;
      page.elements.delete('[data-testid="accounts-profile-button"]');
      page.elements.set('a[href*="/auth/login"]', {
        visible: true,
        enabled: true,
        label: "Log in"
      });
      page.elements.set("#prompt-textarea", {
        visible: true,
        enabled: true,
        editable: true,
        value: ""
      });
    };
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        page.user = { count: 1, latestId: "user-after-recovery-auth", latestText: "resume safely" };
      }
    };
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });
    const handoff = vi.fn(async (waitForReady: () => Promise<unknown>) => {
      page.elements.delete('a[href*="/auth/login"]');
      page.elements.set('[data-testid="accounts-profile-button"]', {
        visible: true,
        enabled: true
      });
      await waitForReady();
    });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "resume safely",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0,
      onAuthHandoff: handoff
    });

    expect(result.deliveryState).toBe("confirmed");
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(page.reloads).toBe(1);
    expect(page.dispatchClicks).toBe(1);
    expect(page.pressed).toEqual([]);
  });

  it("preselects Enter only when no actionable click strategy exists", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.delete('button[data-testid="send-button"]');
    page.elements.get("#prompt-textarea")!.onPress = (key) => {
      if (key === "Enter") {
        page.user = { count: 1, latestId: "user-enter", latestText: "enter only" };
      }
    };
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "enter only",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0
    });

    expect(result).toMatchObject({
      deliveryState: "confirmed",
      dispatchStrategy: "chatgpt.composer-enter"
    });
    expect(page.dispatchClicks).toBe(0);
    expect(page.pressed).toEqual(["Enter"]);
  });

  it("observes after a post-click throw without replaying and persists before response wait", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.currentUrl = "https://chatgpt.com/c/post-click";
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        page.user = { count: 1, latestId: "user-post-click", latestText: "once" };
        throw new Error("context destroyed after click");
      }
    };
    const order: string[] = [];
    const { adapter, waitForAssistantCompletion } = adapterFor(page, {
      draftVerificationMs: 0,
      onWaitForResponse: () => order.push("response")
    });
    const uncertain = vi.fn(() => {
      order.push("uncertain");
    });
    const confirmed = vi.fn(async () => {
      order.push("confirmed");
      throw new Error("best-effort save failed");
    });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "once",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0,
      onSubmissionUncertain: uncertain,
      onSubmissionConfirmed: confirmed
    });

    expect(result).toMatchObject({
      deliveryState: "confirmed",
      dispatchStrategy: "chatgpt.send-testid",
      response: { text: "fixture answer", timedOut: false }
    });
    expect(page.dispatchClicks).toBe(1);
    expect(page.pressed).toEqual([]);
    expect(uncertain).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(waitForAssistantCompletion).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["uncertain", "confirmed", "response"]);
  });

  it("contains an uncertainty-hook throw after a post-click throw and never replays", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        page.user = { count: 1, latestId: "user-post-click-hook", latestText: "once" };
        throw new Error("context destroyed after click");
      }
    };
    const { adapter, waitForAssistantCompletion } = adapterFor(page, {
      draftVerificationMs: 0
    });
    const uncertain = vi.fn(() => {
      throw new Error("stderr renderer unavailable");
    });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "once",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0,
      onSubmissionUncertain: uncertain
    });

    expect(result.deliveryState).toBe("confirmed");
    expect(page.dispatchClicks).toBe(1);
    expect(page.pressed).toEqual([]);
    expect(uncertain).toHaveBeenCalledTimes(1);
    expect(waitForAssistantCompletion).toHaveBeenCalledTimes(1);
  });

  it("persists a conversation URL that appears after strong turn confirmation", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        page.user = { count: 1, latestId: "user-before-navigation", latestText: "navigate" };
      }
    };
    const order: string[] = [];
    const { adapter } = adapterFor(page, {
      draftVerificationMs: 0,
      onWaitForResponse: async () => {
        page.currentUrl = "https://chatgpt.com/c/late-navigation";
        order.push("url-created");
        await new Promise<void>((resolve) => setTimeout(resolve, 35));
        order.push("response-complete");
      }
    });
    const confirmed = vi.fn(async (conversationUrl: string) => {
      order.push(`saved:${conversationUrl}`);
    });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "navigate",
      attachments: [],
      timeoutMs: 150,
      submissionPollMs: 0,
      onSubmissionConfirmed: confirmed
    });

    expect(result.deliveryState).toBe("confirmed");
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalledWith("https://chatgpt.com/c/late-navigation");
    expect(order).toEqual([
      "url-created",
      "saved:https://chatgpt.com/c/late-navigation",
      "response-complete"
    ]);
    expect(page.dispatchClicks).toBe(1);
  });

  it("keeps observing a delayed submission and still dispatches only once", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.onWait = () => {
      if (page.waits >= 2) {
        page.user = { count: 1, latestId: "user-delayed", latestText: "delayed" };
      }
    };
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });
    const uncertain = vi.fn();

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "delayed",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 1,
      submissionConfirmationMs: 0,
      onSubmissionUncertain: uncertain
    });

    expect(result.deliveryState).toBe("confirmed");
    expect(page.dispatchClicks).toBe(1);
    expect(uncertain).toHaveBeenCalledTimes(1);
  });

  it("arms delivery protection before click and reclaims it after delayed confirmation", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    const order: string[] = [];
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        order.push("click");
      }
    };
    page.onWait = () => {
      if (page.waits >= 2) {
        page.user = { count: 1, latestId: "user-armed-delayed", latestText: "delayed" };
      }
    };
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "delayed",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 1,
      submissionConfirmationMs: 0,
      onBeforeDispatch: () => {
        order.push("armed");
      },
      onDeliveryConfirmed: () => {
        order.push("reclaimed");
      }
    });

    expect(result.deliveryState).toBe("confirmed");
    expect(page.dispatchClicks).toBe(1);
    expect(order).toEqual(["armed", "click", "reclaimed"]);
  });

  it("does not consume the dispatch permit when arming protection fails", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });

    await expect(executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "must not click",
      attachments: [],
      timeoutMs: 100,
      onBeforeDispatch: () => {
        throw new Error("marker persistence unavailable");
      }
    })).rejects.toThrow("marker persistence unavailable");
    expect(page.dispatchClicks).toBe(0);
  });

  it.each([
    { label: "unchanged identity", advanceTurn: false, expectedDelivery: "unknown" },
    { label: "new turn identity/count", advanceTurn: true, expectedDelivery: "confirmed" }
  ] as const)(
    "uses turn identity rather than identical prompt text alone: $label",
    async ({ advanceTurn, expectedDelivery }) => {
      const page = new FixturePage();
      installReadyZhTwFixture(page);
      page.user = { count: 1, latestId: "user-original", latestText: "repeat" };
      page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
        if (!trial && advanceTurn) {
          page.user = { count: 2, latestId: "user-repeated", latestText: "repeat" };
        }
      };
      const { adapter } = adapterFor(page, { draftVerificationMs: 0 });

      const result = await executeProviderPrompt(page as unknown as Page, adapter, {
        prompt: "repeat",
        attachments: [],
        timeoutMs: advanceTurn ? 100 : 10,
        submissionPollMs: 0,
        submissionConfirmationMs: 0
      });

      expect(result.deliveryState).toBe(expectedDelivery);
      expect(page.dispatchClicks).toBe(1);
      expect(page.pressed).toEqual([]);
    }
  );

  it("accepts a new assistant turn as a strong submission signal", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        page.assistant = {
          count: 1,
          latestId: "assistant-started",
          latestText: "Starting"
        };
      }
    };
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "assistant signal",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0
    });

    expect(result.deliveryState).toBe("confirmed");
    expect(result.evidence).toContainEqual(expect.objectContaining({
      name: "chatgpt.assistant-turn-started",
      strength: "strong"
    }));
    expect(page.dispatchClicks).toBe(1);
  });

  it("combines conversation navigation and draft clearing as independent weak signals", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        page.currentUrl = "https://chatgpt.com/c/weak-signals";
        page.elements.get("#prompt-textarea")!.value = "";
      }
    };
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "weak signals",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0
    });

    expect(result.deliveryState).toBe("confirmed");
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ independenceKey: "navigation", strength: "weak" }),
      expect.objectContaining({ independenceKey: "draft", strength: "weak" })
    ]));
    expect(page.dispatchClicks).toBe(1);
  });

  it("keeps observing when the uncertainty callback throws and never replays", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.onWait = () => {
      if (page.waits >= 2) {
        page.user = { count: 1, latestId: "user-after-hook-error", latestText: "once" };
      }
    };
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "once",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 1,
      submissionConfirmationMs: 0,
      onSubmissionUncertain: () => {
        throw new Error("renderer unavailable");
      }
    });

    expect(result.deliveryState).toBe("confirmed");
    expect(page.dispatchClicks).toBe(1);
    expect(page.pressed).toEqual([]);
  });

  it("treats repeated post-dispatch observation errors as unknown without replay", async () => {
    const page = new FixturePage();
    let dispatchCount = 0;
    const waitForResponse = vi.fn();
    const adapter = {
      provider: "chatgpt" as const,
      displayName: "ChatGPT",
      matchesConversationUrl: (value: string | undefined) => Boolean(value?.startsWith("https://chatgpt.com/c/")),
      discoverCapabilities: async () => ({
        url: page.url(),
        auth: { state: "signed-in-likely" as const, confidence: "strong" as const, evidence: [] },
        prompt: { available: true, strategy: "fixture.prompt", evidence: [] },
        attachment: { available: true, strategy: "fixture.attachment", evidence: [] },
        clickDispatch: { available: true, strategy: "fixture.send", evidence: [] },
        enterDispatch: { available: false, evidence: [] },
        response: { available: true, strategy: "fixture.response", evidence: [] },
        evidence: []
      }),
      attachAndVerify: async () => ({ files: [] }),
      fillAndVerifyDraft: async () => ({
        strategy: "fixture.prompt",
        text: "once",
        evidence: { name: "fixture.draft", claim: "prompt-input" as const, strength: "strong" as const }
      }),
      captureBaseline: async () => ({
        url: page.url(),
        user: { count: 0 },
        assistant: { count: 0 },
        busy: false
      }),
      preselectDispatch: async () => ({
        name: "fixture.send",
        kind: "click" as const,
        evidence: { name: "fixture.send", claim: "dispatch" as const, strength: "strong" as const },
        dispatch: async () => {
          dispatchCount += 1;
        }
      }),
      observeSubmission: async () => {
        throw new Error("document replaced");
      },
      waitForResponse
    };

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "once",
      attachments: [],
      timeoutMs: 10,
      submissionPollMs: 0,
      submissionConfirmationMs: 0
    });

    expect(result).toMatchObject({ deliveryState: "unknown", dispatchStrategy: "fixture.send" });
    expect(dispatchCount).toBe(1);
    expect(waitForResponse).not.toHaveBeenCalled();
  });

  it("marks response-observation failures after confirmation unsafe to resend", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.currentUrl = "https://chatgpt.com/c/confirmed";
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        page.user = { count: 1, latestId: "user-confirmed", latestText: "confirmed" };
      }
    };
    const adapter = createChatGptExecutionAdapter({
      automation: {
        attachFiles: vi.fn(async () => undefined),
        waitForAssistantCompletion: vi.fn(async () => {
          throw new Error("response observer failed");
        })
      },
      draftVerificationMs: 0,
      pollMs: 0
    });

    await expect(executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "confirmed",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0
    })).rejects.toMatchObject({
      code: "RESPONSE_NOT_DETECTED",
      stage: "response.wait",
      retryable: false,
      context: {
        deliveryState: "confirmed",
        conversationUrl: "https://chatgpt.com/c/confirmed"
      }
    });
    expect(page.dispatchClicks).toBe(1);
    expect(page.pressed).toEqual([]);
  });

  it("samples a new ChatGPT assistant turn when the normal response waiter hangs", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.currentUrl = "https://chatgpt.com/c/partial";
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        page.user = { count: 1, latestId: "user-partial", latestText: "partial" };
        page.assistant = {
          count: 1,
          latestId: "assistant-partial",
          latestText: "safe partial answer"
        };
      }
    };
    const adapter = createChatGptExecutionAdapter({
      automation: {
        attachFiles: vi.fn(async () => undefined),
        waitForAssistantCompletion: () => neverSettles()
      },
      draftVerificationMs: 0,
      pollMs: 0
    });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "partial",
      attachments: [],
      timeoutMs: 35,
      submissionPollMs: 0
    });

    expect(result).toMatchObject({
      deliveryState: "confirmed",
      response: { text: "safe partial answer", timedOut: true }
    });
    expect(page.dispatchClicks).toBe(1);
  });

  it("returns unknown for a no-op submission only at the deadline and never waits for a response", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    const { adapter, waitForAssistantCompletion } = adapterFor(page, { draftVerificationMs: 0 });
    const uncertain = vi.fn();
    const deadline = vi.fn();

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "no-op",
      attachments: [],
      timeoutMs: 10,
      submissionPollMs: 0,
      submissionConfirmationMs: 0,
      onSubmissionUncertain: uncertain,
      onDeadline: deadline
    });

    expect(result).toMatchObject({
      deliveryState: "unknown",
      dispatchStrategy: "chatgpt.send-testid"
    });
    expect(page.dispatchClicks).toBe(1);
    expect(page.pressed).toEqual([]);
    expect(uncertain).toHaveBeenCalledTimes(1);
    expect(deadline).toHaveBeenCalledWith(expect.objectContaining({ phase: "prompt.confirm" }));
    expect(waitForAssistantCompletion).not.toHaveBeenCalled();
  });

  it("lets an auth handoff clear a blocked verification fixture against the same deadline", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.delete('[data-testid="accounts-profile-button"]');
    page.elements.set('iframe[src*="challenges.cloudflare.com"]', { visible: true, enabled: true });
    page.elements.get('button[data-testid="send-button"]')!.onClick = (trial) => {
      if (!trial) {
        page.user = { count: 1, latestId: "user-after-auth", latestText: "verified" };
      }
    };
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });
    const handoff = vi.fn(async (waitForReady: () => Promise<unknown>, context: { remainingMs: number }) => {
      expect(context.remainingMs).toBeGreaterThan(0);
      page.elements.delete('iframe[src*="challenges.cloudflare.com"]');
      page.elements.set('[data-testid="accounts-profile-button"]', { visible: true, enabled: true });
      await waitForReady();
    });

    const result = await executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "verified",
      attachments: [],
      timeoutMs: 100,
      submissionPollMs: 0,
      onAuthHandoff: handoff
    });

    expect(result.deliveryState).toBe("confirmed");
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(page.dispatchClicks).toBe(1);
  });

  it("throws a structured blocked failure before dispatch when no handoff is available", async () => {
    const page = new FixturePage();
    installReadyZhTwFixture(page);
    page.elements.delete('[data-testid="accounts-profile-button"]');
    page.elements.set('iframe[src*="challenges.cloudflare.com"]', { visible: true, enabled: true });
    const { adapter } = adapterFor(page, { draftVerificationMs: 0 });

    await expect(executeProviderPrompt(page as unknown as Page, adapter, {
      prompt: "blocked",
      attachments: [],
      timeoutMs: 100
    })).rejects.toMatchObject({
      code: "PROVIDER_BLOCKED",
      stage: "readiness.discover",
      context: { deliveryState: "not-attempted" }
    });
    expect(page.actualClicks).toBe(0);
  });
});
