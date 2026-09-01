import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { ProviderDefinition } from "../src/providers";
import type { ExecutionQueue } from "../src/execution-queue";

const state = vi.hoisted(() => ({
  events: [] as string[],
  cdpSend: vi.fn(),
  cdpDetach: vi.fn<() => Promise<void>>(async () => undefined),
  newCDPSession: vi.fn(),
  page: {
    bringToFront: vi.fn<() => Promise<void>>(async () => undefined),
    reload: vi.fn<() => Promise<void>>(async () => undefined),
    close: vi.fn<() => Promise<void>>(async () => undefined),
    screenshot: vi.fn<() => Promise<void>>(async () => undefined),
    content: vi.fn<() => Promise<string>>(async () => "<html></html>"),
    evaluate: vi.fn(async () => ({ left: 0, top: 0, width: 1920, height: 1080 })),
    waitForURL: vi.fn<(
      predicate: (url: URL) => boolean,
      options?: { timeout?: number }
    ) => Promise<void>>(async () => {
      throw new Error("no navigation");
    }),
    context: vi.fn(() => ({
      newCDPSession: state.newCDPSession
    })),
    url: vi.fn<() => string>(() => "https://chatgpt.com/")
  },
  browser: {
    close: vi.fn<() => Promise<void>>(),
    contexts: vi.fn(() => [
      {
        pages: () => [state.page]
      }
    ])
  },
  input: {},
  namedConversationExists: true,
  browserLeaseRelease: vi.fn<() => Promise<void>>(async () => undefined),
  readinessLeaseRelease: vi.fn<() => Promise<void>>(async () => undefined),
  conversationLeaseRelease: vi.fn<() => Promise<void>>(async () => undefined),
  acquireBrowserLease: vi.fn(),
  acquireProviderReadinessLease: vi.fn(),
  acquireConversationLease: vi.fn(),
  resolveConversation: vi.fn(),
  forgetConversation: vi.fn<() => Promise<boolean>>(async () => true),
  rememberConversation: vi.fn<(
    provider: ProviderDefinition,
    page: Page,
    conversationName?: string
  ) => Promise<void>>(async () => undefined),
  coordinatorMode: "confirmed" as "confirmed" | "unknown" | "delayed-confirmed",
  resolveWait: undefined as undefined | ((value: { text: string; timedOut: boolean }) => void)
}));

vi.mock("../src/execution-queue", () => ({
  createExecutionQueue: vi.fn(() => ({
    acquire: vi.fn(async () => ({ id: "test-execution", release: vi.fn(async () => undefined) })),
    acquireBrowserLease: state.acquireBrowserLease,
    acquireProviderReadinessLease: state.acquireProviderReadinessLease,
    acquireConversationLease: state.acquireConversationLease,
    inspect: vi.fn(async () => ({ active: 0, queued: 0 })),
    assertNoActive: vi.fn(async () => undefined),
    assertConversationIdle: vi.fn(async () => undefined)
  }))
}));

vi.mock("../src/browser", () => {
  class ChromeSessionConflictError extends Error {}
  class ChromeSessionConfigMismatchError extends Error {}
  const connectToChrome = vi.fn(async () => state.browser);
  const inspectChromeSession = vi.fn(async () => ({
    port: 9222,
    connected: true,
    classification: { ownership: "ask-managed", state: { generation: "mock-session-generation" } },
    managedSession: { generation: "mock-session-generation" },
    headless: false,
    browser: "Chrome/149.0.0.0",
    userAgent: "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36"
  }));
  const waitForRemoteDebugging = vi.fn();
  const authenticateChromeProfile = vi.fn(async () => undefined);
  const closeChromeSession = vi.fn(async () => state.cdpSend("Browser.close"));
  return {
    ChromeSessionConflictError,
    ChromeSessionConfigMismatchError,
    authenticateChromeProfile,
    connectToChrome,
    createChromeSessionController: vi.fn(() => ({
      connect: connectToChrome,
      inspect: inspectChromeSession,
      close: closeChromeSession,
      waitUntilReady: waitForRemoteDebugging
    })),
    inspectChromeSession,
    closeChromeSession,
    waitForRemoteDebugging
  };
});

vi.mock("../src/delivery-ambiguity", () => {
  class DeliveryAmbiguityPersistenceError extends Error {}
  return {
    DeliveryAmbiguityPersistenceError,
    recordDeliveryAmbiguity: vi.fn(async () => ({
      version: 1,
      provider: "chatgpt",
      targetId: "mock-target",
      sessionGeneration: "mock-generation",
      createdAt: new Date().toISOString(),
      fileName: "ambiguity-00000000-0000-4000-8000-000000000000.json"
    })),
    reclaimDeliveryAmbiguityMarkerUnderLock: vi.fn(async () => undefined)
  };
});

vi.mock("../src/conversations", () => {
  const readLastConversationUrl = vi.fn(async () => undefined as string | undefined);
  const writeLastConversationUrl = vi.fn(async () => undefined);
  return {
    createConversationContinuity: vi.fn(() => ({
      resolve: state.resolveConversation.mockImplementation(async (browser, provider, request) => {
        const savedUrl = await readLastConversationUrl();
        const preferredUrl = savedUrl && provider.matchesConversationUrl(savedUrl) ? savedUrl : undefined;
        if (request.conversationName) {
          const newSession = request.newSession === true || !state.namedConversationExists;
          return {
            newSession,
            url: newSession ? provider.homeUrl : (preferredUrl || provider.homeUrl),
            preferredUrl,
            conversationName: request.conversationName
          };
        }
        if (request.newSession !== false) {
          return { newSession: request.newSession, url: request.requestedUrl, preferredUrl };
        }
        if (provider.matchesConversationUrl(request.requestedUrl)) {
          return { newSession: false, url: request.requestedUrl, preferredUrl };
        }
        if (preferredUrl) {
          return { newSession: false, url: preferredUrl, preferredUrl };
        }
        const pages = browser.contexts().flatMap((context: { pages(): Array<{ url(): string }> }) => context.pages());
        const page = pages.find((candidate: { url(): string }) => provider.matchesConversationUrl(candidate.url()));
        if (page) {
          return { newSession: false, url: page.url(), preferredUrl: page.url() };
        }
        request.onContinuationUnavailable?.();
        return { newSession: true, url: provider.homeUrl };
      }),
      preferredUrl: vi.fn(async (provider) => {
        const savedUrl = await readLastConversationUrl();
        return savedUrl && provider.matchesConversationUrl(savedUrl) ? savedUrl : undefined;
      }),
      remember: state.rememberConversation.mockImplementation(async (provider, page) => {
        if (provider.matchesConversationUrl(page.url())) {
          await writeLastConversationUrl();
        }
      }),
      list: vi.fn(async () => []),
      forget: state.forgetConversation
    })),
    readLastConversationUrl,
    writeLastConversationUrl
  };
});

vi.mock("../src/webchat", () => {
  const attachFiles = vi.fn(async () => undefined);
  const captureAssistantResponseBaseline = vi.fn(async () => ({ key: "old", text: "old answer", count: 1 }));
  const extractLatestAssistantText = vi.fn(async () => "latest");
  const fillPrompt = vi.fn(async () => state.input);
  const inspectProviderPage = vi.fn(async () => ({
    promptInputVisible: true,
    authState: "signed-in-likely",
    readyToSend: true,
    readyForHeadless: true
  }));
  const submitPrompt = vi.fn(async () => undefined);
  const stopAssistantGeneration = vi.fn(async () => undefined);
  const waitForAssistantCompletion = vi.fn(
    () =>
      new Promise<{ text: string; timedOut: boolean }>((resolve) => {
        state.events.push("wait-start");
        state.resolveWait = (value) => {
          state.events.push("wait-resolve");
          resolve(value);
        };
      })
  );
  return {
    attachFiles,
    captureAssistantResponseBaseline,
    createProviderAutomation: vi.fn(() => ({
      inspectPage: inspectProviderPage,
      attachFiles,
      fillPrompt,
      submitPrompt,
      extractLatestAssistantText,
      captureAssistantResponseBaseline,
      waitForAssistantCompletion,
      stopAssistantGeneration
    })),
    extractLatestAssistantText,
    fillPrompt,
    inspectProviderPage,
    openChatPage: vi.fn(async () => state.page),
    openWorkerPage: vi.fn(async () => state.page),
    selectCurrentPage: vi.fn(() => state.page),
    submitPrompt,
    stopAssistantGeneration,
    waitForAssistantCompletion
  };
});

