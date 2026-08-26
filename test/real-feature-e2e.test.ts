import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AskApp } from "../src/app";
import { createProgram, type Runner } from "../src/cli";
import { closeChromeOnPort, ensureChrome } from "../src/browser";

const execFileAsync = promisify(execFile);
const describeWithChrome = process.env.ASK_CHROME_PATH ? describe : describe.skip;

describeWithChrome("P0 reliability and all-provider status in real Chrome", () => {
  let askHome: string;
  let browser: Browser;
  let chatGptPage: Page;
  let geminiPage: Page;
  let context: BrowserContext;
  let env: NodeJS.ProcessEnv;
  let port: number;
  let chatGptFixture = readyChatGptFixture();
  let geminiFixture = signedOutGeminiFixture();

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
      route.fulfill({ contentType: "text/html", body: geminiFixture })
    );
    chatGptPage = await context.newPage();
    geminiPage = await context.newPage();
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

  it("runs the full AskApp coordinator against the routed ChatGPT DOM exactly once", async () => {
    chatGptFixture = readyChatGptFixture();
    await chatGptPage.reload({ waitUntil: "domcontentloaded" });
    await chatGptPage.evaluate(() => localStorage.setItem("ask-fixture-dispatch-count", "0"));
    const app = new AskApp({ env });

    const result = await app.ask({
      provider: "chatgpt",
      prompt: "route-backed exactly once",
      attachments: [],
      headless: true,
      timeoutMs: 5_000
    });

    expect(result).toMatchObject({
      text: "fixture response",
      timedOut: false,
      deliveryState: "confirmed"
    });
    expect(result.conversationUrl).toMatch(/^https:\/\/chatgpt\.com\/c\/fixture-1$/);
    await expect.poll(() => chatGptPage.evaluate(
      () => localStorage.getItem("ask-fixture-dispatch-count")
    )).toBe("1");
  }, 20_000);

  it.each([
    { path: "ask", dispatch: (app: AskApp) => app.ask({
      provider: "gemini",
      prompt: "route-backed Gemini exactly once",
      attachments: [],
      headless: true,
      timeoutMs: 7_000
    }) },
    { path: "open --send", dispatch: async (app: AskApp) => {
      await app.open({
        provider: "gemini",
        url: "https://gemini.google.com/app",
        prompt: "route-backed Gemini exactly once",
        attachments: [],
        send: true,
        timeoutMs: 7_000
      });
      return undefined;
    } }
  ])("runs the full Gemini coordinator through a routed $path fixture exactly once", async ({ dispatch }) => {
    geminiFixture = readyGeminiFixture();
    await geminiPage.reload({ waitUntil: "domcontentloaded" });
    await geminiPage.evaluate(() => localStorage.setItem("ask-gemini-fixture-dispatch-count", "0"));
    const app = new AskApp({ env });

    const result = await dispatch(app);

    if (result) {
      expect(result).toMatchObject({
        text: "Gemini fixture response",
        timedOut: false,
        deliveryState: "confirmed",
        conversationUrl: "https://gemini.google.com/app/fixture-1"
      });
    }
    await expect.poll(() => geminiPage.evaluate(
      () => localStorage.getItem("ask-gemini-fixture-dispatch-count")
    )).toBe("1");
  }, 20_000);

  it("keeps a real routed CLI response on stdout and progress metadata on stderr", async () => {
    chatGptFixture = readyChatGptFixture();
    await chatGptPage.reload({ waitUntil: "domcontentloaded" });
    await chatGptPage.evaluate(() => localStorage.setItem("ask-fixture-dispatch-count", "0"));

    const prompt = "route-backed CLI private prompt";
    const cli = path.resolve(__dirname, "..", "dist", "cli.js");
    const cliHarness = `
      const { createProgram } = require(${JSON.stringify(cli)});
      const stderr = {
        isTTY: true,
        write(chunk) {
          return process.stderr.write(chunk);
        }
      };
      createProgram({
        env: process.env,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr
      }).parseAsync(["node", "ask", ...process.argv.slice(1)]).catch((error) => {
        process.stderr.write(error instanceof Error ? error.message + "\\n" : String(error) + "\\n");
        process.exitCode = 1;
      });
    `;
    const cliRun = execFileAsync(process.execPath, [
      "-e",
      cliHarness,
      "--",
      "--provider",
      "chatgpt",
      "--headless",
      "--timeout",
      "5000",
      prompt
    ], {
      env,
      maxBuffer: 1024 * 1024
    });
    cliRun.child.stdin?.end();
    const { stdout, stderr } = await cliRun;

    expect(stdout).toBe("fixture response\n");
    expect(stderr).toContain("ChatGPT");
    expect(stderr).toContain("new conversation");
    expect(stderr).toContain("https://chatgpt.com/c/fixture-1");
    expect(stderr).not.toContain(prompt);
    expect(stderr).not.toContain("fixture response");
    await expect.poll(() => chatGptPage.evaluate(
      () => localStorage.getItem("ask-fixture-dispatch-count")
    )).toBe("1");
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
      // The coordinator deliberately reloads once after a retryable
      // pre-dispatch capability failure. Leave enough shared budget for that
      // real routed reload, then assert the original missing-composer result.
      timeoutMs: 5_000
    })).rejects.toMatchObject({
      code: "PROMPT_INPUT_NOT_FOUND",
      stage: "prompt.find",
      provider: "chatgpt",
      context: {
        providerHost: "chatgpt.com",
        authState: "signed-in-likely",
        promptInputVisible: false,
        deliveryState: "not-attempted",
        recoveryAttempts: 1
      }
    });

    await expect.poll(() => context.pages().length).toBe(pagesBefore);
    await expect(chatGptPage.locator("#prompt-textarea").count()).resolves.toBe(1);
  }, 20_000);
});

