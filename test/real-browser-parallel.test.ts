import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeChromeOnPort, ensureChrome, type ManagedChromeSession } from "../src/browser";
import { providerRegistry } from "../src/providers";
import { readSessionState } from "../src/session";
import { openWorkerPage } from "../src/webchat";

const describeWithChrome = process.env.ASK_CHROME_PATH ? describe : describe.skip;
const execFileAsync = promisify(execFile);

describeWithChrome("multiprocess managed Chrome startup", () => {
  let askHome: string;
  let session: ManagedChromeSession | undefined;

  afterAll(async () => {
    const cleanupEnv = askHome ? { ...process.env, ASK_HOME: askHome } : undefined;
    const persisted = cleanupEnv
      ? await readSessionState(cleanupEnv).catch(() => undefined)
      : undefined;
    const cleanupPort = session?.port ?? persisted?.port;
    if (cleanupEnv && cleanupPort !== undefined) {
      await closeChromeOnPort(cleanupPort, {
        env: cleanupEnv,
        timeoutMs: 10_000
      });
    }
    if (askHome) {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("turns four concurrent fresh starts into one automatic managed session", async () => {
    askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-real-start-"));
    const worker = path.resolve(__dirname, "fixtures", "browser-start-worker.cjs");
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ASK_HOME: askHome
    };
    delete childEnv.ASK_REMOTE_DEBUGGING_PORT;

    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () =>
      execFileAsync(process.execPath, [worker], {
        env: childEnv,
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      })
    ));
    const sessions: ManagedChromeSession[] = [];
    let failure: unknown;
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        failure ??= outcome.reason;
        continue;
      }
      try {
        const parsed = JSON.parse(outcome.value.stdout.trim()) as ManagedChromeSession;
        sessions.push(parsed);
        session ??= parsed;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      throw failure;
    }

    expect(new Set(sessions.map((candidate) => candidate.port)).size).toBe(1);
    expect(new Set(sessions.map((candidate) => candidate.pid)).size).toBe(1);
    expect(new Set(sessions.map((candidate) => candidate.generation)).size).toBe(1);
    expect(sessions.filter((candidate) => candidate.disposition === "launched")).toHaveLength(1);
    expect(sessions.filter((candidate) => candidate.disposition === "reused")).toHaveLength(3);
    expect(sessions.every((candidate) => candidate.portPolicy === "automatic")).toBe(true);
  }, 40_000);

  it("does not let a different ASK_HOME adopt or close a pinned session", async () => {
    const firstHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-real-owner-a-"));
    const secondHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-real-owner-b-"));
    const pinnedPort = await findFreePort();
    const firstEnv = {
      ...process.env,
      ASK_HOME: firstHome,
      ASK_REMOTE_DEBUGGING_PORT: String(pinnedPort)
    };
    const secondEnv = {
      ...process.env,
      ASK_HOME: secondHome,
      ASK_REMOTE_DEBUGGING_PORT: String(pinnedPort)
    };

    try {
      await expect(ensureChrome({
        env: firstEnv,
        port: pinnedPort,
        headless: true,
        requireManaged: true,
        timeoutMs: 20_000
      })).resolves.toBe(pinnedPort);
      await expect(ensureChrome({
        env: secondEnv,
        port: pinnedPort,
        headless: true,
        requireManaged: true,
        timeoutMs: 5_000
      })).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
      await expect(closeChromeOnPort(pinnedPort, {
        env: secondEnv,
        timeoutMs: 5_000
      })).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
      await expect(ensureChrome({
        env: firstEnv,
        port: pinnedPort,
        headless: true,
        requireManaged: true,
        timeoutMs: 5_000
      })).resolves.toBe(pinnedPort);
    } finally {
      await closeChromeOnPort(pinnedPort, { env: firstEnv, timeoutMs: 10_000 }).catch(() => undefined);
      await Promise.all([
        fs.promises.rm(firstHome, { recursive: true, force: true }),
        fs.promises.rm(secondHome, { recursive: true, force: true })
      ]);
    }
  }, 30_000);
});

describeWithChrome("parallel execution pages in a real Chrome session", () => {
  let askHome: string;
  let port: number;
  const browsers: Browser[] = [];
  const pages: Page[] = [];

  beforeAll(async () => {
    askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-real-browser-"));
    port = await findFreePort();
    await ensureChrome({
      env: { ...process.env, ASK_HOME: askHome, ASK_REMOTE_DEBUGGING_PORT: String(port) },
      port,
      headless: true,
      requireManaged: true
    });
  }, 30_000);

  afterAll(async () => {
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
    if (port) {
      await closeChromeOnPort(port).catch(() => undefined);
    }
    if (askHome) {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("isolates four simultaneous pages over one debugging port and cleans them up", async () => {
    const tokens = ["alpha", "bravo", "charlie", "delta"];
    const opened = await Promise.all(tokens.map(async (token) => {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      browsers.push(browser);
      const page = await openWorkerPage(browser, providerRegistry.chatgpt, fixtureUrl(token));
      pages.push(page);
      await page.locator("#prompt").fill(token);
      await page.locator("#send").click();
      return { page, token };
    }));

    expect(new Set(opened.map(({ page }) => page)).size).toBe(4);
    await Promise.all(opened.map(async ({ page, token }) => {
      await expect(page.locator("#response").textContent()).resolves.toBe(`response:${token}`);
    }));

    await Promise.all(opened.map(({ page }) => page.close()));
    const observer = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    browsers.push(observer);
    const remainingFixturePages = observer.contexts()[0].pages().filter((page) =>
      page.url().startsWith("data:text/html")
    );
    expect(remainingFixturePages).toHaveLength(0);
  }, 20_000);
});

function fixtureUrl(token: string): string {
  const html = `<!doctype html><html><body>
    <input id="prompt" />
    <button id="send" onclick="document.querySelector('#response').textContent='response:'+document.querySelector('#prompt').value">Send</button>
    <div id="response"></div>
    <div id="fixture">${token}</div>
  </body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
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
