import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  page: {
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
  resolveWait: undefined as undefined | ((value: { text: string; timedOut: boolean }) => void)
}));

vi.mock("../src/browser", () => {
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
      remember: vi.fn(async (provider, page) => {
        if (provider.matchesConversationUrl(page.url())) {
          await writeLastConversationUrl();
        }
      })
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
      waitForAssistantCompletion
    })),
    extractLatestAssistantText,
    fillPrompt,
    inspectProviderPage,
    openChatPage: vi.fn(async () => state.page),
    openWorkerPage: vi.fn(async () => state.page),
    selectCurrentPage: vi.fn(() => state.page),
    submitPrompt,
    waitForAssistantCompletion
  };
});

import { connectToChrome, inspectChromeSession } from "../src/browser";
import { providerRegistry } from "../src/providers";
import { openChatPage, openWorkerPage } from "../src/webchat";
import { AskApp } from "../src/app";

const {
  attachFiles,
  captureAssistantResponseBaseline,
  fillPrompt,
  inspectPage: inspectProviderPage,
  submitPrompt,
  waitForAssistantCompletion
} = providerRegistry.chatgpt.automation;

describe("AskApp", () => {
  beforeEach(() => {
    state.events = [];
    state.resolveWait = undefined;
    vi.clearAllMocks();
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

    const status = await app.status({ provider: "gemini", timeoutMs: 1000 });

    expect(status).toMatchObject({
      provider: "gemini",
      providerDisplayName: "Gemini",
      port: 9222,
      connected: false,
      sessionOwnership: "absent",
      pageCount: 0,
      providerPageCount: 0,
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

    const status = await app.status({ provider: "gemini", timeoutMs: 1000 });

    expect(connectToChrome).toHaveBeenCalledWith({
      headless: undefined,
      launchIfNeeded: false,
      verbose: undefined
    });
    expect(inspectProviderPage).toHaveBeenCalledWith(state.page, 1000);
    expect(status).toMatchObject({
      provider: "gemini",
      providerDisplayName: "Gemini",
      connected: true,
      sessionOwnership: "ask-managed",
      headless: true,
      pageCount: 1,
      providerPageCount: 1,
      currentPageUrl: "https://gemini.google.com/app",
      promptInputVisible: true,
      authState: "signed-in-likely",
      readyToSend: true,
      readyForHeadless: true,
      loggedInLikely: true
    });
    expect(status.note).toContain("Chrome is headless");
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

    const status = await app.status({ provider: "chatgpt", timeoutMs: 1000 });

    expect(status).toMatchObject({
      connected: true,
      sessionOwnership: "external",
      pageCount: 0,
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
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: true,
      authState: "guest",
      readyToSend: true,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({ provider: "gemini", prompt: "hi", attachments: ["shot.png"], timeoutMs: 1000 })).rejects.toThrow(
      "Gemini is not ready to send from a signed-in session (auth: guest, prompt: found)."
    );
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

  it.each(["login-required", "blocked", "unknown"] as const)("rejects visible prompts when provider auth is %s", async (authState) => {
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: authState !== "login-required",
      authState,
      readyToSend: authState !== "login-required",
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.ask({ prompt: "hi", attachments: [], timeoutMs: 1000 })).rejects.toThrow(`auth: ${authState}`);
    expect(fillPrompt).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("requires signed-in auth before open --send mutates the page", async () => {
    vi.mocked(inspectProviderPage).mockResolvedValue({
      promptInputVisible: true,
      authState: "guest",
      readyToSend: true,
      readyForHeadless: false
    });
    const app = new AskApp({ env: {} as NodeJS.ProcessEnv });

    await expect(app.open({ url: "https://gemini.google.com/app", provider: "gemini", prompt: "hi", attachments: ["shot.png"], send: true, timeoutMs: 1000 })).rejects.toThrow("auth: guest");
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
      undefined
    );
  });
});
