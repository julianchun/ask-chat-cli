import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AskApp } from "../src/app";
import { closeChromeOnPort, ensureChrome } from "../src/browser";

const execFileAsync = promisify(execFile);
const describeWithChrome = process.env.ASK_CHROME_PATH ? describe : describe.skip;

describeWithChrome("P0 reliability and all-provider status in real Chrome", () => {
  let askHome: string;
  let browser: Browser;
  let chatGptPage: Page;
  let context: BrowserContext;
  let env: NodeJS.ProcessEnv;
  let port: number;
  let chatGptFixture = readyChatGptFixture();

  beforeAll(async () => {
    askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-feature-e2e-"));
    port = await findFreePort();
    env = {
      ...process.env,
      ASK_HOME: askHome,
      ASK_PROVIDER: "gemini",
      ASK_REMOTE_DEBUGGING_PORT: String(port)
    };
    await ensureChrome({
      env,
      port,
      headless: true,
      requireManaged: true
    });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    context = browser.contexts()[0];
    await context.route("https://chatgpt.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: chatGptFixture })
    );
    await context.route("https://gemini.google.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: signedOutGeminiFixture() })
    );
    chatGptPage = await context.newPage();
    const geminiPage = await context.newPage();
    await Promise.all([
      chatGptPage.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" }),
      geminiPage.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" })
    ]);
  }, 30_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    if (port) {
      await closeChromeOnPort(port).catch(() => undefined);
    }
    if (askHome) {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("reports every provider in order and ignores ASK_PROVIDER", async () => {
    const app = new AskApp({ env });
    const report = await app.status({ timeoutMs: 1_000 });

    expect(report.session).toMatchObject({
      connected: true,
      sessionOwnership: "ask-managed",
      headless: true
    });
    expect(report.providers).toMatchObject([
      {
        provider: "chatgpt",
        status: "ready",
        authState: "signed-in-likely",
        messageBox: "available"
      },
      {
        provider: "gemini",
        status: "login-required",
        authState: "login-required",
        messageBox: "not-found"
      }
    ]);

    const cli = path.resolve(__dirname, "..", "dist", "cli.js");
    const { stdout } = await execFileAsync(process.execPath, [cli, "status"], {
      env,
      maxBuffer: 1024 * 1024
    });
    expect(stdout).toContain("PROVIDER  STATUS");
    expect(stdout).toContain("MESSAGE BOX");
    expect(stdout).toContain("ChatGPT");
    expect(stdout).toContain("Gemini");
  }, 20_000);

  it("returns a structured missing-message-box failure and closes its worker page", async () => {
    const pagesBefore = context.pages().length;
    chatGptFixture = signedInWithoutMessageBoxFixture();
    const app = new AskApp({ env });

    await expect(app.ask({
      provider: "chatgpt",
      prompt: "hello",
      attachments: [],
      headless: true,
      timeoutMs: 1_000
    })).rejects.toMatchObject({
      code: "PROMPT_INPUT_NOT_FOUND",
      stage: "prompt.find",
      provider: "chatgpt",
      context: {
        providerHost: "chatgpt.com",
        authState: "signed-in-likely",
        promptInputVisible: false
      }
    });

    await expect.poll(() => context.pages().length).toBe(pagesBefore);
    await expect(chatGptPage.locator("#prompt-textarea").count()).resolves.toBe(1);
  }, 20_000);
});

function readyChatGptFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <button data-testid="profile-button">Profile</button>
        <textarea id="prompt-textarea"></textarea>
        <button data-testid="send-button">Send</button>
      </body>
    </html>`;
}

function signedInWithoutMessageBoxFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <button data-testid="profile-button">Profile</button>
      </body>
    </html>`;
}

function signedOutGeminiFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <a aria-label="Sign in">Sign in</a>
      </body>
    </html>`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a test port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
