import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import net from "node:net";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChromeAuthenticationArgs,
  buildChromeArgs,
  assertNoLiveDeliveryAmbiguityBeforeClose,
  ChromeSessionConfigMismatchError,
  closeChromeOnPort,
  ensureChrome,
  getChromeCandidates,
  getDevToolsActivePortPath,
  hasBackgroundExecutionCapability,
  inspectChromeSession,
  isHeadlessRemoteDebugging,
  minimizeConnectedChromeWindows,
  readDevToolsActivePort,
  reconcileAutomaticChromeSession,
  resolveChromeMode,
  resolveChromePath,
  resolveChromePortSelection,
  shouldRestartChromeForMode,
  shouldRestartManagedChromeForRequest,
  waitForAuthenticationChromeToExit,
  waitForDevToolsActivePort,
  waitForRemoteDebugging
} from "../src/browser";
import { getRemoteDebuggingPort } from "../src/config";
import {
  isProcessAlive,
  readSessionState,
  writeProfileMarker,
  writeSessionState
} from "../src/session";
import {
  listDeliveryAmbiguityMarkers,
  writeDeliveryAmbiguityMarker
} from "../src/delivery-ambiguity";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it("rejects a real path that is not an executable file", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-chrome-path-"));
    const candidate = path.join(directory, "google-chrome");
    try {
      await fs.promises.writeFile(candidate, "fixture", { mode: 0o600 });
      expect(() => resolveChromePath({ ASK_CHROME_PATH: candidate } as NodeJS.ProcessEnv)).toThrow(
        "ASK_CHROME_PATH"
      );
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  it("checks the expected Windows install locations", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LocalAppData: "C:\\Users\\Me\\AppData\\Local"
    } as NodeJS.ProcessEnv;

    expect(getChromeCandidates(env, "win32")).toEqual([
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

    expect(resolveChromePath(env, (filePath) => filePath === localChrome, "win32")).toBe(localChrome);
  });

  it("discovers only branded Google Chrome locations on macOS and Linux", () => {
    expect(getChromeCandidates({ HOME: "/Users/me" } as NodeJS.ProcessEnv, "darwin")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ]);
    expect(getChromeCandidates({} as NodeJS.ProcessEnv, "linux")).toEqual([
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/google-chrome",
      "/opt/google/chrome/chrome"
    ]);
  });

  it("checks PATH in platform-specific branded-Chrome order", () => {
    expect(getChromeCandidates({
      ProgramFiles: "C:\\Program Files",
      PATH: "C:\\Tools;D:\\Bin"
    } as NodeJS.ProcessEnv, "win32")).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Tools\\chrome.exe",
      "D:\\Bin\\chrome.exe"
    ]);
    expect(getChromeCandidates({
      HOME: "/Users/me",
      PATH: "/custom/bin:/opt/bin"
    } as NodeJS.ProcessEnv, "darwin")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/custom/bin/google-chrome",
      "/custom/bin/Google Chrome",
      "/opt/bin/google-chrome",
      "/opt/bin/Google Chrome"
    ]);
    expect(getChromeCandidates({ PATH: "/custom/bin:/opt/bin" } as NodeJS.ProcessEnv, "linux")).toEqual([
      "/custom/bin/google-chrome-stable",
      "/custom/bin/google-chrome",
      "/opt/bin/google-chrome-stable",
      "/opt/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/google-chrome",
      "/opt/google/chrome/chrome"
    ]);
  });

  it("uses injected Windows environment casing and an injected filesystem seam", () => {
    const env = {
      Path: "D:\\Ask Tools;E:\\Chrome Bin"
    } as NodeJS.ProcessEnv;
    const chromeFromPath = "E:\\Chrome Bin\\chrome.exe";

    // Passing win32 makes this deterministic when the test itself runs on
    // Linux or macOS. The exists callback avoids probing the host filesystem.
    expect(resolveChromePath(env, (candidate) => candidate === chromeFromPath, "win32")).toBe(chromeFromPath);
  });

  it("treats even an empty ASK_CHROME_PATH as strict configuration", () => {
    expect(() => resolveChromePath({ ASK_CHROME_PATH: "" } as NodeJS.ProcessEnv, () => true)).toThrow("set but empty");
  });
});


