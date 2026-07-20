import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { providerRegistry } from "../src/providers";
import {
  openChatPage,
  openWorkerPage,
  selectCurrentPage
} from "../src/webchat";

class FakeLocator {
  filled = "";
  clicked = false;
  files: string[] = [];
  fileCalls: string[][] = [];
  pressed: string[] = [];
  private enabledChecks = 0;

  constructor(
    private readonly options: {
      count?: number;
      visible?: boolean;
      enabled?: boolean;
      enabledAfterChecks?: number;
      fillThrows?: boolean;
      accept?: string;
      multiple?: boolean;
      setInputFilesThrows?: boolean;
      children?: FakeLocator[];
    } = {}
  ) {}

  last(): FakeLocator {
    return this.options.children?.at(-1) || this;
  }

  nth(index: number): FakeLocator {
    return this.options.children?.[index] || this;
  }

  async waitFor(): Promise<void> {
    if (this.options.visible === false) {
      throw new Error("not visible");
    }
  }

  async count(): Promise<number> {
    return this.options.children?.length ?? this.options.count ?? 1;
  }

  async isVisible(): Promise<boolean> {
    return this.options.visible !== false;
  }

  async isEnabled(): Promise<boolean> {
    if (this.options.enabledAfterChecks !== undefined) {
      const enabled = this.enabledChecks >= this.options.enabledAfterChecks;
      this.enabledChecks += 1;
      return enabled;
    }
    return this.options.enabled !== false;
  }

  async click(): Promise<void> {
    this.clicked = true;
  }

  async fill(value: string): Promise<void> {
    if (this.options.fillThrows) {
      throw new Error("fill unsupported");
    }
    this.filled = value;
  }

  async setInputFiles(files: string | string[]): Promise<void> {
    if (this.options.setInputFilesThrows) {
      throw new Error("provider rejected file");
    }
    this.files = Array.isArray(files) ? files : [files];
    this.fileCalls.push(this.files);
  }

  async getAttribute(name: string): Promise<string | null> {
    if (name === "accept") {
      return this.options.accept ?? null;
    }
    if (name === "multiple") {
      return this.options.multiple ? "" : null;
    }
    return null;
  }

  async press(key: string): Promise<void> {
    this.pressed.push(key);
  }
}

class FakePage {
  readonly locators = new Map<string, FakeLocator>();
  readonly keyboard = {
    pressed: [] as string[],
    inserted: [] as string[],
    press: async (key: string) => {
      this.keyboard.pressed.push(key);
    },
    insertText: async (text: string) => {
      this.keyboard.inserted.push(text);
    }
  };
  evaluateText = "";
  evaluateResults: unknown[] = [];
  broughtToFront = false;
  titleText = "";

  constructor(private currentUrl = "about:blank") {}

  url(): string {
    return this.currentUrl;
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }

  async bringToFront(): Promise<void> {
    this.broughtToFront = true;
  }

  async title(): Promise<string> {
    return this.titleText;
  }

  locator(selector: string): FakeLocator {
    return this.locators.get(selector) || new FakeLocator({ count: 0, visible: false, enabled: false });
  }

  getByRole(): FakeLocator {
    return this.locators.get("role:textbox") || new FakeLocator({ count: 0, visible: false, enabled: false });
  }

  async waitForTimeout(): Promise<void> {}

  async evaluate<Arg, Result>(fn?: (arg: Arg) => Result, arg?: Arg): Promise<Result | string> {
    if (this.evaluateResults.length > 0) {
      return this.evaluateResults.shift() as Result;
    }
    if (this.evaluateText) {
      return this.evaluateText;
    }
    if (typeof fn === "function") {
      return fn(arg as Arg);
    }
    return this.evaluateText;
  }
}

class FakeContext {
  createdPages = 0;

  constructor(private readonly pageList: FakePage[]) {}

  pages(): FakePage[] {
    return this.pageList;
  }

