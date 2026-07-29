import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { ProviderDefinition } from "../src/providers";
import type { ExecutionQueue } from "../src/execution-queue";

const state = vi.hoisted(() => ({
  events: [] as string[],
  page: {
    bringToFront: vi.fn<() => Promise<void>>(async () => undefined),
    close: vi.fn<() => Promise<void>>(async () => undefined),
    screenshot: vi.fn<() => Promise<void>>(async () => undefined),
    content: vi.fn<() => Promise<string>>(async () => "<html></html>"),
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
  conversationLeaseRelease: vi.fn<() => Promise<void>>(async () => undefined),
  acquireBrowserLease: vi.fn(),
  acquireConversationLease: vi.fn(),
  forgetConversation: vi.fn<() => Promise<boolean>>(async () => true),
  rememberConversation: vi.fn<(
    provider: ProviderDefinition,
    page: Page,
    conversationName?: string
  ) => Promise<void>>(async () => undefined),
  resolveWait: undefined as undefined | ((value: { text: string; timedOut: boolean }) => void)
}));

vi.mock("../src/execution-queue", () => ({
  createExecutionQueue: vi.fn(() => ({
    acquire: vi.fn(async () => ({ id: "test-execution", release: vi.fn(async () => undefined) })),
    acquireBrowserLease: state.acquireBrowserLease,
    acquireConversationLease: state.acquireConversationLease,
    inspect: vi.fn(async () => ({ active: 0, queued: 0 })),
    assertNoActive: vi.fn(async () => undefined),
    assertConversationIdle: vi.fn(async () => undefined)
  }))
}));

vi.mock("../src/browser", () => {
  class ChromeSessionConflictError extends Error {}
  const connectToChrome = vi.fn(async () => state.browser);
  const inspectChromeSession = vi.fn(async () => ({
    port: 9222,
    connected: true,
    classification: { ownership: "ask-managed" },
    headless: false,
    browser: "Chrome/149.0.0.0",
    userAgent: "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36"
  }));
  const waitForRemoteDebugging = vi.fn();
  return {
    ChromeSessionConflictError,
    connectToChrome,
    createChromeSessionController: vi.fn(() => ({
      connect: connectToChrome,
      inspect: inspectChromeSession,
      waitUntilReady: waitForRemoteDebugging
    })),
    inspectChromeSession,
    waitForRemoteDebugging
  };
});

vi.mock("../src/conversations", () => {
  const readLastConversationUrl = vi.fn(async () => undefined as string | undefined);
  const writeLastConversationUrl = vi.fn(async () => undefined);
  return {
    createConversationContinuity: vi.fn(() => ({
      resolve: vi.fn(async (browser, provider, request) => {
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

import { ChromeSessionConflictError, connectToChrome, inspectChromeSession } from "../src/browser";
import { AskFailure } from "../src/errors";
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
    vi.clearAllMocks();
    state.acquireBrowserLease.mockResolvedValue({
      id: "test-browser",
      release: state.browserLeaseRelease
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
    state.page.url.mockImplementation(() => "https://chatgpt.com/");
    vi.mocked(inspectChromeSession).mockResolvedValue({
      port: 9222,
      connected: true,
      classification: { ownership: "ask-managed" },
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

  it("requires a visible ask-managed Chrome session for interactive login", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const app = new AskApp({ env });

    await app.login({ timeoutMs: 1000 });

    expect(connectToChrome).toHaveBeenCalledWith({
      headless: false,
      requireManaged: true,
      requireVisible: true,
      url: "https://chatgpt.com/",
      verbose: undefined
    });
    expect(openChatPage).toHaveBeenCalledWith(
      state.browser,
      expect.objectContaining({ name: "chatgpt" }),
      "https://chatgpt.com/"
    );
    expect(state.acquireBrowserLease).toHaveBeenCalledWith({
      headless: false,
      exclusive: true,
      action: "log in or change the shared Chrome session"
    });
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

    await expect(app.login({ headless: true, timeoutMs: 1000 })).rejects.toThrow("requires a visible browser");
    expect(connectToChrome).not.toHaveBeenCalled();
  });

  it("uses Gemini home URL for Gemini login", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const app = new AskApp({ env });

    await app.login({ provider: "gemini", timeoutMs: 1000 });

    expect(connectToChrome).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://gemini.google.com/app"
    }));
    expect(openChatPage).toHaveBeenCalledWith(
      state.browser,
      expect.objectContaining({ name: "gemini" }),
      "https://gemini.google.com/app"
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
      headless: undefined,
      launchIfNeeded: false,
      verbose: undefined
    });
    expect(inspectProviderPage).toHaveBeenCalledWith(state.page, 1000);
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
      pageCount: 1
    });
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

  it("classifies execution queue failures without attempting browser work", async () => {
    const queue: ExecutionQueue = {
      acquire: vi.fn(async () => {
        throw new Error("queue unavailable token=private-value");
      }),
      acquireBrowserLease: vi.fn(),
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

    await expect(app.ask({ prompt: "hi", attachments: [], headless: true, timeoutMs: 1000 })).rejects.toThrow("not ready for headless");
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
    await expect(app.ask({ provider: "gemini", prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toThrow(
      "ask login --provider gemini"
    );
    await expect(app.ask({ provider: "gemini", prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toThrow(
      "ask status --provider gemini"
    );
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

    await expect(app.ask({ prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toThrow("auth: guest");

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
      message: expect.stringContaining("message box was not found"),
      hint: expect.stringContaining("provider UI may have changed"),
      context: {
        providerHost: "chatgpt.com",
        authState: "signed-in-likely",
        promptInputVisible: false
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
        providerHost: "chatgpt.com",
        promptInputVisible: false
      }
    });
  });

  it("allows scheduled executions to coordinate a shared Chrome mode change", async () => {
    const release = vi.fn(async () => undefined);
    const queue: ExecutionQueue = {
      acquire: vi.fn(async () => ({ id: "lease", release })),
      acquireBrowserLease: vi.fn(async () => ({ id: "browser-lease", release: vi.fn(async () => undefined) })),
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
    expect(connectToChrome).toHaveBeenCalled();
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
      stage: "auth.inspect",
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

    expect(inspectProviderPage).not.toHaveBeenCalled();
    expect(fillPrompt).toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
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

    state.resolveWait?.({ text: "hello", timedOut: false });

    await expect(resultPromise).resolves.toEqual({ text: "hello", timedOut: false });
    expect(captureAssistantResponseBaseline).toHaveBeenCalledWith(state.page);
    expect(vi.mocked(captureAssistantResponseBaseline).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(submitPrompt).mock.invocationCallOrder[0]
    );
    expect(waitForAssistantCompletion).toHaveBeenCalledWith(
      state.page,
      {
        timeoutMs: 1000,
        baseline: { key: "old", text: "old answer", count: 1 }
      }
    );
    expect(state.events).toEqual(["wait-start", "wait-resolve", "close"]);
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
      conversationUrl: "https://chatgpt.com/c/abc123"
    });
  });

  it("stops and closes a timed-out execution without saving its conversation", async () => {
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
        context: {
          providerHost: "chatgpt.com"
        }
      }
    });
    expect(stopAssistantGeneration).toHaveBeenCalledWith(state.page);
    expect(state.rememberConversation).not.toHaveBeenCalled();
    expect(state.page.close).toHaveBeenCalledOnce();
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
        exitCode: 2
      }
    });
    expect(stopAssistantGeneration).toHaveBeenCalledWith(state.page);
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
    expect(state.page.close).toHaveBeenCalledOnce();
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
      "https://chatgpt.com/"
    );
  });
});