vi.mock("../src/provider-execution", async () => {
  const { AskFailure } = await import("../src/errors");
  const inputs = new WeakMap<object, object>();
  const capability = (available: boolean, strategy?: string) => ({
    available,
    ...(strategy ? { strategy } : {}),
    evidence: []
  });
  const createExecutionAdapter = (
    provider: "chatgpt" | "gemini",
    displayName: "ChatGPT" | "Gemini",
    { automation }: { automation: ProviderDefinition["automation"] }
  ) => ({
    provider,
    displayName,
    matchesConversationUrl: (value: string | undefined) => provider === "chatgpt"
      ? Boolean(value?.startsWith("https://chatgpt.com/c/"))
      : Boolean(value?.startsWith("https://gemini.google.com/app/")),
    discoverCapabilities: async (page: Page) => {
      const inspection = await automation.inspectPage(page, 1_000);
      const signedIn = inspection.authState === "signed-in-likely";
      return {
        url: page.url(),
        auth: {
          state: inspection.authState,
          confidence: signedIn ? "strong" as const : "none" as const,
          evidence: []
        },
        prompt: capability(inspection.promptInputVisible, "test.prompt"),
        attachment: capability(true, "test.attachment"),
        clickDispatch: capability(inspection.readyToSend, "test.send"),
        enterDispatch: capability(
          provider === "chatgpt" && inspection.promptInputVisible,
          provider === "chatgpt" ? "test.enter" : undefined
        ),
        response: capability(true, "test.response"),
        evidence: []
      };
    },
    attachAndVerify: async (page: Page, files: readonly string[], _deadlineAt: number) => {
      try {
        await automation.attachFiles(page, [...files]);
        return { files: [] };
      } catch (cause) {
        throw new AskFailure({
          code: "ATTACHMENT_UPLOAD_FAILED",
          stage: "attachment.upload",
            provider,
            providerDisplayName: displayName,
            message: `${displayName} could not attach the requested file.`,
          retryable: true,
          hint: "Check the attachment and retry.",
          cause,
          context: { deliveryState: "not-attempted" }
        });
      }
    },
    fillAndVerifyDraft: async (page: Page, prompt: string, _deadlineAt: number) => {
      try {
        const inspection = await automation.inspectPage(page);
        if (!inspection.promptInputVisible) {
          throw new AskFailure({
            code: "PROMPT_INPUT_NOT_FOUND",
            stage: "prompt.find",
            provider,
            providerDisplayName: displayName,
            message: `Could not find a visible ${displayName} message box.`,
            retryable: true,
            hint: "Inspect the provider page.",
            context: { promptInputVisible: false, deliveryState: "not-attempted" }
          });
        }
        const input = await automation.fillPrompt(page, prompt);
        inputs.set(page, input as object);
        return { strategy: "test.prompt", text: prompt, evidence: { name: "draft", claim: "prompt-input", strength: "strong" } };
      } catch (cause) {
        if (cause instanceof AskFailure) {
          throw cause;
        }
        throw new AskFailure({
          code: "PROMPT_INPUT_NOT_FOUND",
          stage: "prompt.find",
          provider,
          providerDisplayName: displayName,
          message: `Could not find a visible ${displayName} message box.`,
          retryable: true,
          hint: "Inspect the provider page.",
          cause,
          context: { deliveryState: "not-attempted" }
        });
      }
    },
    captureBaseline: async (page: Page) => {
      const baseline = await automation.captureAssistantResponseBaseline(page);
      return {
        url: page.url(),
        user: { count: 0 },
        assistant: { count: baseline.count, latestId: baseline.key, latestText: baseline.text },
        busy: false
      };
    },
    preselectDispatch: async (page: Page, _deadlineAt: number) => ({
      name: "test.send",
      kind: "click" as const,
      evidence: { name: "test.send", claim: "dispatch" as const, strength: "strong" as const },
      dispatch: async () => {
        try {
          await automation.submitPrompt(page, inputs.get(page) as never);
        } catch (cause) {
          throw new AskFailure({
            code: "PROMPT_SUBMIT_FAILED",
            stage: "prompt.submit",
            provider,
            providerDisplayName: displayName,
            message: `${displayName} did not accept the prompt.`,
            retryable: true,
            hint: "Retry after the composer settles.",
            cause,
            context: { deliveryState: "not-attempted" }
          });
        }
      }
    }),
    observeSubmission: async () => ({ evidence: [] }),
    waitForResponse: async (page: Page, options: { timeoutMs: number; baseline: { assistant: { latestId?: string; latestText?: string; count: number } } }) =>
      automation.waitForAssistantCompletion(page, {
        timeoutMs: options.timeoutMs,
        baseline: {
          key: options.baseline.assistant.latestId,
          text: options.baseline.assistant.latestText || "",
          count: options.baseline.assistant.count
        }
      }),
    recoverBeforeSubmit: async () => undefined
  });

  const createChatGptExecutionAdapter = (options: { automation: ProviderDefinition["automation"] }) =>
    createExecutionAdapter("chatgpt", "ChatGPT", options);
  const createGeminiExecutionAdapter = (options: { automation: ProviderDefinition["automation"] }) =>
    createExecutionAdapter("gemini", "Gemini", options);

  return {
    createChatGptExecutionAdapter,
    createGeminiExecutionAdapter,
    executeProviderPrompt: vi.fn(async (page: Page, adapter: ReturnType<typeof createExecutionAdapter>, options: {
      prompt: string;
      attachments: readonly string[];
      timeoutMs: number;
      onAuthHandoff?: (waitForReady: () => Promise<unknown>, context: { deadlineAt: number; remainingMs: number }) => Promise<void>;
      onBeforeDispatch?: (event: { dispatchStrategy: string; deadlineAt: number; remainingMs: number }) => Promise<void> | void;
      onSubmissionUncertain?: () => void;
      onDeliveryConfirmed?: (event: { dispatchStrategy: string; deadlineAt: number; remainingMs: number; conversationUrl: string; evidence: unknown[] }) => Promise<void> | void;
      onSubmissionConfirmed?: (url: string) => Promise<void> | void;
    }) => {
      let capabilities = await adapter.discoverCapabilities(page);
      if (capabilities.auth.state !== "signed-in-likely" || capabilities.auth.confidence !== "strong") {
        if (options.onAuthHandoff) {
          await options.onAuthHandoff(
            () => adapter.discoverCapabilities(page),
            { deadlineAt: Date.now() + options.timeoutMs, remainingMs: options.timeoutMs }
          );
          capabilities = await adapter.discoverCapabilities(page);
        }
        if (capabilities.auth.state !== "signed-in-likely" || capabilities.auth.confidence !== "strong") {
          const blocked = capabilities.auth.state === "blocked";
          const required = capabilities.auth.state === "guest" || capabilities.auth.state === "login-required";
          throw new AskFailure({
            code: blocked ? "PROVIDER_BLOCKED" : required ? "AUTH_REQUIRED" : "AUTH_UNCONFIRMED",
            stage: blocked ? "readiness.discover" : "auth.inspect",
            provider: adapter.provider,
            providerDisplayName: adapter.displayName,
            message: `${adapter.displayName} auth: ${capabilities.auth.state}.`,
            retryable: true,
            hint: blocked
              ? "Complete verification."
              : `Run \`ask login --provider ${adapter.provider}\`, then \`ask status --provider ${adapter.provider}\`.`,
            context: {
              authState: capabilities.auth.state,
              promptInputVisible: capabilities.prompt.available,
              deliveryState: "not-attempted"
            }
          });
        }
      }
      await adapter.attachAndVerify(page, options.attachments, Date.now() + options.timeoutMs);
      await adapter.fillAndVerifyDraft(page, options.prompt, Date.now() + options.timeoutMs);
      const dispatch = await adapter.preselectDispatch(page, Date.now() + options.timeoutMs);
      const baseline = await adapter.captureBaseline(page);
      await options.onBeforeDispatch?.({
        dispatchStrategy: dispatch.name,
        deadlineAt: Date.now() + options.timeoutMs,
        remainingMs: options.timeoutMs
      });
      await dispatch.dispatch();
      if (state.coordinatorMode === "unknown") {
        options.onSubmissionUncertain?.();
        return {
          deliveryState: "unknown" as const,
          conversationUrl: page.url(),
          dispatchStrategy: dispatch.name,
          evidence: []
        };
      }
      if (state.coordinatorMode === "delayed-confirmed") {
        options.onSubmissionUncertain?.();
      }
      await options.onDeliveryConfirmed?.({
        dispatchStrategy: dispatch.name,
        deadlineAt: Date.now() + options.timeoutMs,
        remainingMs: options.timeoutMs,
        conversationUrl: page.url(),
        evidence: []
      });
      await options.onSubmissionConfirmed?.(page.url());
      const response = await adapter.waitForResponse(page, { timeoutMs: options.timeoutMs, baseline });
      return {
        deliveryState: "confirmed" as const,
        conversationUrl: page.url(),
        dispatchStrategy: dispatch.name,
        evidence: [],
        response
      };
    })
  };
});