  async newPage(): Promise<FakePage> {
    this.createdPages += 1;
    const page = new FakePage();
    this.pageList.push(page);
    return page;
  }
}

class FakeBrowser {
  constructor(private readonly context: FakeContext) {}

  contexts(): FakeContext[] {
    return [this.context];
  }
}

describe("provider automation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-provider-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("reuses the launch blank page when opening ChatGPT", async () => {
    const blankPage = new FakePage();
    const context = new FakeContext([blankPage]);
    const browser = new FakeBrowser(context);

    const page = await openChatPage(browser as unknown as Browser, providerRegistry.chatgpt, "https://chatgpt.com/");

    expect(page).toBe(blankPage);
    expect(blankPage.url()).toBe("https://chatgpt.com/");
    expect(context.createdPages).toBe(0);
  });

  it("reuses an existing ChatGPT page when Chrome restores multiple tabs", async () => {
    const restoredPage = new FakePage("https://example.com/");
    const chatPage = new FakePage("https://chatgpt.com/");
    const context = new FakeContext([restoredPage, chatPage]);
    const browser = new FakeBrowser(context);

    const page = await openChatPage(browser as unknown as Browser, providerRegistry.chatgpt, "https://chatgpt.com/");

    expect(page).toBe(chatPage);
    expect(chatPage.broughtToFront).toBe(true);
    expect(context.createdPages).toBe(0);
  });

  it("creates a new page when a fresh ChatGPT session is requested", async () => {
    const blankPage = new FakePage();
    const chatPage = new FakePage("https://chatgpt.com/");
    const context = new FakeContext([blankPage, chatPage]);
    const browser = new FakeBrowser(context);

    const page = await openChatPage(browser as unknown as Browser, providerRegistry.chatgpt, "https://chatgpt.com/", { newSession: true });

    expect(page).not.toBe(blankPage);
    expect(page).not.toBe(chatPage);
    expect(page.url()).toBe("https://chatgpt.com/");
    expect(context.createdPages).toBe(1);
  });

  it("creates a dedicated worker page without foregrounding it", async () => {
    const worker = new FakePage("https://chatgpt.com/c/previous");
    const other = new FakePage("https://chatgpt.com/c/other");
    const context = new FakeContext([other, worker]);
    const browser = new FakeBrowser(context);

    const page = await openWorkerPage(
      browser as unknown as Browser,
      providerRegistry.chatgpt,
      "https://chatgpt.com/"
    );

    expect(page).not.toBe(worker);
    expect(page).not.toBe(other);
    expect(page.url()).toBe("https://chatgpt.com/");
    expect((page as unknown as FakePage).broughtToFront).toBe(false);
    expect(context.createdPages).toBe(1);
  });

  it("isolates repeated executions in separate worker pages", async () => {
    const worker = new FakePage("https://chatgpt.com/c/initial");
    const context = new FakeContext([worker]);
    const browser = new FakeBrowser(context);
    const pages = new Set<FakePage>();

    for (let index = 0; index < 4; index += 1) {
      const page = await openWorkerPage(
        browser as unknown as Browser,
        providerRegistry.chatgpt,
        "https://chatgpt.com/"
      );
      pages.add(page as unknown as FakePage);
    }

    expect(pages).toHaveLength(4);
    expect(context.createdPages).toBe(4);
    expect(worker.url()).toBe("https://chatgpt.com/c/initial");
  });

  it("reuses an existing Gemini page when Chrome restores multiple tabs", async () => {
    const restoredPage = new FakePage("https://example.com/");
    const geminiPage = new FakePage("https://gemini.google.com/app/abc123");
    const context = new FakeContext([restoredPage, geminiPage]);
    const browser = new FakeBrowser(context);

    const page = await openChatPage(
      browser as unknown as Browser,
      providerRegistry.gemini,
      providerRegistry.gemini.homeUrl
    );

    expect(page).toBe(geminiPage);
    expect(geminiPage.broughtToFront).toBe(true);
    expect(geminiPage.url()).toBe("https://gemini.google.com/app/abc123");
    expect(context.createdPages).toBe(0);
  });

  it("opens Gemini home URL on the launch blank page", async () => {
    const blankPage = new FakePage();
    const context = new FakeContext([blankPage]);
    const browser = new FakeBrowser(context);

    const page = await openChatPage(
      browser as unknown as Browser,
      providerRegistry.gemini,
      providerRegistry.gemini.homeUrl
    );

    expect(page).toBe(blankPage);
    expect(blankPage.url()).toBe("https://gemini.google.com/app");
    expect(context.createdPages).toBe(0);
  });

  it("recognizes provider verification pages from their title", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.titleText = "Just a moment...";

    const inspection = await providerRegistry.chatgpt.automation.inspectPage(page as unknown as Page, 10);

    expect(inspection.authState).toBe("blocked");
    expect(inspection.readyToSend).toBe(false);
  });

  it("selects the newest Gemini conversation when several are open", () => {
    const newest = new FakePage("https://gemini.google.com/app/newest");
    const oldest = new FakePage("https://gemini.google.com/app/oldest");
    const context = new FakeContext([newest, oldest]);
    const browser = new FakeBrowser(context);

    expect(selectCurrentPage(browser as unknown as Browser, providerRegistry.gemini)).toBe(newest);
  });

  it("fills the prompt input and clicks the send button", async () => {
    const page = new FakePage();
    const input = new FakeLocator();
    const sendButton = new FakeLocator();
    page.locators.set("#prompt-textarea", input);
    page.locators.set('button[data-testid="send-button"]', sendButton);

    const foundInput = await providerRegistry.chatgpt.automation.fillPrompt(page as unknown as Page, "Plan this");
    await providerRegistry.chatgpt.automation.submitPrompt(page as unknown as Page, foundInput);

    expect(input.clicked).toBe(true);
    expect(input.filled).toBe("Plan this");
    expect(sendButton.clicked).toBe(true);
  });

  it("skips a hidden Gemini input and immediately uses the visible fallback", async () => {
    const page = new FakePage();
    const hiddenInput = new FakeLocator({ visible: false });
    const visibleInput = new FakeLocator();
    page.locators.set('rich-textarea [contenteditable="true"]', hiddenInput);
    page.locators.set('[contenteditable="true"][aria-label*="Enter"]', visibleInput);

    const foundInput = await providerRegistry.gemini.automation.fillPrompt(page as unknown as Page, "Hello Gemini", 30_000);

    expect(foundInput).toBe(visibleInput);
    expect(visibleInput.filled).toBe("Hello Gemini");
  });

  it("falls back to keyboard insertion for rich text prompt inputs", async () => {
    const page = new FakePage();
    const input = new FakeLocator({ fillThrows: true });
    page.locators.set('rich-textarea [contenteditable="true"]', input);

    const foundInput = await providerRegistry.gemini.automation.fillPrompt(page as unknown as Page, "Plan this");

    expect(foundInput).toBe(input);
    expect(input.clicked).toBe(true);
    expect(page.keyboard.pressed).toEqual([process.platform === "darwin" ? "Meta+A" : "Control+A"]);
    expect(page.keyboard.inserted).toEqual(["Plan this"]);
  });
  it("treats attached Gemini account signals as signed in even when they are not visible", async () => {
    const page = new FakePage("https://gemini.google.com/app");
    page.locators.set('rich-textarea [contenteditable="true"]', new FakeLocator());
    page.locators.set('a[aria-label*="Google Account"]', new FakeLocator({ visible: false }));

    const inspection = await providerRegistry.gemini.automation.inspectPage(page as unknown as Page, 100);

    expect(inspection).toEqual({
      promptInputVisible: true,
      authState: "signed-in-likely",
      readyToSend: true,
      readyForHeadless: true
    });
  });
  it("treats ChatGPT profile menu signals as signed in", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.locators.set("#prompt-textarea", new FakeLocator());
    page.locators.set('[data-testid="accounts-profile-button"]', new FakeLocator());

    const inspection = await providerRegistry.chatgpt.automation.inspectPage(page as unknown as Page, 100);

    expect(inspection).toEqual({
      promptInputVisible: true,
      authState: "signed-in-likely",
      readyToSend: true,
      readyForHeadless: true
    });
  });

  it("falls back to pressing Enter when no send button is found", async () => {
    const page = new FakePage();
    const input = new FakeLocator();

    await providerRegistry.chatgpt.automation.submitPrompt(page as unknown as Page, input as never);

    expect(input.pressed).toEqual(["Enter"]);
  });

  it("waits for a disabled send button while an attachment is processing", async () => {
    const page = new FakePage();
    const input = new FakeLocator();
    const sendButton = new FakeLocator({ enabledAfterChecks: 2 });
    page.locators.set('button[data-testid="send-button"]', sendButton);

    await providerRegistry.chatgpt.automation.submitPrompt(page as unknown as Page, input as never, 1000);

    expect(sendButton.clicked).toBe(true);
    expect(input.pressed).toEqual([]);
  });

  it("uploads an image through an image-compatible file input", async () => {
    const page = new FakePage();
    const image = path.join(tempDir, "screenshot.png");
    await fs.promises.writeFile(image, "fake image", "utf8");
    const fileInput = new FakeLocator({ accept: "image/*" });
    page.locators.set('input[type="file"]', fileInput);

    await providerRegistry.chatgpt.automation.attachFiles(page as unknown as Page, [image]);

    expect(fileInput.files).toEqual([path.resolve(image)]);
  });

  it("prefers an unrestricted input for mixed document attachments", async () => {
    const page = new FakePage();
    const pdf = path.join(tempDir, "report.pdf");
    const text = path.join(tempDir, "notes.txt");
    await Promise.all([
      fs.promises.writeFile(pdf, "fake pdf", "utf8"),
      fs.promises.writeFile(text, "notes", "utf8")
    ]);
    const imageInput = new FakeLocator({ accept: "image/*", multiple: true });
    const unrestrictedInput = new FakeLocator({ multiple: true });
    page.locators.set('input[type="file"]', new FakeLocator({ children: [imageInput, unrestrictedInput] }));

    await providerRegistry.chatgpt.automation.attachFiles(page as unknown as Page, [pdf, text]);

    expect(imageInput.fileCalls).toEqual([]);
    expect(unrestrictedInput.fileCalls).toEqual([[path.resolve(pdf), path.resolve(text)]]);
  });

  it("uploads attachments sequentially when the input is not multiple", async () => {
    const page = new FakePage();
    const pdf = path.join(tempDir, "report.pdf");
    const text = path.join(tempDir, "notes.txt");
    await Promise.all([
      fs.promises.writeFile(pdf, "fake pdf", "utf8"),
      fs.promises.writeFile(text, "notes", "utf8")
    ]);
    const fileInput = new FakeLocator();
    page.locators.set('input[type="file"]', fileInput);

    await providerRegistry.chatgpt.automation.attachFiles(page as unknown as Page, [pdf, text]);

    expect(fileInput.fileCalls).toEqual([[path.resolve(pdf)], [path.resolve(text)]]);
  });

  it("rejects missing files and directories before provider interaction", async () => {
    const page = new FakePage();
    const fileInput = new FakeLocator();
    page.locators.set('input[type="file"]', fileInput);

    await expect(
      providerRegistry.chatgpt.automation.attachFiles(page as unknown as Page, [path.join(tempDir, "missing.pdf")])
    ).rejects.toThrow("Attachment file does not exist");
    await expect(
      providerRegistry.chatgpt.automation.attachFiles(page as unknown as Page, [tempDir])
    ).rejects.toThrow("Attachment path is not a regular file");
    expect(fileInput.fileCalls).toEqual([]);
  });

  it("reports incompatible inputs and provider upload rejection clearly", async () => {
    const pdf = path.join(tempDir, "report.pdf");
    await fs.promises.writeFile(pdf, "fake pdf", "utf8");
    const incompatiblePage = new FakePage();
    incompatiblePage.locators.set('input[type="file"]', new FakeLocator({ accept: "image/*" }));

    await expect(
      providerRegistry.chatgpt.automation.attachFiles(incompatiblePage as unknown as Page, [pdf])
    ).rejects.toThrow("compatible file input or attach button for ChatGPT attachment upload");

    const rejectingPage = new FakePage();
    rejectingPage.locators.set('input[type="file"]', new FakeLocator({ setInputFilesThrows: true }));
    await expect(
      providerRegistry.chatgpt.automation.attachFiles(rejectingPage as unknown as Page, [pdf])
    ).rejects.toThrow("ChatGPT could not attach the requested file: provider rejected file");
  });

  it("extracts all paragraphs from a Gemini markdown response", async () => {
    const previousDocument = globalThis.document;
    const markdown = {
      tagName: "DIV",
      className: "markdown",
      id: "model-response-message-content",
      innerText: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      textContent: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      querySelector: (selector: string) => selector === "p"
        ? { innerText: "First paragraph.", textContent: "First paragraph." }
        : undefined,
      getAttribute: () => undefined
    };
    const response = {
      tagName: "MESSAGE-CONTENT",
      className: "",
      id: "message-content-id",
      innerText: markdown.innerText,
      textContent: markdown.textContent,
      querySelector: (selector: string) => selector === ".markdown" ? markdown : undefined,
      getAttribute: () => undefined
    };

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: (selector: string) => selector === "message-content" || selector === ".markdown" ? [response] : []
      }
    });

    try {
      const text = await providerRegistry.gemini.automation.extractLatestAssistantText(new FakePage() as unknown as Page);

      expect(text).toBe("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument
      });
    }
  });

  it("returns stable assistant text", async () => {
    const page = new FakePage();
    page.evaluateResults = [{
      key: "new-message",
      text: "final answer",
      count: 1,
      completionActionReady: true,
      busy: false
    }];

    const result = await providerRegistry.chatgpt.automation.waitForAssistantCompletion(page as unknown as Page, {
      timeoutMs: 100,
      stableMs: 0,
      pollMs: 0
    });

    expect(result).toEqual({ text: "final answer", timedOut: false });
  });

  it("does not return ChatGPT Thinking before the new turn is complete", async () => {
    const page = new FakePage();
    page.evaluateResults = [
      {
        key: "new-message",
        text: "Thinking",
        count: 2,
        completionActionReady: false,
        busy: true
      },
      {
        key: "new-message",
        text: "final answer",
        count: 2,
        completionActionReady: true,
        busy: false
      }
    ];

    const result = await providerRegistry.chatgpt.automation.waitForAssistantCompletion(page as unknown as Page, {
      timeoutMs: 100,
      stableMs: 0,
      pollMs: 0,
      baseline: { key: "old-message", text: "old answer", count: 1 }
    });

    expect(result).toEqual({ text: "final answer", timedOut: false });
  });

  it("waits for Gemini Copy action and returns only inner response content", async () => {
    const page = new FakePage();
    page.evaluateResults = [
      {
        key: "response-container:1",
        text: "partial answer",
        count: 2,
        completionActionReady: false,
        busy: false
      },
      {
        key: "response-container:1",
        text: "final answer without Gemini said label",
        count: 2,
        completionActionReady: true,
        busy: false
      }
    ];

    const result = await providerRegistry.gemini.automation.waitForAssistantCompletion(page as unknown as Page, {
      timeoutMs: 100,
      stableMs: 0,
      pollMs: 0,
      baseline: { key: "response-container:0", text: "old answer", count: 1 }
    });

    expect(result).toEqual({ text: "final answer without Gemini said label", timedOut: false });
  });
});
