import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChromeArgs, ensureChrome, getChromeCandidates, inspectChromeSession, isHeadlessRemoteDebugging, resolveChromePath, shouldRestartChromeForMode } from "../src/browser";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser Chrome path detection", () => {
  it("uses ASK_CHROME_PATH when provided", () => {
    const env = { ASK_CHROME_PATH: "C:\\Chrome\\chrome.exe" } as NodeJS.ProcessEnv;
    expect(resolveChromePath(env, (filePath) => filePath === "C:\\Chrome\\chrome.exe")).toBe("C:\\Chrome\\chrome.exe");
  });

  it("throws when ASK_CHROME_PATH points to a missing file", () => {
    const env = { ASK_CHROME_PATH: "C:\\Missing\\chrome.exe" } as NodeJS.ProcessEnv;
    expect(() => resolveChromePath(env, () => false)).toThrow("ASK_CHROME_PATH");
  });

  it("checks the expected Windows install locations", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LocalAppData: "C:\\Users\\Me\\AppData\\Local"
    } as NodeJS.ProcessEnv;

    expect(getChromeCandidates(env)).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\Me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"
    ]);
  });

  it("uses the first existing default candidate", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      LocalAppData: "C:\\Users\\Me\\AppData\\Local"
    } as NodeJS.ProcessEnv;
    const localChrome = "C:\\Users\\Me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";

    expect(resolveChromePath(env, (filePath) => filePath === localChrome)).toBe(localChrome);
  });
});


describe("browser Chrome launch arguments", () => {
  it("uses the dedicated ask Chrome profile so normal Chrome can stay open", () => {
    const args = buildChromeArgs({
      env: { ASK_HOME: "C:\\Users\\Me\\.ask" } as NodeJS.ProcessEnv,
      port: 9333,
      url: "https://chatgpt.com/"
    });

    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--user-data-dir=C:\\Users\\Me\\.ask\\chrome-profile");
    expect(args).not.toContain("--profile-directory=Default");
  });
});
describe("browser remote debugging validation", () => {
  it("reports one coherent inspection for an external headless session", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-inspection-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            Browser: "Chrome/149.0.7827.116",
            "User-Agent": "Mozilla/5.0 HeadlessChrome/149.0.0.0 Safari/537.36"
          }),
          { status: 200 }
        )
      )
    );

    try {
      await expect(inspectChromeSession({ env: { ASK_HOME: askHome } as NodeJS.ProcessEnv, port: 9444 })).resolves.toMatchObject({
        port: 9444,
        connected: true,
        classification: { ownership: "external" },
        headless: true,
        browser: "Chrome/149.0.7827.116"
      });
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("detects headless Chrome from remote debugging metadata", () => {
    expect(
      isHeadlessRemoteDebugging({
        Browser: "Chrome/149.0.7827.116",
        "User-Agent": "Mozilla/5.0 HeadlessChrome/149.0.0.0 Safari/537.36"
      })
    ).toBe(true);

    expect(
      isHeadlessRemoteDebugging({
        Browser: "Chrome/149.0.7827.116",
        "User-Agent": "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36"
      })
    ).toBe(false);
  });

  it("requires restarts only when the requested Chrome mode differs", () => {
    const visible = { Browser: "Chrome/149.0.0.0" };
    const headless = { Browser: "HeadlessChrome/149.0.0.0" };

    expect(shouldRestartChromeForMode(visible, { headless: true })).toBe(true);
    expect(shouldRestartChromeForMode(headless, { requireVisible: true })).toBe(true);
    expect(shouldRestartChromeForMode(headless, { headless: true })).toBe(false);
    expect(shouldRestartChromeForMode(visible, { requireVisible: true })).toBe(false);
    expect(shouldRestartChromeForMode(visible, {})).toBe(false);
  });

  it("rejects a headless debugging session when a visible browser is required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            Browser: "Chrome/149.0.7827.116",
            "User-Agent": "Mozilla/5.0 HeadlessChrome/149.0.0.0 Safari/537.36"
          }),
          { status: 200 }
        )
      )
    );

    await expect(ensureChrome({ port: 9444, requireVisible: true })).rejects.toThrow("headless Chrome session");
  });
});