describe("browser Chrome launch arguments", () => {
  it("uses an ordinary dedicated Chrome profile for secure authentication", () => {
    const args = buildChromeAuthenticationArgs({
      env: { ASK_HOME: "/tmp/ask-auth" } as NodeJS.ProcessEnv,
      url: "https://chatgpt.com/"
    });

    expect(args).toEqual([
      "--user-data-dir=/tmp/ask-auth/chrome-profile",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--window-position=80,80",
      "--window-size=1200,800",
      "--new-window",
      "https://chatgpt.com/"
    ]);
    expect(args.join(" ")).not.toContain("remote-debugging");
  });

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

  it("launches headed prompt sessions minimized when background mode is requested", () => {
    const args = buildChromeArgs({
      env: { ASK_HOME: "/tmp/ask-background" } as NodeJS.ProcessEnv,
      background: true,
      url: "https://chatgpt.com/"
    });

    expect(args).toContain("--start-minimized");
    expect(args).toContain("--window-position=-10000,-10000");
    expect(args).toContain("--window-size=800,600");
    expect(args).toContain("--new-window");
    expect(args).toContain("--disable-background-timer-throttling");
    expect(args).toContain("--disable-backgrounding-occluded-windows");
    expect(args).toContain("--disable-renderer-backgrounding");
    expect(args).not.toContain("--headless=new");
  });

  it("uses an ephemeral debugging port when no port is configured", () => {
    const env = { ASK_HOME: "/tmp/ask-auto" } as NodeJS.ProcessEnv;
    expect(getRemoteDebuggingPort(env)).toBeUndefined();
    expect(resolveChromePortSelection({ env })).toEqual({
      portPolicy: "automatic",
      launchPort: 0
    });
    expect(buildChromeArgs({ env })).toContain("--remote-debugging-port=0");
  });

  it("keeps explicit ports pinned and rejects conflicting programmatic overrides", () => {
    const env = { ASK_REMOTE_DEBUGGING_PORT: "9333" } as NodeJS.ProcessEnv;
    expect(resolveChromePortSelection({ env })).toEqual({
      portPolicy: "pinned",
      port: 9333,
      launchPort: 9333
    });
    expect(() => resolveChromePortSelection({ env, port: 9444 })).toThrow(ChromeSessionConfigMismatchError);
  });

  it("reads the assigned port from Chrome's DevToolsActivePort file", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-active-port-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    try {
      await fs.promises.mkdir(path.dirname(getDevToolsActivePortPath(env)), { recursive: true });
      await fs.promises.writeFile(getDevToolsActivePortPath(env), "54321\n/devtools/browser/id\n", "utf8");
      await expect(readDevToolsActivePort(env)).resolves.toBe(54321);
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });
});

describe("ordinary Chrome authentication lifecycle", () => {
  it("uses Windows profile-owning browser roots instead of a POSIX SingletonLock", async () => {
    const profileDir = "C:\\Users\\Me\\.ask\\chrome-profile";
    const observations = [
      [{
        pid: 4123,
        args: ["chrome.exe", `--user-data-dir=${profileDir}`]
      }],
      []
    ];
    const getProfileProcesses = vi.fn(async () => observations.shift());
    const child = { exitCode: null, signalCode: null } as never;

    await expect(waitForAuthenticationChromeToExit(
      child,
      profileDir,
      Date.now() + 1_000,
      "ordinary Chrome did not exit",
      { platform: "win32", getProfileProcesses, pollIntervalMs: 0 }
    )).resolves.toBeUndefined();

    // The first matching root proves the spawned ordinary profile opened; only
    // the later empty snapshot permits managed-CDP startup to reuse it.
    expect(getProfileProcesses).toHaveBeenCalledTimes(2);
  });
});