/**
 * This suite deliberately replaces only the human identity step in ordinary
 * Chrome. The CLI fallback, AskApp setup verification, queue, real CDP
 * browser, provider coordinator, and locally routed ChatGPT DOM all remain
 * production implementations. A fresh ASK_HOME is staged with a visible
 * managed Chrome solely so Playwright can intercept every provider request
 * before the first prompt; no provider request reaches the network.
 */
describeWithChrome("first-use CLI recovery with a fresh routed ASK_HOME", () => {
  it("recovers one fresh ask prompt after a pre-dispatch AUTH_REQUIRED without dispatching twice", async () => {
    const fixture = await createFirstUseFixture("auth-required");
    const prompt = "first-use auth-required prompt";
    const conversationName = "first-use-auth-required";
    try {
      expect(fixture.initialAskHomeEntries).toEqual([]);

      const result = await fixture.runCli([
        "--provider", "chatgpt",
        "--timeout", "10000",
        "--conversation", conversationName,
        "--attach", fixture.attachmentPath,
        prompt
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("fixture response\n");
      expect(fixture.askFailures).toHaveLength(1);
      expect(fixture.askFailures[0]).toMatchObject({
        code: "AUTH_REQUIRED",
        stage: "auth.inspect",
        context: { deliveryState: "not-attempted" }
      });
      expect(fixture.setupCalls).toHaveLength(1);
      expect(fixture.authenticationBootstrapCalls).toHaveLength(1);
      expect(fixture.authenticationBootstrapCalls[0]).toMatchObject({
        url: "https://chatgpt.com/",
        deadlineAt: expect.any(Number)
      });
      expect(fixture.askCalls).toHaveLength(2);
      expect(fixture.queueUpdates.some((update) => update.phase === "active")).toBe(true);
      expect(fixture.askCalls).toEqual([
        expect.objectContaining({
          provider: "chatgpt",
          prompt,
          attachments: [fixture.attachmentPath],
          conversationName,
          // A named conversation defaults to continuation semantics; because
          // this clean profile has no saved name yet, AskApp creates and then
          // persists it after confirmed delivery.
          newSession: false,
          allowInteractiveAuth: false,
          timeoutMs: 10000
        }),
        expect.objectContaining({
          provider: "chatgpt",
          prompt,
          attachments: [fixture.attachmentPath],
          conversationName,
          newSession: false,
          allowInteractiveAuth: false
        })
      ]);
      expect(fixture.setupCalls[0]?.timeoutMs).toBeLessThan(10_000);
      expect(fixture.askCalls[1]?.timeoutMs).toBeLessThan(fixture.setupCalls[0]!.timeoutMs);

      await expectFirstUseDispatch(fixture, prompt, conversationName);
      await expect.poll(() => fixture.readWindowState()).toBe("minimized");
      expect(result.stderr).toContain("ordinary Chrome window");
      expect(result.stderr).toContain("resuming the original prompt");
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("gives open --send the same single-setup retry after a pre-dispatch AUTH_UNCONFIRMED", async () => {
    const fixture = await createFirstUseFixture("auth-unconfirmed");
    const prompt = "first-use auth-unconfirmed prompt";
    const conversationName = "first-use-auth-unconfirmed";
    try {
      expect(fixture.initialAskHomeEntries).toEqual([]);

      const result = await fixture.runCli([
        "open",
        "--provider", "chatgpt",
        "--send",
        "--timeout", "10000",
        "--conversation", conversationName,
        "--attach", fixture.attachmentPath,
        prompt
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(fixture.openFailures).toHaveLength(1);
      expect(fixture.openFailures[0]).toMatchObject({
        code: "AUTH_UNCONFIRMED",
        stage: "auth.inspect",
        context: { deliveryState: "not-attempted" }
      });
      expect(fixture.setupCalls).toHaveLength(1);
      expect(fixture.authenticationBootstrapCalls).toHaveLength(1);
      expect(fixture.authenticationBootstrapCalls[0]).toMatchObject({
        url: "https://chatgpt.com/",
        deadlineAt: expect.any(Number)
      });
      expect(fixture.openCalls).toHaveLength(2);
      expect(fixture.queueUpdates.some((update) => update.phase === "active")).toBe(true);
      expect(fixture.openCalls).toEqual([
        expect.objectContaining({
          provider: "chatgpt",
          url: "https://chatgpt.com/",
          prompt,
          attachments: [fixture.attachmentPath],
          conversationName,
          newSession: false,
          allowInteractiveAuth: false,
          send: true,
          timeoutMs: 10000
        }),
        expect.objectContaining({
          provider: "chatgpt",
          url: "https://chatgpt.com/",
          prompt,
          attachments: [fixture.attachmentPath],
          conversationName,
          newSession: false,
          allowInteractiveAuth: false,
          send: true
        })
      ]);
      expect(fixture.setupCalls[0]?.timeoutMs).toBeLessThan(10_000);
      expect(fixture.openCalls[1]?.timeoutMs).toBeLessThan(fixture.setupCalls[0]!.timeoutMs);

      await expectFirstUseDispatch(fixture, prompt, conversationName);
      await expect.poll(() => fixture.readWindowState()).toBe("minimized");
      expect(result.stderr).toContain("resuming the original prompt");
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});

type FirstUseAuthFixture = "auth-required" | "auth-unconfirmed";

interface BufferedCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface FirstUseFixture {
  askHome: string;
  attachmentPath: string;
  initialAskHomeEntries: string[];
  askCalls: Array<Parameters<Runner["ask"]>[0]>;
  openCalls: Array<Parameters<Runner["open"]>[0]>;
  setupCalls: Array<Parameters<Runner["setup"]>[0]>;
  authenticationBootstrapCalls: Array<{ deadlineAt?: number; url: string }>;
  askFailures: unknown[];
  openFailures: unknown[];
  queueUpdates: Array<{ phase: "queued" | "active"; position: number; active: number; queued: number; waitedMs: number }>;
  runCli(args: string[]): Promise<BufferedCliResult>;
  readRouteState(): Promise<{ dispatchCount: number; prompt: string; attachmentNames: string[] }>;
  readWindowState(): Promise<string | undefined>;
  dispose(): Promise<void>;
}

class BufferWriter {
  text = "";

  constructor(readonly isTTY = false) {}

  write(chunk: string): void {
    this.text += chunk;
  }
}

async function createFirstUseFixture(authFixture: FirstUseAuthFixture): Promise<FirstUseFixture> {
  const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-first-use-e2e-"));
  const attachmentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-first-use-attachment-"));
  const attachmentPath = path.join(attachmentDir, "first-use-attachment.txt");
  const initialAskHomeEntries = await fs.promises.readdir(askHome);
  await fs.promises.writeFile(attachmentPath, "fixture attachment\n", "utf8");

  let browser: Browser | undefined;
  let port: number | undefined;
  const askCalls: Array<Parameters<Runner["ask"]>[0]> = [];
  const openCalls: Array<Parameters<Runner["open"]>[0]> = [];
  const setupCalls: Array<Parameters<Runner["setup"]>[0]> = [];
  const authenticationBootstrapCalls: Array<{ deadlineAt?: number; url: string }> = [];
  const askFailures: unknown[] = [];
  const openFailures: unknown[] = [];
  const queueUpdates: FirstUseFixture["queueUpdates"] = [];
  let signedIn = false;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASK_HOME: askHome,
    ASK_PROVIDER: "chatgpt"
  };

  try {
    port = await findFreePort();
    env.ASK_REMOTE_DEBUGGING_PORT = String(port);
    // A visible initial session prevents setup from needing a mode restart,
    // keeping the CDP route fixture attached throughout the real flow.
    await ensureChrome({ env, port, headless: false, requireManaged: true });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("The fresh fixture Chrome did not expose a default context.");
    }
    await context.route("https://chatgpt.com/**", (route) => route.fulfill({
      contentType: "text/html",
      body: firstUseChatGptFixture(signedIn, authFixture)
    }));

    const app = new AskApp({
      env,
      // This is the only substituted step: in production it is the human
      // ordinary-Chrome sign-in. Setup still reconnects, verifies readiness,
      // and parks the managed profile using production code.
      authenticationBootstrap: async (options) => {
        authenticationBootstrapCalls.push({ deadlineAt: options.deadlineAt, url: options.url });
        signedIn = true;
        // A real user completing sign-in changes the live page. Reload any
        // routed provider page so the fixture represents that identity change.
        await Promise.all(context.pages()
          .filter((page) => page.url().startsWith("https://chatgpt.com/"))
          .map((page) => page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined)));
        // Make the shared CLI deadline observable: retry must receive only
        // the remaining budget after this manual-identity seam and setup work.
        await new Promise<void>((resolve) => setTimeout(resolve, 75));
      }
    });

    const runner: Runner = {
      acquireProviderReadinessLease: (provider, timeoutMs) =>
        app.acquireProviderReadinessLease(provider, timeoutMs),
      inspectProviderReadiness: (provider, timeoutMs) =>
        app.inspectProviderReadiness(provider, timeoutMs),
      setup: async (options) => {
        setupCalls.push({ ...options });
        await app.setup(options);
      },
      login: (options) => app.login(options),
      open: async (options) => {
        const onQueueUpdate = options.onQueueUpdate;
        const forwarded = {
          ...options,
          onQueueUpdate: (update: FirstUseFixture["queueUpdates"][number]) => {
            queueUpdates.push(update);
            onQueueUpdate?.(update);
          }
        };
        openCalls.push(forwarded);
        try {
          await app.open(forwarded);
        } catch (error) {
          openFailures.push(error);
          throw error;
        }
      },
      ask: async (options) => {
        const onQueueUpdate = options.onQueueUpdate;
        const forwarded = {
          ...options,
          onQueueUpdate: (update: FirstUseFixture["queueUpdates"][number]) => {
            queueUpdates.push(update);
            onQueueUpdate?.(update);
          }
        };
        askCalls.push(forwarded);
        try {
          return await app.ask(forwarded);
        } catch (error) {
          askFailures.push(error);
          throw error;
        }
      },
      get: (options) => app.get(options),
      dump: (options) => app.dump(options),
      screenshot: (output, options) => app.screenshot(output, options),
      status: (options) => app.status(options),
      listConversations: (provider) => app.listConversations(provider),
      forgetConversation: (name, provider) => app.forgetConversation(name, provider)
    };

    return {
      askHome,
      attachmentPath,
      initialAskHomeEntries,
      askCalls,
      openCalls,
      setupCalls,
      authenticationBootstrapCalls,
      askFailures,
      openFailures,
      queueUpdates,
      runCli: async (args) => {
        const stdout = new BufferWriter();
        const stderr = new BufferWriter(true);
        let exitCode = 0;
        const program = createProgram({
          runner,
          env,
          stdin: { isTTY: true } as NodeJS.ReadStream,
          stdout,
          stderr,
          setExitCode: (code) => {
            exitCode = code;
          }
        });
        await program.parseAsync(["node", "ask", ...args]);
        return { stdout: stdout.text, stderr: stderr.text, exitCode };
      },
      readRouteState: async () => {
        const page = context.pages().find((candidate) => candidate.url().startsWith("https://chatgpt.com/"));
        if (!page) {
          throw new Error("The setup verification page was not available to inspect fixture dispatch state.");
        }
        return page.evaluate(() => ({
          dispatchCount: Number(localStorage.getItem("ask-first-use-dispatch-count") || "0"),
          prompt: localStorage.getItem("ask-first-use-prompt") || "",
          attachmentNames: JSON.parse(localStorage.getItem("ask-first-use-attachments") || "[]") as string[]
        }));
      },
      readWindowState: async () => {
        const page = context.pages()[0];
        if (!page) {
          return undefined;
        }
        const session = await context.newCDPSession(page);
        try {
          const target = await session.send("Browser.getWindowForTarget") as { windowId?: number };
          if (typeof target.windowId !== "number") {
            return undefined;
          }
          const result = await session.send("Browser.getWindowBounds", {
            windowId: target.windowId
          }) as { bounds?: { windowState?: string } };
          return result.bounds?.windowState;
        } finally {
          await session.detach().catch(() => undefined);
        }
      },
      dispose: async () => {
        await browser?.close().catch(() => undefined);
        if (port !== undefined) {
          await closeChromeOnPort(port, { env }).catch(() => undefined);
        }
        await fs.promises.rm(askHome, { recursive: true, force: true });
        await fs.promises.rm(attachmentDir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    if (port !== undefined) {
      await closeChromeOnPort(port, { env }).catch(() => undefined);
    }
    await fs.promises.rm(askHome, { recursive: true, force: true });
    await fs.promises.rm(attachmentDir, { recursive: true, force: true });
    throw error;
  }
}

async function expectFirstUseDispatch(
  fixture: FirstUseFixture,
  prompt: string,
  conversationName: string
): Promise<void> {
  await expect.poll(() => fixture.readRouteState()).toMatchObject({
    dispatchCount: 1,
    prompt,
    attachmentNames: [path.basename(fixture.attachmentPath)]
  });
  const conversations = JSON.parse(await fs.promises.readFile(
    path.join(fixture.askHome, "conversations.json"),
    "utf8"
  )) as {
    named?: { chatgpt?: Record<string, { url?: string }> };
  };
  expect(conversations.named?.chatgpt?.[conversationName]?.url).toBe("https://chatgpt.com/c/fixture-1");
}

function firstUseChatGptFixture(signedIn: boolean, authFixture: FirstUseAuthFixture): string {
  if (!signedIn) {
    const authMarker = authFixture === "auth-required"
      ? '<a href="/auth/login">Log in</a>'
      : "";
    return `<!doctype html>
      <html><body><main>
        ${authMarker}
        <form data-testid="composer">
          <input type="file" multiple>
          <textarea id="prompt-textarea"></textarea>
        </form>
      </main></body></html>`;
  }

  return `<!doctype html>
    <html><body>
      <main>
        <button data-testid="profile-button">Profile</button>
        <section id="turns"></section>
        <form data-testid="composer">
          <input id="fixture-files" type="file" multiple>
          <section id="fixture-attachments"></section>
          <textarea id="prompt-textarea"></textarea>
          <button type="button" data-testid="send-button">Send</button>
        </form>
      </main>
      <script>
        const composer = document.querySelector('#prompt-textarea');
        const fileInput = document.querySelector('#fixture-files');
        const attachmentSurface = document.querySelector('#fixture-attachments');
        const turns = document.querySelector('#turns');
        fileInput.addEventListener('change', () => {
          attachmentSurface.replaceChildren(...Array.from(fileInput.files).map((file) => {
            const attachment = document.createElement('div');
            attachment.dataset.testid = 'file-thumbnail';
            attachment.dataset.fileName = file.name;
            attachment.textContent = file.name;
            return attachment;
          }));
        });
        document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
          const count = Number(localStorage.getItem('ask-first-use-dispatch-count') || '0') + 1;
          localStorage.setItem('ask-first-use-dispatch-count', String(count));
          localStorage.setItem('ask-first-use-prompt', composer.value);
          localStorage.setItem('ask-first-use-attachments', JSON.stringify(Array.from(fileInput.files).map((file) => file.name)));
          const user = document.createElement('article');
          user.dataset.messageAuthorRole = 'user';
          user.dataset.messageId = 'first-use-user-' + count;
          user.textContent = composer.value;
          turns.appendChild(user);
          composer.value = '';
          composer.dispatchEvent(new Event('input', { bubbles: true }));
          history.pushState({}, '', '/c/fixture-' + count);
          setTimeout(() => {
            const assistant = document.createElement('article');
            assistant.dataset.messageAuthorRole = 'assistant';
            assistant.dataset.messageId = 'first-use-assistant-' + count;
            const content = document.createElement('div');
            content.className = 'markdown';
            content.textContent = 'fixture response';
            const copy = document.createElement('button');
            copy.dataset.testid = 'copy-turn-action-button';
            copy.textContent = 'Copy';
            assistant.append(content, copy);
            turns.appendChild(assistant);
          }, 50);
        });
      </script>
    </body></html>`;
}

function readyChatGptFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <main>
          <button data-testid="profile-button">Profile</button>
          <section id="turns"></section>
          <form>
            <textarea id="prompt-textarea"></textarea>
            <button type="button" data-testid="send-button">Send</button>
          </form>
        </main>
        <script>
          const composer = document.querySelector('#prompt-textarea');
          const turns = document.querySelector('#turns');
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            const count = Number(localStorage.getItem('ask-fixture-dispatch-count') || '0') + 1;
            localStorage.setItem('ask-fixture-dispatch-count', String(count));
            const prompt = composer.value;
            const user = document.createElement('article');
            user.dataset.messageAuthorRole = 'user';
            user.dataset.messageId = 'fixture-user-' + count;
            user.textContent = prompt;
            turns.appendChild(user);
            composer.value = '';
            composer.dispatchEvent(new Event('input', { bubbles: true }));
            history.pushState({}, '', '/c/fixture-' + count);
            setTimeout(() => {
              const assistant = document.createElement('article');
              assistant.dataset.messageAuthorRole = 'assistant';
              assistant.dataset.messageId = 'fixture-assistant-' + count;
              const content = document.createElement('div');
              content.className = 'markdown';
              content.textContent = 'fixture response';
              const copy = document.createElement('button');
              copy.dataset.testid = 'copy-turn-action-button';
              copy.textContent = 'Copy';
              assistant.append(content, copy);
              turns.appendChild(assistant);
            }, 50);
          });
        </script>
      </body>
    </html>`;
}

function signedInWithoutMessageBoxFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <main>
          <button data-testid="profile-button">Profile</button>
        </main>
      </body>
    </html>`;
}

function signedOutGeminiFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <a href="https://accounts.google.com/ServiceLogin" aria-label="Sign in">Sign in</a>
      </body>
    </html>`;
}

function readyGeminiFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <main>
          <a href="https://accounts.google.com/SignOutOptions">Google Account</a>
          <section id="turns"></section>
          <section class="text-input-field">
            <rich-textarea>
              <div id="gemini-prompt" contenteditable="true" role="textbox"></div>
            </rich-textarea>
            <button type="button" aria-label="Send message">Send</button>
          </section>
        </main>
        <script>
          const composer = document.querySelector('#gemini-prompt');
          const turns = document.querySelector('#turns');
          document.querySelector('button[aria-label="Send message"]').addEventListener('click', () => {
            const count = Number(localStorage.getItem('ask-gemini-fixture-dispatch-count') || '0') + 1;
            localStorage.setItem('ask-gemini-fixture-dispatch-count', String(count));
            const prompt = composer.innerText || composer.textContent || '';
            localStorage.setItem('ask-gemini-fixture-prompt', prompt);
            composer.textContent = '';
            composer.dispatchEvent(new Event('input', { bubbles: true }));
            history.pushState({}, '', '/app/fixture-' + count);
            const responseTurn = document.createElement('div');
            responseTurn.className = 'conversation-container';
            responseTurn.id = 'gemini-response-' + count;
            const response = document.createElement('response-container');
            const content = document.createElement('message-content');
            content.textContent = 'Gemini fixture response';
            const copy = document.createElement('button');
            copy.setAttribute('aria-label', 'Copy');
            copy.textContent = 'Copy';
            response.append(content, copy);
            responseTurn.appendChild(response);
            turns.appendChild(responseTurn);
          });
        </script>
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
