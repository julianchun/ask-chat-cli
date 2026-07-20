import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeChromeOnPort, ensureChrome } from "../src/browser";
import { providerRegistry } from "../src/providers";
import { openWorkerPage } from "../src/webchat";

const describeWithChrome = process.env.ASK_CHROME_PATH ? describe : describe.skip;

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