import {
  authenticateChromeProfile,
  ChromeSessionConfigMismatchError,
  ChromeSessionConflictError,
  connectToChrome,
  inspectChromeSession
} from "../src/browser";
import { AskFailure } from "../src/errors";
import {
  recordDeliveryAmbiguity,
  reclaimDeliveryAmbiguityMarkerUnderLock
} from "../src/delivery-ambiguity";
import { providerRegistry } from "../src/providers";
import { openChatPage, openWorkerPage } from "../src/webchat";
import { AskApp } from "../src/app";

const {
  attachFiles,
  captureAssistantResponseBaseline,
  fillPrompt,
  inspectPage: inspectProviderPage,
  stopAssistantGeneration,
  submitPrompt,
  waitForAssistantCompletion
} = providerRegistry.chatgpt.automation;

describe("AskApp", () => {
  beforeEach(() => {
    state.events = [];
    state.resolveWait = undefined;
    state.namedConversationExists = true;
    state.coordinatorMode = "confirmed";
    vi.clearAllMocks();
    state.cdpSend.mockImplementation(async (method: string) =>
      method === "Target.getTargetInfo" ? { targetInfo: { targetId: "mock-worker-target" } } :
      method === "Browser.getWindowForTarget" ? { windowId: 7 } : {}
    );
    state.newCDPSession.mockResolvedValue({
      send: state.cdpSend,
      detach: state.cdpDetach
    });
    state.acquireBrowserLease.mockResolvedValue({
      id: "test-browser",
      release: state.browserLeaseRelease
    });
    state.acquireProviderReadinessLease.mockResolvedValue({
      id: "test-readiness",
      release: state.readinessLeaseRelease
    });
    state.acquireConversationLease.mockResolvedValue({
      id: "test-conversation",
      release: state.conversationLeaseRelease
    });
    state.forgetConversation.mockResolvedValue(true);
    state.browser.close.mockImplementation(async () => {
      state.events.push("close");
    });
    state.browser.contexts.mockImplementation(() => [
      {
        pages: () => [state.page]
      }
    ]);
    state.page.screenshot.mockImplementation(async () => undefined);
    state.page.content.mockImplementation(async () => "<html></html>");
    state.page.evaluate.mockResolvedValue({ left: 0, top: 0, width: 1920, height: 1080 });
    state.page.waitForURL.mockImplementation(async () => {
      throw new Error("no navigation");
    });
    state.page.url.mockImplementation(() => "https://chatgpt.com/");
    vi.mocked(inspectChromeSession).mockResolvedValue({
      port: 9222,
      connected: true,
      classification: { ownership: "ask-managed", state: { generation: "mock-session-generation" } as never },
      managedSession: { generation: "mock-session-generation" } as never,
      headless: false,
      browser: "Chrome/149.0.0.0",
      userAgent: "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36"
    });
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: true,
      authState: "signed-in-likely",
      readyToSend: true,
      readyForHeadless: true
    });
  });

  it("authenticates in ordinary Chrome, then verifies and minimizes the managed profile", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const app = new AskApp({ env });

    await app.login({ timeoutMs: 1000 });

    expect(authenticateChromeProfile).toHaveBeenCalledWith({
      env,
      url: "https://chatgpt.com/",
      deadlineAt: expect.any(Number),
      verbose: undefined
    });
    expect(connectToChrome).toHaveBeenCalledWith({
      desiredMode: "visible",
      timeoutMs: expect.any(Number),
      requireManaged: true,
      url: "https://chatgpt.com/",
      verbose: undefined
    });
    expect(openChatPage).toHaveBeenCalledWith(
      state.browser,
      expect.objectContaining({ name: "chatgpt" }),
      "https://chatgpt.com/",
      { timeoutMs: expect.any(Number) }
    );
    expect(state.acquireBrowserLease).toHaveBeenCalledWith({
      headless: false,
      exclusive: true,
      waitForIdle: true,
      timeoutMs: 1000,
      action: "log in or change the shared Chrome session"
    });
    expect(state.cdpSend).toHaveBeenCalledWith("Browser.setWindowBounds", {
      windowId: 7,
      bounds: {
        windowState: "minimized"
      }
    });
    expect(state.browserLeaseRelease).toHaveBeenCalledOnce();
  });

  it("waits through transient setup readiness and treats background parking as best effort", async () => {
    vi.mocked(inspectProviderPage)
      .mockResolvedValueOnce({
        promptInputVisible: false,
        authState: "unknown",
        readyToSend: false,
        readyForHeadless: false
      })
      .mockResolvedValueOnce({
        promptInputVisible: true,
        authState: "signed-in-likely",
        readyToSend: true,
        readyForHeadless: true
      });
    state.newCDPSession.mockRejectedValueOnce(new Error("window API unavailable"));
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.setup({ timeoutMs: 1000 })).resolves.toBeUndefined();

    expect(inspectProviderPage).toHaveBeenCalledTimes(2);
    expect(state.browserLeaseRelease).toHaveBeenCalledOnce();
  });

  it("closes the managed verification browser when setup confirms login is still required", async () => {
    vi.mocked(inspectProviderPage).mockResolvedValueOnce({
      promptInputVisible: false,
      authState: "login-required",
      readyToSend: false,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.setup({ timeoutMs: 1000 })).rejects.toThrow("login-required");

    expect(state.cdpSend).toHaveBeenCalledWith("Browser.close");
    expect(state.browserLeaseRelease).toHaveBeenCalledOnce();
  });

  it("holds the conversation lease until forgetting the name finishes", async () => {
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.forgetConversation("release", "chatgpt")).resolves.toBe(true);

    expect(state.acquireConversationLease).toHaveBeenCalledWith("chatgpt", "release");
    expect(state.forgetConversation).toHaveBeenCalledWith("chatgpt", "release");
    expect(state.conversationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("rejects headless login because manual auth requires a visible browser", async () => {
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.login({ headless: true, timeoutMs: 1000 })).rejects.toThrow("requires a visible ordinary sign-in browser");
    expect(authenticateChromeProfile).not.toHaveBeenCalled();
    expect(connectToChrome).not.toHaveBeenCalled();
  });

  it("uses Gemini home URL for Gemini login", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const app = new AskApp({ env });

    await app.login({ provider: "gemini", timeoutMs: 1000 });

    expect(authenticateChromeProfile).toHaveBeenCalledWith(expect.objectContaining({
      env,
      url: "https://gemini.google.com/app"
    }));
    expect(connectToChrome).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://gemini.google.com/app"
    }));
    expect(openChatPage).toHaveBeenCalledWith(
      state.browser,
      expect.objectContaining({ name: "gemini" }),
      "https://gemini.google.com/app",
      { timeoutMs: expect.any(Number) }
    );
  });

  it("uses provider-specific screenshot prefixes", async () => {
    const env = { ASK_HOME: "D:\\tmp\\ask-app-test" } as NodeJS.ProcessEnv;
    const app = new AskApp({ env });

    const output = await app.screenshot(undefined, { provider: "gemini", timeoutMs: 1000 });

    expect(output).toMatch(/gemini-\d{8}-\d{6}\.png$/);
    expect(state.page.screenshot).toHaveBeenCalledWith({ path: output, fullPage: true });
  });

  it("reports no session in status without launching Chrome", async () => {
    vi.mocked(inspectChromeSession).mockResolvedValue({
      port: 9222,
      connected: false,
      classification: { ownership: "absent" }
    });
    const env = {} as NodeJS.ProcessEnv;
    const app = new AskApp({ env });

    const report = await app.status({ provider: "gemini", timeoutMs: 1000 });

    expect(report.session).toMatchObject({
      port: 9222,
      connected: false,
      sessionOwnership: "absent",
      pageCount: 0
    });
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]).toMatchObject({
      provider: "gemini",
      providerDisplayName: "Gemini",
      status: "not-running",
      providerPageCount: 0,
      messageBox: "not-checked",
      promptInputVisible: false,
      authState: "unknown",
      readyToSend: false,
      readyForHeadless: false,
      loggedInLikely: false
    });
    expect(connectToChrome).not.toHaveBeenCalled();
  });

  it("reports an unassigned automatic port before the first managed session", async () => {
    vi.mocked(inspectChromeSession).mockResolvedValue({
      portPolicy: "automatic",
      connected: false,
      classification: { ownership: "absent" }
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const report = await app.status({ provider: "chatgpt", timeoutMs: 1000 });

    expect(report.session).toMatchObject({
      port: undefined,
      portPolicy: "automatic",
      connected: false
    });
    expect(report.providers[0]?.note).toContain("No automatic Chrome debugging session exists yet");
    expect(connectToChrome).not.toHaveBeenCalled();
  });

  it("reports headless provider status from an ask-managed debugging session", async () => {
    vi.mocked(inspectChromeSession).mockResolvedValue({
      port: 9222,
      connected: true,
      classification: { ownership: "ask-managed" },
      headless: true,
      browser: "Chrome/149.0.0.0",
      userAgent: "Mozilla/5.0 HeadlessChrome/149.0.0.0 Safari/537.36"
    });
    state.page.url.mockImplementation(() => "https://gemini.google.com/app");
    const env = {} as NodeJS.ProcessEnv;
    const app = new AskApp({ env });

    const report = await app.status({ provider: "gemini", timeoutMs: 1000 });
    const status = report.providers[0];

    expect(connectToChrome).toHaveBeenCalledWith({
      desiredMode: "preserve",
      launchIfNeeded: false,
      timeoutMs: expect.any(Number),
      verbose: undefined
    });
    expect(inspectProviderPage).toHaveBeenCalledWith(state.page, expect.any(Number));
    const statusInspectionTimeout = vi.mocked(inspectProviderPage).mock.calls[0]?.[1];
    expect(statusInspectionTimeout).toBeGreaterThan(0);
    expect(statusInspectionTimeout).toBeLessThanOrEqual(1000);
    expect(status).toMatchObject({
      provider: "gemini",
      providerDisplayName: "Gemini",
      status: "ready",
      providerPageCount: 1,
      currentPageUrl: "https://gemini.google.com/app",
      messageBox: "available",
      promptInputVisible: true,
      authState: "signed-in-likely",
      readyToSend: true,
      readyForHeadless: true,
      loggedInLikely: true
    });
    expect(status?.note).toContain("Chrome is headless");
    expect(report.session).toMatchObject({
      connected: true,
      sessionOwnership: "ask-managed",
      headless: true,
      placement: "headless",
      pageCount: 1
    });
  });

  it("reports a minimized headed session through read-only window inspection", async () => {
    state.cdpSend.mockImplementation(async (method: string) => {
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 7 };
      }
      if (method === "Browser.getWindowBounds") {
        return {
          bounds: {
            windowState: "minimized"
          }
        };
      }
      return {};
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const report = await app.status({ provider: "chatgpt", timeoutMs: 1000 });

    expect(report.session.placement).toBe("background");
    expect(state.cdpSend).toHaveBeenCalledWith("Browser.getWindowForTarget");
    expect(state.cdpSend).toHaveBeenCalledWith("Browser.getWindowBounds", { windowId: 7 });
    expect(state.cdpSend.mock.calls.map(([method]) => method)).not.toContain("Browser.setWindowBounds");
    expect(state.page.bringToFront).not.toHaveBeenCalled();
    expect(openChatPage).not.toHaveBeenCalled();
    expect(openWorkerPage).not.toHaveBeenCalled();
  });

  it("reports visible when any inspected Chrome window is visible", async () => {
    state.cdpSend.mockImplementation(async (method: string) => {
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 7 };
      }
      if (method === "Browser.getWindowBounds") {
        return {
          bounds: {
            left: -10000,
            top: -10000,
            width: 800,
            height: 600,
            windowState: "normal"
          }
        };
      }
      return {};
    });
    const visibleSend = vi.fn(async (method: string) => {
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 8 };
      }
      if (method === "Browser.getWindowBounds") {
        return {
          bounds: {
            left: 80,
            top: 80,
            width: 1200,
            height: 800,
            windowState: "normal"
          }
        };
      }
      return {};
    });
    const visiblePage = {
      ...state.page,
      context: vi.fn(() => ({
        newCDPSession: vi.fn(async () => ({
          send: visibleSend,
          detach: vi.fn(async () => undefined)
        }))
      }))
    };
    state.browser.contexts.mockImplementation(() => [{
      pages: () => [state.page, visiblePage]
    }]);
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const report = await app.status({ provider: "chatgpt", timeoutMs: 1000 });

    expect(report.session.placement).toBe("visible");
    expect(state.page.evaluate).toHaveBeenCalled();
    expect(visibleSend).toHaveBeenCalledWith("Browser.getWindowForTarget");
    expect(visibleSend).toHaveBeenCalledWith("Browser.getWindowBounds", { windowId: 8 });
    expect(state.cdpSend.mock.calls.map(([method]) => method)).not.toContain("Browser.setWindowBounds");
  });

  it("reports placement as unknown when one headed window cannot be inspected", async () => {
    state.cdpSend.mockImplementation(async (method: string) => {
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 7 };
      }
      if (method === "Browser.getWindowBounds") {
        return {
          bounds: {
            left: -10000,
            top: -10000,
            width: 800,
            height: 600,
            windowState: "normal"
          }
        };
      }
      return {};
    });
    const unknownPage = {
      ...state.page,
      context: vi.fn(() => ({
        newCDPSession: vi.fn(async () => {
          throw new Error("window bounds unavailable");
        })
      }))
    };
    state.browser.contexts.mockImplementation(() => [{
      pages: () => [state.page, unknownPage]
    }]);
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const report = await app.status({ provider: "chatgpt", timeoutMs: 1000 });

    expect(report.session.placement).toBe("unknown");
    expect(state.cdpSend.mock.calls.map(([method]) => method)).not.toContain("Browser.setWindowBounds");
  });

  it("bounds coordinated provider capability discovery by the status timeout", async () => {
    vi.mocked(inspectProviderPage).mockImplementationOnce(
      () => new Promise<never>(() => undefined)
    );
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });
    const startedAt = Date.now();

    await expect(app.status({ provider: "chatgpt", timeoutMs: 25 })).rejects.toThrow(
      "command deadline expired during ChatGPT capability discovery"
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(state.browser.close).toHaveBeenCalledOnce();
  });

  it("does not claim the message box is missing when auth evidence is unknown", async () => {
    vi.mocked(inspectProviderPage).mockResolvedValueOnce({
      promptInputVisible: true,
      authState: "unknown",
      readyToSend: false,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const report = await app.status({ provider: "chatgpt", timeoutMs: 1000 });

    expect(report.providers[0]).toMatchObject({
      status: "not-ready",
      authState: "unknown",
      messageBox: "available"
    });
    expect(report.providers[0]?.note).toContain("has a message box");
    expect(report.providers[0]?.note).toContain("could not be confirmed");
  });

  it.each([
    {
      inspection: {
        promptInputVisible: false,
        authState: "login-required" as const,
        readyToSend: false,
        readyForHeadless: false
      },
      expected: "auth-required"
    },
    {
      inspection: {
        promptInputVisible: true,
        authState: "unknown" as const,
        readyToSend: false,
        readyForHeadless: false
      },
      expected: "auth-unconfirmed"
    },
    {
      inspection: {
        promptInputVisible: true,
        authState: "signed-in-likely" as const,
        readyToSend: true,
        readyForHeadless: true
      },
      expected: "ready"
    }
  ])("checks %s recovery readiness without foregrounding Chrome", async ({ inspection, expected }) => {
    vi.mocked(inspectProviderPage).mockResolvedValueOnce(inspection);
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.inspectProviderReadiness("chatgpt", 1000)).resolves.toBe(expected);

    expect(state.acquireBrowserLease).not.toHaveBeenCalled();
    expect(state.page.bringToFront).not.toHaveBeenCalled();
    expect(openChatPage).not.toHaveBeenCalled();
    expect(openWorkerPage).not.toHaveBeenCalled();
  });

  it("inspects all open providers in registry order with one browser connection", async () => {
    const geminiPage = {
      ...state.page,
      url: vi.fn(() => "https://gemini.google.com/app")
    };
    state.browser.contexts.mockImplementation(() => [
      {
        pages: () => [state.page, geminiPage]
      }
    ]);
    vi.mocked(inspectProviderPage)
      .mockResolvedValueOnce({
        promptInputVisible: true,
        authState: "signed-in-likely",
        readyToSend: true,
        readyForHeadless: true
      })
      .mockResolvedValueOnce({
        promptInputVisible: true,
        authState: "guest",
        readyToSend: true,
        readyForHeadless: false
      });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const report = await app.status({ timeoutMs: 1000 });

    expect(inspectChromeSession).toHaveBeenCalledOnce();
    expect(connectToChrome).toHaveBeenCalledOnce();
    expect(inspectProviderPage).toHaveBeenCalledTimes(2);
    expect(report.session.pageCount).toBe(2);
    expect(report.providers.map((provider) => provider.provider)).toEqual(["chatgpt", "gemini"]);
    expect(report.providers).toMatchObject([
      { status: "ready", messageBox: "available" },
      { status: "login-required", authState: "guest", messageBox: "available" }
    ]);
  });

  it("reports providers without an open page without navigating", async () => {
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const report = await app.status({ timeoutMs: 1000 });

    expect(openChatPage).not.toHaveBeenCalled();
    expect(openWorkerPage).not.toHaveBeenCalled();
    expect(report.providers).toMatchObject([
      { provider: "chatgpt", status: "ready", messageBox: "available" },
      { provider: "gemini", status: "not-open", messageBox: "not-checked" }
    ]);
  });

  it("classifies browser connection failures before opening a worker page", async () => {
    vi.mocked(connectToChrome).mockRejectedValueOnce(new Error("CDP unavailable"));
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({ prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toMatchObject({
      code: "BROWSER_UNAVAILABLE",
      stage: "browser.connect",
      provider: "chatgpt",
      detail: "CDP unavailable",
      context: {
        providerHost: "chatgpt.com"
      }
    });
    expect(openWorkerPage).not.toHaveBeenCalled();
  });

  it("distinguishes a conflicting Chrome session from an unavailable browser", async () => {
    vi.mocked(connectToChrome).mockRejectedValueOnce(new ChromeSessionConflictError("external session"));
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({ prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toMatchObject({
      code: "SESSION_CONFLICT",
      stage: "browser.connect",
      provider: "chatgpt",
      retryable: false,
      detail: "external session",
      hint: expect.stringContaining("ASK_REMOTE_DEBUGGING_PORT")
    });
  });

  it("reports a pinned-port mismatch without falling back or retrying", async () => {
    vi.mocked(connectToChrome).mockRejectedValueOnce(
      new ChromeSessionConfigMismatchError("live ask session uses another port")
    );
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({ prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toMatchObject({
      code: "SESSION_CONFIG_MISMATCH",
      stage: "browser.connect",
      provider: "chatgpt",
      retryable: false,
      detail: "live ask session uses another port"
    });
    expect(openWorkerPage).not.toHaveBeenCalled();
  });

  it("classifies execution queue failures without attempting browser work", async () => {
    const queue: ExecutionQueue = {
      acquire: vi.fn(async () => {
        throw new Error("queue unavailable token=private-value");
      }),
      acquireBrowserLease: vi.fn(),
      acquireProviderReadinessLease: vi.fn(),
      acquireConversationLease: vi.fn(),
      inspect: vi.fn(async () => ({ active: 4, queued: 4 })),
      assertNoActive: vi.fn(async () => undefined),
      assertConversationIdle: vi.fn(async () => undefined)
    };
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv, executionQueue: queue });

    await expect(app.ask({ prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
      stage: "queue.acquire",
      provider: "chatgpt",
      retryable: true,
      detail: "queue unavailable token=[redacted]"
    });
    expect(connectToChrome).not.toHaveBeenCalled();
  });

  it("does not inspect external sessions in status", async () => {
    vi.mocked(inspectChromeSession).mockResolvedValue({
      port: 9222,
      connected: true,
      classification: { ownership: "external", reason: "not ask" },
      headless: false,
      browser: "Chrome/149.0.0.0"
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const report = await app.status({ provider: "chatgpt", timeoutMs: 1000 });

    expect(report.session).toMatchObject({
      connected: true,
      sessionOwnership: "external",
      pageCount: 0
    });
    expect(report.providers[0]).toMatchObject({
      status: "session-conflict",
      providerPageCount: 0,
      authState: "unknown"
    });
    expect(connectToChrome).not.toHaveBeenCalled();
  });

  it("rejects headless prompts when provider auth is not confirmed", async () => {
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: true,
      authState: "guest",
      readyToSend: true,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({ prompt: "hi", attachments: [], headless: true, timeoutMs: 1000 })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      context: { deliveryState: "not-attempted" }
    });
    expect(state.acquireProviderReadinessLease).not.toHaveBeenCalled();
    expect(state.page.bringToFront).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "ask",
      run: (app: AskApp) => app.ask({
        prompt: "no remote auth handoff",
        attachments: [],
        timeoutMs: 1000,
        allowInteractiveAuth: true
      })
    },
    {
      name: "open --send",
      run: (app: AskApp) => app.open({
        url: "https://chatgpt.com/",
        prompt: "no remote auth handoff",
        attachments: [],
        send: true,
        timeoutMs: 1000,
        allowInteractiveAuth: true
      })
    }
  ])("fails %s authentication safely instead of foregrounding a controlled worker", async ({ run }) => {
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: false,
      authState: "login-required",
      readyToSend: false,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(run(app)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      stage: "auth.inspect",
      context: {
        deliveryState: "not-attempted",
        providerHost: "chatgpt.com"
      }
    });
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(state.acquireProviderReadinessLease).not.toHaveBeenCalled();
    expect(state.page.reload).not.toHaveBeenCalled();
    expect(state.page.bringToFront).not.toHaveBeenCalled();
    expect(state.page.close).toHaveBeenCalledOnce();
  });
  it("rejects visible prompts when the provider is a guest session", async () => {
    state.page.url.mockImplementation(() => "https://gemini.google.com/app");
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: true,
      authState: "guest",
      readyToSend: true,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({ provider: "gemini", prompt: "hi", attachments: ["shot.png"], timeoutMs: 1000 })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      stage: "auth.inspect",
      provider: "gemini",
      message: expect.stringContaining("auth: guest"),
      context: {
        providerHost: "gemini.google.com",
        authState: "guest",
        promptInputVisible: true
      }
    });
    await expect(app.ask({ provider: "gemini", prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toMatchObject({
      hint: expect.stringContaining("ask login --provider gemini")
    });
    await expect(app.ask({ provider: "gemini", prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toMatchObject({
      hint: expect.stringContaining("ask status --provider gemini")
    });
    expect(attachFiles).not.toHaveBeenCalled();
    expect(fillPrompt).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(waitForAssistantCompletion).not.toHaveBeenCalled();
  });

  it("releases the execution slot when prompt setup fails", async () => {
    const release = vi.fn(async () => undefined);
    const queue: ExecutionQueue = {
      acquire: vi.fn(async () => ({ id: "lease", release })),
      acquireBrowserLease: vi.fn(async () => ({ id: "browser-lease", release: vi.fn(async () => undefined) })),
      acquireProviderReadinessLease: vi.fn(async () => ({ id: "readiness-lease", release: vi.fn(async () => undefined) })),
      acquireConversationLease: vi.fn(async () => ({ id: "conversation-lease", release: vi.fn(async () => undefined) })),
      inspect: vi.fn(async () => ({ active: 1, queued: 0 })),
      assertNoActive: vi.fn(async () => undefined),
      assertConversationIdle: vi.fn(async () => undefined)
    };
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: true,
      authState: "guest",
      readyToSend: true,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv, executionQueue: queue });

    await expect(app.ask({ prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      context: { deliveryState: "not-attempted" }
    });

    expect(release).toHaveBeenCalledOnce();
    expect(state.page.close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "attachment upload",
      mock: attachFiles,
      code: "ATTACHMENT_UPLOAD_FAILED",
      stage: "attachment.upload"
    },
    {
      name: "message-box discovery",
      mock: fillPrompt,
      code: "PROMPT_INPUT_NOT_FOUND",
      stage: "prompt.find"
    },
    {
      name: "prompt submission",
      mock: submitPrompt,
      code: "PROMPT_SUBMIT_FAILED",
      stage: "prompt.submit"
    }
  ] as const)("classifies $name failures and still closes the worker page", async ({ mock, code, stage }) => {
    vi.mocked(mock).mockRejectedValueOnce(new Error("provider UI changed"));
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({ prompt: "hi", attachments: ["shot.png"], timeoutMs: 1000 })).rejects.toMatchObject({
      code,
      stage,
      provider: "chatgpt",
      context: {
        providerHost: "chatgpt.com"
      },
      hint: expect.any(String)
    });

    expect(state.page.close).toHaveBeenCalledOnce();
    expect(state.browser.close).toHaveBeenCalledOnce();
  });

  it("classifies a missing message box separately from authentication", async () => {
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: false,
      authState: "signed-in-likely",
      readyToSend: false,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const report = await app.status({ provider: "chatgpt", timeoutMs: 1000 });
    expect(report.providers[0]).toMatchObject({
      status: "not-ready",
      messageBox: "not-found",
      note: expect.stringContaining("message box was not found")
    });

    await expect(app.ask({ prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toMatchObject({
      code: "PROMPT_INPUT_NOT_FOUND",
      stage: "prompt.find",
      provider: "chatgpt",
      message: expect.stringContaining("message box"),
      hint: expect.any(String),
      context: {
        providerHost: "chatgpt.com",
        deliveryState: "not-attempted"
      }
    });
    expect(fillPrompt).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("adds application context to provider-originated structured failures", async () => {
    vi.mocked(fillPrompt).mockRejectedValueOnce(new AskFailure({
      code: "PROMPT_INPUT_NOT_FOUND",
      stage: "prompt.find",
      provider: "chatgpt",
      providerDisplayName: "ChatGPT",
      message: "Could not find a visible ChatGPT message box.",
      retryable: true,
      hint: "Inspect the provider page."
    }));
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({ prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toMatchObject({
      code: "PROMPT_INPUT_NOT_FOUND",
      stage: "prompt.find",
      context: {
        providerHost: "chatgpt.com"
      }
    });
  });

  it("allows scheduled executions to coordinate a shared Chrome mode change", async () => {
    const release = vi.fn(async () => undefined);
    const queue: ExecutionQueue = {
      acquire: vi.fn(async () => ({ id: "lease", release })),
      acquireBrowserLease: vi.fn(async () => ({ id: "browser-lease", release: vi.fn(async () => undefined) })),
      acquireProviderReadinessLease: vi.fn(async () => ({ id: "readiness-lease", release: vi.fn(async () => undefined) })),
      acquireConversationLease: vi.fn(async () => ({ id: "conversation-lease", release: vi.fn(async () => undefined) })),
      inspect: vi.fn(async () => ({ active: 2, queued: 0 })),
      assertNoActive: vi.fn(async () => undefined),
      assertConversationIdle: vi.fn(async () => undefined)
    };
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv, executionQueue: queue });

    const resultPromise = app.ask({ prompt: "hi", attachments: [], headless: true, timeoutMs: 1000 });
    await vi.waitFor(() => expect(state.resolveWait).toBeDefined());
    state.resolveWait?.({ text: "hello", timedOut: false });

    await expect(resultPromise).resolves.toMatchObject({ text: "hello" });
    expect(queue.acquire).toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
    expect(connectToChrome).toHaveBeenCalledWith(expect.objectContaining({
      desiredMode: "headless",
      timeoutMs: expect.any(Number)
    }));
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["login-required", "AUTH_REQUIRED"],
    ["blocked", "PROVIDER_BLOCKED"],
    ["unknown", "AUTH_UNCONFIRMED"]
  ] as const)("rejects visible prompts when provider auth is %s", async (authState, code) => {
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: authState !== "login-required",
      authState,
      readyToSend: authState !== "login-required",
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({ prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toMatchObject({
      code,
      stage: authState === "blocked" ? "readiness.discover" : "auth.inspect",
      provider: "chatgpt",
      hint: expect.stringContaining(authState === "blocked" ? "verification" : "ask login"),
      context: {
        providerHost: "chatgpt.com",
        authState,
        promptInputVisible: authState !== "login-required"
      }
    });
    expect(fillPrompt).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("requires signed-in auth before open --send mutates the page", async () => {
    state.page.url.mockImplementation(() => "https://gemini.google.com/app");
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: true,
      authState: "guest",
      readyToSend: true,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.open({ url: "https://gemini.google.com/app", provider: "gemini", prompt: "hi", attachments: ["shot.png"], send: true, timeoutMs: 1000 })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      stage: "auth.inspect",
      provider: "gemini",
      context: {
        providerHost: "gemini.google.com",
        authState: "guest",
        promptInputVisible: true
      }
    });
    expect(attachFiles).not.toHaveBeenCalled();
    expect(fillPrompt).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("does not require signed-in auth for open without --send", async () => {
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: true,
      authState: "guest",
      readyToSend: true,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await app.open({ url: "https://gemini.google.com/app", provider: "gemini", prompt: "hi", attachments: [], send: false, timeoutMs: 1000 });

    // Gemini now prepares open drafts through the same capability adapter as
    // send; this validates the composer without turning a non-send open into
    // an authentication gate.
    expect(inspectProviderPage).toHaveBeenCalled();
    expect(fillPrompt).toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(connectToChrome).toHaveBeenCalledWith(expect.objectContaining({
      desiredMode: "visible"
    }));
    expect(connectToChrome).not.toHaveBeenCalledWith(expect.objectContaining({ background: true }));
    expect(state.cdpSend).toHaveBeenCalledWith("Browser.setWindowBounds", {
      windowId: 7,
      bounds: {
        left: 80,
        top: 80,
        width: 1200,
        height: 800,
        windowState: "normal"
      }
    });
  });

  it("uses the legacy Gemini attachment path for open without --send", async () => {
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await app.open({
      url: "https://gemini.google.com/app",
      provider: "gemini",
      prompt: "draft with file",
      attachments: ["shot.png"],
      send: false,
      timeoutMs: 1000
    });

    expect(attachFiles).toHaveBeenCalledWith(state.page, ["shot.png"]);
    expect(fillPrompt).toHaveBeenCalledWith(state.page, "draft with file", expect.any(Number));
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("uses verified ChatGPT attachment and draft preparation for open without dispatch", async () => {
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: true,
      authState: "guest",
      readyToSend: true,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await app.open({
      url: "https://chatgpt.com/",
      provider: "chatgpt",
      prompt: "draft only",
      attachments: ["notes.txt"],
      send: false,
      timeoutMs: 1000
    });

    expect(attachFiles).toHaveBeenCalledWith(state.page, ["notes.txt"]);
    expect(fillPrompt).toHaveBeenCalledWith(state.page, "draft only");
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(state.acquireProviderReadinessLease).not.toHaveBeenCalled();
    expect(state.cdpSend).toHaveBeenCalledWith("Browser.setWindowBounds", {
      windowId: 7,
      bounds: {
        left: 80,
        top: 80,
        width: 1200,
        height: 800,
        windowState: "normal"
      }
    });
  });

  it("bounds verified draft preparation by the shared open deadline", async () => {
    vi.mocked(attachFiles).mockImplementationOnce(
      () => new Promise<void>(() => undefined)
    );
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });
    const startedAt = Date.now();

    await expect(app.open({
      url: "https://chatgpt.com/",
      provider: "chatgpt",
      prompt: "draft only",
      attachments: ["notes.txt"],
      send: false,
      timeoutMs: 35
    })).rejects.toMatchObject({
      code: "BROWSER_UNAVAILABLE",
      stage: "readiness.discover",
      context: { deliveryState: "not-attempted" }
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(state.browser.close).toHaveBeenCalledOnce();
  });

  it("bounds conversation resolution by the shared ask deadline", async () => {
    state.resolveConversation.mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });
    const startedAt = Date.now();

    await expect(app.ask({
      prompt: "hi",
      attachments: [],
      timeoutMs: 35
    })).rejects.toMatchObject({
      code: "CONVERSATION_STATE_FAILED",
      stage: "conversation.resolve"
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(openWorkerPage).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(state.browser.close).toHaveBeenCalledOnce();
  });

  it("requires --send when open creates a named conversation", async () => {
    state.namedConversationExists = false;
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.open({
      url: "https://chatgpt.com/",
      prompt: "hi",
      attachments: [],
      conversationName: "research",
      newSession: false,
      send: false,
      timeoutMs: 1000
    })).rejects.toThrow("Use `ask open --send --conversation <name> <prompt>`");

    expect(openChatPage).not.toHaveBeenCalled();
  });

  it("keeps the browser connection open until response polling finishes", async () => {
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const resultPromise = app.ask({
      prompt: "hi",
      attachments: [],
      timeoutMs: 1000
    });

    await vi.waitFor(() => {
      expect(state.resolveWait).toBeDefined();
    });

    expect(state.events).toEqual(["wait-start"]);
    const initialParkingCalls = state.cdpSend.mock.calls.filter(
      ([method]) => method === "Browser.setWindowBounds"
    );
    expect(initialParkingCalls).toHaveLength(2);
    expect(initialParkingCalls).toEqual(expect.arrayContaining([[
      "Browser.setWindowBounds",
      {
        windowId: 7,
        bounds: {
          windowState: "minimized"
        }
      }
    ]]));
    expect(connectToChrome).toHaveBeenCalledWith(expect.objectContaining({
      desiredMode: "preserve",
      background: true
    }));
    const initialParkingCall = state.cdpSend.mock.calls.findIndex(
      ([method]) => method === "Browser.setWindowBounds"
    );
    expect(state.cdpSend.mock.invocationCallOrder[initialParkingCall]).toBeLessThan(
      vi.mocked(fillPrompt).mock.invocationCallOrder[0]
    );

    state.resolveWait?.({ text: "hello", timedOut: false });

    await expect(resultPromise).resolves.toEqual({
      text: "hello",
      timedOut: false,
      deliveryState: "confirmed"
    });
    expect(captureAssistantResponseBaseline).toHaveBeenCalledWith(state.page);
    expect(vi.mocked(captureAssistantResponseBaseline).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(submitPrompt).mock.invocationCallOrder[0]
    );
    expect(waitForAssistantCompletion).toHaveBeenCalledWith(
      state.page,
      {
        timeoutMs: expect.any(Number),
        baseline: { key: "old", text: "old answer", count: 1 }
      }
    );
    const parkingCalls = state.cdpSend.mock.calls
      .map(([method], index) => ({ method, index }))
      .filter(({ method }) => method === "Browser.setWindowBounds");
    expect(parkingCalls).toHaveLength(3);
    const finalParkingCall = parkingCalls.at(-1)!.index;
    expect(vi.mocked(waitForAssistantCompletion).mock.invocationCallOrder[0]).toBeLessThan(
      state.cdpSend.mock.invocationCallOrder[finalParkingCall]
    );
    expect(state.events).toEqual(["wait-start", "wait-resolve", "close"]);
  });

  it.each([
    { provider: "chatgpt" as const, path: "ask", reused: true },
    { provider: "gemini" as const, path: "ask", reused: false },
    { provider: "chatgpt" as const, path: "open --send", reused: false },
    { provider: "gemini" as const, path: "open --send", reused: true }
  ])("keeps $provider $path minimized without foregrounding ($reused session)", async ({ provider, path, reused }) => {
    const url = provider === "chatgpt" ? "https://chatgpt.com/" : "https://gemini.google.com/app";
    state.page.url.mockImplementation(() => url);
    state.browser.contexts.mockImplementation(() => [{
      pages: () => reused ? [state.page] : []
    }]);
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });
    const execution = path === "ask"
      ? app.ask({ provider, prompt: "background send", attachments: [], timeoutMs: 1000 })
      : app.open({
          provider,
          url,
          prompt: "background send",
          attachments: [],
          send: true,
          timeoutMs: 1000
        });

    await vi.waitFor(() => expect(state.resolveWait).toBeDefined());
    state.resolveWait?.({ text: "done", timedOut: false });
    if (path === "ask") {
      await expect(execution).resolves.toMatchObject({ deliveryState: "confirmed" });
    } else {
      await expect(execution).resolves.toBeUndefined();
    }

    expect(connectToChrome).toHaveBeenCalledWith(expect.objectContaining({
      desiredMode: "preserve",
      background: true
    }));
    expect(state.page.bringToFront).not.toHaveBeenCalled();
    const placementWrites = state.cdpSend.mock.calls.filter(
      ([method]) => method === "Browser.setWindowBounds"
    );
    expect(placementWrites.length).toBeGreaterThanOrEqual(reused ? 3 : 2);
    for (const [, request] of placementWrites) {
      expect(request).toMatchObject({
        bounds: {
          windowState: "minimized"
        }
      });
    }
    const firstParkingCall = state.cdpSend.mock.calls.findIndex(
      ([method]) => method === "Browser.setWindowBounds"
    );
    expect(state.cdpSend.mock.invocationCallOrder[firstParkingCall]).toBeLessThan(
      vi.mocked(fillPrompt).mock.invocationCallOrder[0]
    );
    if (reused) {
      expect(state.cdpSend.mock.invocationCallOrder[firstParkingCall]).toBeLessThan(
        vi.mocked(openWorkerPage).mock.invocationCallOrder[0]
      );
    }
  });

  it("returns the final conversation URL with the response", async () => {
    state.page.url.mockImplementation(() => "https://chatgpt.com/c/abc123");
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const resultPromise = app.ask({
      prompt: "hi",
      attachments: [],
      timeoutMs: 1000
    });

    await vi.waitFor(() => expect(state.resolveWait).toBeDefined());
    state.resolveWait?.({ text: "hello", timedOut: false });

    await expect(resultPromise).resolves.toEqual({
      text: "hello",
      timedOut: false,
      deliveryState: "confirmed",
      conversationUrl: "https://chatgpt.com/c/abc123"
    });
  });

  it("persists a confirmed conversation URL before response completion", async () => {
    state.page.url.mockImplementation(() => "https://chatgpt.com/c/early-save");
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const resultPromise = app.ask({
      prompt: "save first",
      attachments: [],
      conversationName: "early-save",
      timeoutMs: 1000
    });
    await vi.waitFor(() => expect(state.resolveWait).toBeDefined());

    expect(state.rememberConversation).toHaveBeenCalledWith(
      expect.objectContaining({ name: "chatgpt" }),
      state.page,
      "early-save"
    );
    expect(state.browser.close).not.toHaveBeenCalled();

    state.resolveWait?.({ text: "saved", timedOut: false });
    await resultPromise;
  });

  it("waits for a post-confirmation SPA URL and saves it before response observation", async () => {
    let currentUrl = "https://chatgpt.com/";
    state.page.url.mockImplementation(() => currentUrl);
    state.page.waitForURL.mockImplementationOnce(async (predicate) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (!predicate(new URL(currentUrl))) {
        throw new Error("navigation did not match");
      }
    });
    vi.mocked(submitPrompt).mockImplementationOnce(async () => {
      setTimeout(() => {
        currentUrl = "https://chatgpt.com/c/late-navigation";
      }, 30);
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const resultPromise = app.ask({
      prompt: "save after navigation",
      attachments: [],
      conversationName: "late-navigation",
      timeoutMs: 1000
    });

    await vi.waitFor(() => {
      expect(state.rememberConversation).toHaveBeenCalledWith(
        expect.objectContaining({ name: "chatgpt" }),
        state.page,
        "late-navigation"
      );
    });
    expect(waitForAssistantCompletion).toHaveBeenCalledOnce();

    state.resolveWait?.({ text: "saved", timedOut: false });
    await expect(resultPromise).resolves.toMatchObject({
      conversationUrl: "https://chatgpt.com/c/late-navigation"
    });
    expect(
      vi.mocked(state.rememberConversation).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(waitForAssistantCompletion).mock.invocationCallOrder[0]);
  });

  it.each([
    { provider: "chatgpt" as const, conversationUrl: "https://chatgpt.com/c/uncertain" },
    { provider: "gemini" as const, conversationUrl: "https://gemini.google.com/app/uncertain" }
  ])("preserves the $provider worker tab and reports only safe context when delivery is unknown", async ({
    provider,
    conversationUrl
  }) => {
    state.coordinatorMode = "unknown";
    state.page.url.mockImplementation(() => conversationUrl);
    const onReadinessUpdate = vi.fn();
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });
    const prompt = "private prompt body must not leak";

    let failure: unknown;
    try {
      await app.ask({
        provider,
        prompt,
        attachments: [],
        timeoutMs: 1000,
        onReadinessUpdate
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "PROMPT_DELIVERY_UNKNOWN",
      stage: "prompt.confirm",
      exitCode: 1,
      retryable: false,
      context: {
        deliveryState: "unknown",
        conversationUrl,
        capability: "test.send"
      }
    });
    expect(JSON.stringify(failure)).not.toContain(prompt);
    expect(recordDeliveryAmbiguity).toHaveBeenCalledWith(expect.objectContaining({
      provider,
      knownConversationUrl: conversationUrl
    }));
    expect(JSON.stringify(vi.mocked(recordDeliveryAmbiguity).mock.calls)).not.toContain(prompt);
    expect(
      vi.mocked(recordDeliveryAmbiguity).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(submitPrompt).mock.invocationCallOrder[0]);
    expect(submitPrompt).toHaveBeenCalledOnce();
    expect(waitForAssistantCompletion).not.toHaveBeenCalled();
    expect(state.page.close).not.toHaveBeenCalled();
    expect(state.browser.close).toHaveBeenCalledOnce();
    expect(state.cdpSend.mock.calls.filter(([method]) => method === "Browser.setWindowBounds").at(-1)).toEqual([
      "Browser.setWindowBounds",
      {
        windowId: 7,
        bounds: {
          windowState: "minimized"
        }
      }
    ]);
    expect(onReadinessUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "submission-uncertain" })
    );
  });

  it("fails closed and preserves the worker tab when ambiguity persistence fails", async () => {
    state.coordinatorMode = "unknown";
    vi.mocked(recordDeliveryAmbiguity).mockRejectedValueOnce(new Error("marker storage unavailable"));
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({
      prompt: "never persist this prompt",
      attachments: [],
      timeoutMs: 1_000
    })).rejects.toMatchObject({
      code: "BROWSER_UNAVAILABLE",
      stage: "prompt.confirm",
      retryable: false,
      context: { deliveryState: "not-attempted" }
    });
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(state.page.close).not.toHaveBeenCalled();
    expect(state.browser.close).toHaveBeenCalledOnce();
  });

  it("pre-arms before dispatch and reclaims the marker after a delayed acknowledgement", async () => {
    state.coordinatorMode = "delayed-confirmed";
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });
    const resultPromise = app.ask({
      prompt: "delayed acknowledgement",
      attachments: [],
      timeoutMs: 1_000
    });

    await vi.waitFor(() => expect(reclaimDeliveryAmbiguityMarkerUnderLock).toHaveBeenCalledOnce());
    expect(recordDeliveryAmbiguity).toHaveBeenCalledOnce();
    expect(
      vi.mocked(recordDeliveryAmbiguity).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(submitPrompt).mock.invocationCallOrder[0]);
    expect(
      vi.mocked(reclaimDeliveryAmbiguityMarkerUnderLock).mock.invocationCallOrder[0]
    ).toBeGreaterThan(vi.mocked(submitPrompt).mock.invocationCallOrder[0]);

    state.resolveWait?.({ text: "confirmed after observation", timedOut: false });
    await expect(resultPromise).resolves.toMatchObject({ deliveryState: "confirmed" });
    expect(state.page.close).toHaveBeenCalledOnce();
  });

  it("saves, stops, and closes a confirmed timed-out execution", async () => {
    state.page.url.mockImplementation(() => "https://chatgpt.com/c/partial");
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const resultPromise = app.ask({
      prompt: "hi",
      attachments: [],
      conversationName: "partial",
      timeoutMs: 1000
    });

    await vi.waitFor(() => expect(state.resolveWait).toBeDefined());
    state.resolveWait?.({ text: "partial answer", timedOut: true });

    await expect(resultPromise).resolves.toMatchObject({
      text: "partial answer",
      timedOut: true,
      failure: {
        code: "RESPONSE_TIMEOUT",
        stage: "response.wait",
        provider: "chatgpt",
        exitCode: 2,
        retryable: false,
        hint: expect.stringContaining("do not resend"),
        context: {
          providerHost: "chatgpt.com",
          deliveryState: "confirmed",
          conversationUrl: "https://chatgpt.com/c/partial"
        }
      }
    });
    expect(stopAssistantGeneration).toHaveBeenCalledWith(state.page);
    expect(state.rememberConversation).toHaveBeenCalledWith(
      expect.objectContaining({ name: "chatgpt" }),
      state.page,
      "partial"
    );
    expect(state.page.close).toHaveBeenCalledOnce();
    expect(state.cdpSend.mock.calls.filter(([method]) => method === "Browser.setWindowBounds").at(-1)).toEqual([
      "Browser.setWindowBounds",
      {
        windowId: 7,
        bounds: {
          windowState: "minimized"
        }
      }
    ]);
  });

  it("does not let confirmed-timeout cleanup delay completion", async () => {
    let currentUrl = "https://chatgpt.com/";
    state.page.url.mockImplementation(() => currentUrl);
    vi.mocked(stopAssistantGeneration).mockImplementationOnce(
      () => new Promise<void>(() => undefined)
    );
    state.rememberConversation.mockImplementationOnce(
      () => new Promise<void>(() => undefined)
    );
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });
    const resultPromise = app.ask({
      prompt: "hi",
      attachments: [],
      conversationName: "partial",
      timeoutMs: 1000
    });

    await vi.waitFor(() => expect(state.resolveWait).toBeDefined());
    currentUrl = "https://chatgpt.com/c/bounded-cleanup";
    const cleanupStartedAt = Date.now();
    state.resolveWait?.({ text: "partial answer", timedOut: true });

    await expect(resultPromise).resolves.toMatchObject({
      timedOut: true,
      deliveryState: "confirmed",
      conversationUrl: "https://chatgpt.com/c/bounded-cleanup"
    });
    expect(Date.now() - cleanupStartedAt).toBeLessThan(500);
    expect(stopAssistantGeneration).toHaveBeenCalledWith(state.page);
    expect(state.rememberConversation).toHaveBeenCalledWith(
      expect.objectContaining({ name: "chatgpt" }),
      state.page,
      "partial"
    );
  });

  it("distinguishes a timeout with no detected response", async () => {
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const resultPromise = app.ask({
      prompt: "hi",
      attachments: [],
      timeoutMs: 1000
    });
    await vi.waitFor(() => expect(state.resolveWait).toBeDefined());
    state.resolveWait?.({ text: "", timedOut: true });

    await expect(resultPromise).resolves.toMatchObject({
      text: "",
      timedOut: true,
      failure: {
        code: "RESPONSE_NOT_DETECTED",
        stage: "response.wait",
        exitCode: 2,
        hint: expect.stringContaining("preserved ChatGPT tab")
      }
    });
    expect(stopAssistantGeneration).toHaveBeenCalledWith(state.page);
    expect(state.page.close).not.toHaveBeenCalled();
  });

  it("binds a named conversation after receiving a valid conversation URL", async () => {
    state.page.url.mockImplementation(() => "https://chatgpt.com/c/release");
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const resultPromise = app.ask({
      prompt: "hi",
      attachments: [],
      conversationName: "release-notes",
      newSession: false,
      timeoutMs: 1000
    });

    await vi.waitFor(() => expect(state.resolveWait).toBeDefined());
    state.resolveWait?.({ text: "hello", timedOut: false });
    await resultPromise;

    expect(state.rememberConversation).toHaveBeenCalledWith(
      expect.objectContaining({ name: "chatgpt" }),
      state.page,
      "release-notes"
    );
  });

  it("classifies conversation persistence failures after receiving a response", async () => {
    state.rememberConversation.mockRejectedValueOnce(new Error("local state unavailable"));
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const resultPromise = app.ask({
      prompt: "hi",
      attachments: [],
      conversationName: "release-notes",
      timeoutMs: 1000
    });
    await vi.waitFor(() => expect(state.resolveWait).toBeDefined());
    state.resolveWait?.({ text: "hello", timedOut: false });

    await expect(resultPromise).rejects.toMatchObject({
      code: "CONVERSATION_STATE_FAILED",
      stage: "conversation.save",
      retryable: false,
      context: {
        providerHost: "chatgpt.com"
      }
    });
    expect(state.page.close).not.toHaveBeenCalled();
  });

  it("starts a new conversation when continuation was requested but none exists", async () => {
    state.page.url.mockImplementation(() => "about:blank");
    const onContinuationUnavailable = vi.fn();
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    const resultPromise = app.ask({
      prompt: "hi",
      attachments: [],
      newSession: false,
      timeoutMs: 1000,
      onContinuationUnavailable
    });

    await vi.waitFor(() => expect(state.resolveWait).toBeDefined());
    state.resolveWait?.({ text: "hello", timedOut: false });
    await resultPromise;

    expect(onContinuationUnavailable).toHaveBeenCalledOnce();
    expect(openWorkerPage).toHaveBeenCalledWith(
      state.browser,
      expect.objectContaining({ name: "chatgpt" }),
      "https://chatgpt.com/",
      {
        timeoutMs: expect.any(Number),
        background: true,
        onPageCreated: expect.any(Function)
      }
    );
  });
});