describe("background execution capability", () => {
  it("recognizes a legacy managed root missing the required background flags", () => {
    expect(hasBackgroundExecutionCapability({
      pid: 31,
      args: [
        "chrome",
        "--remote-debugging-port=9222",
        "--disable-background-timer-throttling"
      ]
    })).toBe(false);
  });

  it("recognizes a managed root that can safely stay minimized", () => {
    expect(hasBackgroundExecutionCapability({
      pid: 32,
      args: [
        "chrome",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding"
      ]
    })).toBe(true);
  });

  it("requires a guarded restart for a legacy managed session missing a background flag", () => {
    const legacyRoot = {
      pid: 41,
      args: [
        "chrome",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows"
      ]
    };
    expect(shouldRestartManagedChromeForRequest(
      { Browser: "Chrome/151.0.0.0" },
      legacyRoot,
      { desiredMode: "preserve", background: true }
    )).toBe(true);
  });

  it("reuses a capable managed session for a background send without restarting", () => {
    const capableRoot = {
      pid: 42,
      args: [
        "chrome",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding"
      ]
    };
    expect(shouldRestartManagedChromeForRequest(
      { Browser: "Chrome/151.0.0.0" },
      capableRoot,
      { desiredMode: "preserve", background: true }
    )).toBe(false);
  });

  it("minimizes each distinct managed window before a background launch returns", async () => {
    const send = vi.fn(async (method: string) => method === "Browser.getWindowForTarget"
      ? { windowId: 7 }
      : {});
    const detach = vi.fn(async () => undefined);
    const makePage = () => {
      const page = {} as { context(): unknown };
      const context = {
        newCDPSession: vi.fn(async () => ({ send, detach }))
      };
      page.context = () => context;
      return page;
    };
    const pages = [makePage(), makePage()];
    const browser = {
      contexts: () => [{ pages: () => pages }]
    };

    await expect(minimizeConnectedChromeWindows(browser as never, Date.now() + 1_000))
      .resolves.toBeUndefined();

    expect(send.mock.calls.filter(([method]) => method === "Browser.setWindowBounds")).toEqual([[
      "Browser.setWindowBounds",
      { windowId: 7, bounds: { windowState: "minimized" } }
    ]]);
    expect(detach).toHaveBeenCalledTimes(2);
  });
});
describe("browser remote debugging validation", () => {
  it("bounds a hung readiness probe by one tiny lifecycle budget", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const startedAt = Date.now();

    await expect(waitForRemoteDebugging(65534, { timeoutMs: 35 })).rejects.toThrow("did not become ready");

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("bounds DevToolsActivePort polling by the requested lifecycle budget", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-deadline-"));
    const startedAt = Date.now();
    try {
      await expect(waitForDevToolsActivePort(
        { ASK_HOME: askHome } as NodeJS.ProcessEnv,
        { timeoutMs: 35 }
      )).rejects.toThrow("DevToolsActivePort");
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(15);
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("bounds a hung raw DevToolsActivePort file read by the shared deadline", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-read-deadline-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    const activePortPath = getDevToolsActivePortPath(env);
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation(((filePath: fs.PathLike, options?: unknown) => {
      if (String(filePath) === activePortPath) {
        return new Promise<never>(() => undefined);
      }
      return Reflect.apply(originalReadFile, fs.promises, [filePath, options]);
    }) as typeof fs.promises.readFile);
    const startedAt = Date.now();

    try {
      await expect(readDevToolsActivePort(env, { timeoutMs: 35 })).rejects.toThrow("Timed out reading");
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(15);
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("never deletes a stale DevToolsActivePort file before an automatic launch", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-active-delete-"));
    const env = {
      ...process.env,
      ASK_HOME: askHome,
      ASK_CHROME_PATH: process.execPath
    } as NodeJS.ProcessEnv;
    const activePortPath = getDevToolsActivePortPath(env);
    await fs.promises.mkdir(path.dirname(activePortPath), { recursive: true });
    await fs.promises.writeFile(activePortPath, "54320\n/devtools/browser/old\n", "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("debugging endpoint is not ready");
    }));

    const unlink = vi.spyOn(fs.promises, "unlink");
    try {
      await expect(ensureChrome({ env, timeoutMs: 150 })).rejects.toThrow(
        /fresh automatic debugging endpoint|launching Google Chrome|Timed out/
      );
      expect(unlink.mock.calls.some(([filePath]) => String(filePath) === activePortPath)).toBe(false);
      await expect(readDevToolsActivePort(env)).resolves.toBe(54320);
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("repairs an exact-generation automatic Chrome self-restart without launching or closing", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-auto-drift-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    const profileDir = path.join(askHome, "chrome-profile");
    const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const generation = "stable-generation";
    const newPort = 54321;
    const owner = {
      pid: 4321,
      creationTime: "new-process-generation",
      executablePath: chromePath,
      args: [
        chromePath,
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        `--ask-session-generation=${generation}`
      ]
    };
    try {
      await writeProfileMarker(env);
      const old = await writeSessionState(env, {
        pid: 1234,
        port: 54320,
        chromePath,
        headless: false,
        processCreationTime: "old-process-generation",
        generation,
        portPolicy: "automatic",
        requestedPort: 0
      });

      const result = await reconcileAutomaticChromeSession(env, { timeoutMs: 1_000 }, {
        readActivePort: async () => newPort,
        getVersion: async () => ({
          Browser: "Chrome/151.0.0.0",
          "User-Agent": "Mozilla/5.0 Chrome/151.0.0.0",
          webSocketDebuggerUrl: `ws://127.0.0.1:${newPort}/devtools/browser/restarted`
        }),
        getPortOwner: async () => owner,
        getProfileProcesses: async () => [owner]
      });

      expect(result).toMatchObject({ repaired: true, activePort: newPort });
      await expect(readSessionState(env)).resolves.toMatchObject({
        nonce: expect.not.stringMatching(old.nonce),
        pid: owner.pid,
        port: newPort,
        processCreationTime: owner.creationTime,
        generation,
        portPolicy: "automatic",
        requestedPort: 0
      });
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "a different generation", persistedGeneration: "old-generation", ownerGeneration: "new-generation" },
    { name: "a missing legacy generation", persistedGeneration: undefined, ownerGeneration: undefined }
  ])("refuses automatic drift from $name", async ({ persistedGeneration, ownerGeneration }) => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-unsafe-drift-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    const profileDir = path.join(askHome, "chrome-profile");
    const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const newPort = 54321;
    const ownerArgs = [chromePath, "--remote-debugging-port=0", `--user-data-dir=${profileDir}`];
    if (ownerGeneration) {
      ownerArgs.push(`--ask-session-generation=${ownerGeneration}`);
    }
    const owner = {
      pid: 4321,
      creationTime: "new-process-generation",
      executablePath: chromePath,
      args: ownerArgs
    };
    try {
      await writeProfileMarker(env);
      await writeSessionState(env, {
        pid: 1234,
        port: 54320,
        chromePath,
        headless: false,
        processCreationTime: "old-process-generation",
        generation: persistedGeneration,
        portPolicy: "automatic",
        requestedPort: 0
      });

      await expect(reconcileAutomaticChromeSession(env, { timeoutMs: 1_000 }, {
        readActivePort: async () => newPort,
        getVersion: async () => ({
          Browser: "Chrome/151.0.0.0",
          webSocketDebuggerUrl: `ws://127.0.0.1:${newPort}/devtools/browser/unverified`
        }),
        getPortOwner: async () => owner,
        getProfileProcesses: async () => [owner]
      })).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
      await expect(readSessionState(env)).resolves.toMatchObject({ pid: 1234, port: 54320 });
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("never migrates a pinned session to DevToolsActivePort", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-pinned-drift-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    const profileDir = path.join(askHome, "chrome-profile");
    const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const generation = "pinned-generation";
    const owner = {
      pid: 4321,
      creationTime: "new-process-generation",
      executablePath: chromePath,
      args: [
        chromePath,
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        `--ask-session-generation=${generation}`
      ]
    };
    try {
      await writeProfileMarker(env);
      await writeSessionState(env, {
        pid: 1234,
        port: 9222,
        chromePath,
        headless: false,
        generation,
        portPolicy: "pinned",
        requestedPort: 9222
      });
      await expect(reconcileAutomaticChromeSession(env, { timeoutMs: 1_000 }, {
        readActivePort: async () => 54321,
        getVersion: async () => ({
          Browser: "Chrome/151.0.0.0",
          webSocketDebuggerUrl: "ws://127.0.0.1:54321/devtools/browser/pinned"
        }),
        getPortOwner: async () => owner,
        getProfileProcesses: async () => [owner]
      })).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
      await expect(readSessionState(env)).resolves.toMatchObject({ port: 9222, portPolicy: "pinned" });
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("rejects a pinned arbitrary TCP listener as a session conflict before launch", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-port-owner-"));
    const socket = new EventEmitter() as EventEmitter & {
      unref(): void;
      destroy(): void;
    };
    socket.unref = () => undefined;
    socket.destroy = () => undefined;
    vi.spyOn(net, "createConnection").mockImplementation(() => {
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as ReturnType<typeof net.createConnection>;
    });
    const port = 45678;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));

    try {
      await expect(ensureChrome({
        env: {
          ASK_HOME: askHome,
          ASK_CHROME_PATH: process.execPath
        } as NodeJS.ProcessEnv,
        port,
        timeoutMs: 1_000
      })).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
      await expect(readDevToolsActivePort({ ASK_HOME: askHome } as NodeJS.ProcessEnv)).resolves.toBeUndefined();
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("stops a launched process and leaves no session state when the lifecycle deadline expires", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-launch-timeout-"));
    const fakeChromePath = path.join(askHome, "fake-chrome");
    const pidPath = path.join(askHome, "spawned.pid");
    await fs.promises.writeFile(
      fakeChromePath,
      `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `fs.writeFileSync(process.argv[process.argv.length - 1], String(process.pid));\n` +
      `setInterval(() => undefined, 1000);\n`,
      { mode: 0o755 }
    );
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("debugging endpoint is not ready");
    }));
    const env = {
      ...process.env,
      ASK_HOME: askHome,
      ASK_CHROME_PATH: fakeChromePath
    } as NodeJS.ProcessEnv;
    let spawnedPid: number | undefined;

    try {
      await expect(ensureChrome({
        env,
        port: 45679,
        url: pidPath,
        timeoutMs: 750
      })).rejects.toThrow(/Timed out|did not become ready/);

      for (let attempt = 0; attempt < 50 && spawnedPid === undefined; attempt += 1) {
        try {
          spawnedPid = Number(await fs.promises.readFile(pidPath, "utf8"));
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      for (let attempt = 0; spawnedPid !== undefined && attempt < 30 && isProcessAlive(spawnedPid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (spawnedPid !== undefined) {
        expect(isProcessAlive(spawnedPid)).toBe(false);
      }
      await expect(readSessionState(env)).resolves.toBeUndefined();
    } finally {
      if (spawnedPid !== undefined && isProcessAlive(spawnedPid)) {
        try {
          process.kill(spawnedPid, "SIGTERM");
        } catch {
          // The timeout cleanup may have completed between the liveness check and signal.
        }
      }
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

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
        portPolicy: "pinned",
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
    expect(shouldRestartChromeForMode(headless, { desiredMode: "preserve" })).toBe(false);
    expect(() => resolveChromeMode({ desiredMode: "headless", requireVisible: true })).toThrow("conflicts");
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

    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-conflict-"));
    try {
      await expect(ensureChrome({
        env: { ASK_HOME: askHome } as NodeJS.ProcessEnv,
        port: 9444,
        requireVisible: true
      })).rejects.toThrow("headless Chrome session");
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("reports no assigned port before an automatic session exists", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-auto-inspection-"));
    try {
      const inspection = await inspectChromeSession({
        env: { ASK_HOME: askHome } as NodeJS.ProcessEnv
      });
      expect(inspection).toMatchObject({
        portPolicy: "automatic",
        connected: false,
        classification: { ownership: "absent" }
      });
      expect(inspection.port).toBeUndefined();
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("retains the assigned automatic port when its endpoint becomes stale", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-stale-inspection-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    await writeSessionState(env, {
      pid: 2_147_483_647,
      port: 54321,
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      portPolicy: "automatic",
      requestedPort: 0
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("not running");
    }));

    try {
      await expect(inspectChromeSession({ env })).resolves.toMatchObject({
        port: 54321,
        portPolicy: "automatic",
        connected: false,
        classification: { ownership: "absent" }
      });
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("refuses to close an external Chrome debugging endpoint", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-close-external-"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Browser: "Chrome/149.0.0.0" }), { status: 200 })));
    const connect = vi.spyOn(chromium, "connectOverCDP");
    try {
      await expect(closeChromeOnPort(9555, {
        env: { ASK_HOME: askHome } as NodeJS.ProcessEnv
      })).rejects.toThrow("not an ask-managed session");
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("keeps Browser.close guarded while a same-generation uncertain target is live", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-ambiguity-live-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    const marker = {
      version: 1 as const,
      provider: "chatgpt" as const,
      targetId: "live-target",
      sessionGeneration: "generation-live",
      createdAt: new Date().toISOString(),
      fileName: "ambiguity-00000000-0000-4000-8000-000000000001.json"
    };
    const send = vi.fn(async (method: string) => method === "Target.getTargets"
      ? { targetInfos: [{ targetId: "live-target" }] }
      : {});
    try {
      await writeDeliveryAmbiguityMarker(env, marker);
      await expect(assertNoLiveDeliveryAmbiguityBeforeClose(
        { send } as never,
        env,
        "generation-live",
        Date.now() + 1_000
      )).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
      expect(send).toHaveBeenCalledWith("Target.getTargets");
      expect(send).not.toHaveBeenCalledWith("Browser.close");
      await expect(listDeliveryAmbiguityMarkers(env)).resolves.toHaveLength(1);
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("reclaims only closed or stale ambiguity records before a guarded retry", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-ambiguity-reclaim-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    const createdAt = new Date().toISOString();
    const live = {
      version: 1 as const,
      provider: "chatgpt" as const,
      targetId: "live-target",
      sessionGeneration: "generation-current",
      createdAt,
      fileName: "ambiguity-00000000-0000-4000-8000-000000000002.json"
    };
    const closed = {
      version: 1 as const,
      provider: "gemini" as const,
      targetId: "closed-target",
      sessionGeneration: "generation-current",
      createdAt,
      fileName: "ambiguity-00000000-0000-4000-8000-000000000003.json"
    };
    const staleGeneration = {
      version: 1 as const,
      provider: "chatgpt" as const,
      targetId: "old-target",
      sessionGeneration: "generation-old",
      createdAt,
      fileName: "ambiguity-00000000-0000-4000-8000-000000000004.json"
    };
    const send = vi.fn(async () => ({ targetInfos: [{ targetId: "live-target" }] }));
    try {
      await Promise.all([
        writeDeliveryAmbiguityMarker(env, live),
        writeDeliveryAmbiguityMarker(env, closed),
        writeDeliveryAmbiguityMarker(env, staleGeneration)
      ]);
      await expect(assertNoLiveDeliveryAmbiguityBeforeClose(
        { send } as never,
        env,
        "generation-current",
        Date.now() + 1_000
      )).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
      await expect(listDeliveryAmbiguityMarkers(env)).resolves.toMatchObject([
        { targetId: "live-target", sessionGeneration: "generation-current" }
      ]);

      await expect(assertNoLiveDeliveryAmbiguityBeforeClose(
        { send: vi.fn(async () => ({ targetInfos: [] })) } as never,
        env,
        "generation-current",
        Date.now() + 1_000
      )).resolves.toBeUndefined();
      await expect(listDeliveryAmbiguityMarkers(env)).resolves.toEqual([]);
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("fails closed when target inspection exceeds the shared lifecycle deadline", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-browser-ambiguity-deadline-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    const marker = {
      version: 1 as const,
      provider: "chatgpt" as const,
      targetId: "hung-target",
      sessionGeneration: "generation-hung",
      createdAt: new Date().toISOString(),
      fileName: "ambiguity-00000000-0000-4000-8000-000000000005.json"
    };
    try {
      await writeDeliveryAmbiguityMarker(env, marker);
      await expect(assertNoLiveDeliveryAmbiguityBeforeClose(
        { send: vi.fn(() => new Promise(() => undefined)) } as never,
        env,
        "generation-hung",
        Date.now() + 25
      )).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
      await expect(listDeliveryAmbiguityMarkers(env)).resolves.toHaveLength(1);
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });
});
