import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeChromeOnPort,
  ensureManagedChrome,
  inspectChromeSession,
  waitForRemoteDebuggingToClose,
  type ManagedChromeSession
} from "../src/browser";
import { providerRegistry } from "../src/providers";
import { openWorkerPage } from "../src/webchat";

const describeWithChrome = process.env.ASK_CHROME_PATH ? describe : describe.skip;

describeWithChrome("automatic Chrome endpoint in a real dedicated profile", () => {
  let askHome: string;
  let env: NodeJS.ProcessEnv;
  let session: ManagedChromeSession | undefined;

  beforeAll(async () => {
    askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-auto-browser-"));
    env = {
      ...process.env,
      ASK_HOME: askHome,
      ASK_CHROME_PATH: process.env.ASK_CHROME_PATH,
      ASK_REMOTE_DEBUGGING_PORT: undefined
    };
  });

  afterAll(async () => {
    if (session) {
      await closeChromeOnPort(session.port, { env }).catch(() => undefined);
      await waitForRemoteDebuggingToClose(session.port).catch(() => undefined);
    }
    if (askHome) {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("launches on port zero, persists the assigned port, then reuses it", async () => {
    session = await ensureManagedChrome({ env, desiredMode: "headless" });
    expect(session).toMatchObject({
      portPolicy: "automatic",
      disposition: "launched",
      mode: "headless"
    });
    expect(session.port).toBeGreaterThan(0);
    expect(session.generation).toBeTruthy();

    const reused = await ensureManagedChrome({ env, desiredMode: "headless" });
    expect(reused).toMatchObject({
      port: session.port,
      generation: session.generation,
      portPolicy: "automatic",
      disposition: "reused"
    });
    await expect(inspectChromeSession({ env })).resolves.toMatchObject({
      port: session.port,
      portPolicy: "automatic",
      connected: true,
      classification: { ownership: "ask-managed" }
    });

    const chromePath = env.ASK_CHROME_PATH;
    env.ASK_CHROME_PATH = "";
    await expect(ensureManagedChrome({ env, desiredMode: "headless" })).rejects.toThrow("ASK_CHROME_PATH");
    env.ASK_CHROME_PATH = chromePath;
  }, 30_000);

  it("restarts into a genuinely minimized headed background session", async () => {
    session = await ensureManagedChrome({
      env,
      desiredMode: "visible",
      background: true
    });
    expect(session).toMatchObject({
      portPolicy: "automatic",
      disposition: "restarted",
      mode: "visible"
    });

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`);
    try {
      const page = browser.contexts()[0]?.pages()[0];
      expect(page).toBeDefined();
      const cdp = await page!.context().newCDPSession(page!);
      try {
        const target = await cdp.send("Browser.getWindowForTarget") as { windowId: number };
        const result = await cdp.send("Browser.getWindowBounds", {
          windowId: target.windowId
        }) as { bounds?: { windowState?: string } };
        expect(result.bounds?.windowState).toBe("minimized");

        let monitoring = true;
        const observedStates: Array<string | undefined> = [];
        const monitor = (async () => {
          while (monitoring) {
            const current = await cdp.send("Browser.getWindowBounds", {
              windowId: target.windowId
            }) as { bounds?: { windowState?: string } };
            observedStates.push(current.bounds?.windowState);
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          }
        })();

        let worker: Awaited<ReturnType<typeof openWorkerPage>> | undefined;
        try {
          worker = await openWorkerPage(
            browser,
            providerRegistry.chatgpt,
            "data:text/html,<title>background-worker</title>",
            {
              background: true,
              timeoutMs: 5_000,
              onPageCreated: async (workerPage) => {
                expect(workerPage.url()).toMatch(/^about:blank#ask-worker-/);
                const workerCdp = await workerPage.context().newCDPSession(workerPage);
                try {
                  const workerTarget = await workerCdp.send("Browser.getWindowForTarget") as {
                    windowId: number;
                  };
                  await workerCdp.send("Browser.setWindowBounds", {
                    windowId: workerTarget.windowId,
                    bounds: { windowState: "minimized" }
                  });
                } finally {
                  await workerCdp.detach();
                }
              }
            }
          );
        } finally {
          monitoring = false;
          await monitor.catch(() => undefined);
        }
        await worker?.close();

        expect(observedStates.length).toBeGreaterThan(0);
        expect(new Set(observedStates)).toEqual(new Set(["minimized"]));
      } finally {
        await cdp.detach();
      }
    } finally {
      await browser.close();
    }
  }, 30_000);
});
