import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { getChromeProfileDir, getRemoteDebuggingPort } from "./config";
import {
  classifySession,
  getProcessInfo,
  writeProfileMarker,
  writeSessionState,
  withSessionLock,
  type SessionClassification
} from "./session";

export interface ChromeLaunchOptions {
  env?: NodeJS.ProcessEnv;
  headless?: boolean;
  port?: number;
  requireVisible?: boolean;
  requireManaged?: boolean;
  url?: string;
  verbose?: boolean;
  launchIfNeeded?: boolean;
}

export interface RemoteDebuggingVersion {
  Browser?: unknown;
  "User-Agent"?: unknown;
}

export interface ChromeSessionInspection {
  port: number;
  connected: boolean;
  classification: SessionClassification;
  headless?: boolean;
  browser?: string;
  userAgent?: string;
}

export type ChromeSessionRequest = Omit<ChromeLaunchOptions, "env">;

export class ChromeSessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromeSessionConflictError";
  }
}

export interface ChromeSessionController {
  connect(options?: ChromeSessionRequest): Promise<Browser>;
  inspect(options?: ChromeSessionRequest): Promise<ChromeSessionInspection>;
  waitUntilReady(timeoutMs?: number): Promise<void>;
}

export function createChromeSessionController(env: NodeJS.ProcessEnv = process.env): ChromeSessionController {
  return {
    connect: (options = {}) => connectToChrome({ ...options, env }),
    inspect: (options = {}) => inspectChromeSession({ ...options, env }),
    waitUntilReady: (timeoutMs = 15_000) => waitForRemoteDebugging(getRemoteDebuggingPort(env), timeoutMs)
  };
}

export function getChromeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    env.ProgramFiles && path.win32.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    env["ProgramFiles(x86)"] && path.win32.join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    env.LocalAppData && path.win32.join(env.LocalAppData, "Google", "Chrome", "Application", "chrome.exe")
  ];

  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

export function resolveChromePath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (filePath: string) => boolean = fs.existsSync
): string {
  if (env.ASK_CHROME_PATH) {
    if (!exists(env.ASK_CHROME_PATH)) {
      throw new Error(`ASK_CHROME_PATH does not exist: ${env.ASK_CHROME_PATH}`);
    }
    return env.ASK_CHROME_PATH;
  }

  const match = getChromeCandidates(env).find((candidate) => exists(candidate));
  if (!match) {
    throw new Error("Google Chrome was not found. Set ASK_CHROME_PATH to chrome.exe.");
  }

  return match;
}

export async function isRemoteDebuggingReady(port: number): Promise<boolean> {
  return Boolean(await getRemoteDebuggingVersion(port));
}

export async function getRemoteDebuggingVersion(port: number): Promise<RemoteDebuggingVersion | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) {
      return undefined;
    }

    const body: unknown = await response.json();
    return body && typeof body === "object" ? body as RemoteDebuggingVersion : {};
  } catch {
    return undefined;
  }
}

export function isHeadlessRemoteDebugging(version: RemoteDebuggingVersion): boolean {
  const browser = typeof version.Browser === "string" ? version.Browser : "";
  const userAgent = typeof version["User-Agent"] === "string" ? version["User-Agent"] : "";
  return browser.includes("HeadlessChrome/") || userAgent.includes("HeadlessChrome/");
}

export function shouldRestartChromeForMode(
  version: RemoteDebuggingVersion,
  options: ChromeLaunchOptions
): boolean {
  const currentlyHeadless = isHeadlessRemoteDebugging(version);
  return (
    (options.headless === true && !currentlyHeadless) ||
    (options.requireVisible === true && currentlyHeadless)
  );
}

function formatOwnershipError(port: number, classification: SessionClassification): string {
  return (
    `Chrome remote debugging on port ${port} is not an ask-managed session (${classification.ownership}). ` +
    `${classification.reason || "The session could not be verified."} ` +
    "Run `ask status` to inspect it, or set ASK_REMOTE_DEBUGGING_PORT/ASK_HOME for a separate ask session."
  );
}

async function ensureManagedSession(env: NodeJS.ProcessEnv, port: number, version: RemoteDebuggingVersion): Promise<SessionClassification> {
  const classification = await classifySession(env, port, true);
  if (classification.ownership !== "ask-managed") {
    throw new ChromeSessionConflictError(formatOwnershipError(port, classification));
  }

  if (!classification.state && classification.process) {
    await writeProfileMarker(env);
    await writeSessionState(env, {
      pid: classification.process.pid,
      port,
      chromePath: classification.process.executablePath || resolveChromePath(env),
      headless: isHeadlessRemoteDebugging(version),
      processCreationTime: classification.process.creationTime
    });
  }

  return classification;
}

async function assertRemoteDebuggingCompatible(port: number, version: RemoteDebuggingVersion, options: ChromeLaunchOptions): Promise<void> {
  const env = options.env || process.env;

  if (options.requireManaged) {
    await ensureManagedSession(env, port, version);
  }

  const currentlyHeadless = isHeadlessRemoteDebugging(version);
  const requestedHeadless = options.headless === true;
  const modeMismatch = shouldRestartChromeForMode(version, options);
  if (!modeMismatch) {
    return;
  }

  const classification = await classifySession(env, port, true);
  if (classification.ownership === "ask-managed") {
    await restartInMode(port, options, requestedHeadless);
    return;
  }

  const currentMode = currentlyHeadless ? "headless" : "visible";
  const requestedMode = requestedHeadless ? "headless" : "visible";
  throw new ChromeSessionConflictError(
    `Chrome remote debugging on port ${port} is already attached to a ${currentMode} Chrome session, ` +
      `but ${requestedMode} mode was requested and it is not safe to replace the session automatically ` +
      `(${classification.ownership}). ` +
      `${classification.reason || "The session could not be verified."} Run \`ask status\` to inspect it.`
  );
}

export async function waitForRemoteDebugging(port: number, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isRemoteDebuggingReady(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Chrome remote debugging did not become ready on port ${port}. ` +
      "Run `ask login` again to restart the dedicated ask Chrome profile."
  );
}

export async function waitForRemoteDebuggingToClose(port: number, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await isRemoteDebuggingReady(port))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Chrome remote debugging on port ${port} did not close in time.`);
}

export function buildChromeArgs(options: ChromeLaunchOptions = {}): string[] {
  const env = options.env || process.env;
  const port = options.port || getRemoteDebuggingPort(env);
  const profileDir = getChromeProfileDir(env);
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ];

  if (options.headless) {
    args.push("--headless=new");
  } else {
    args.push("--new-window");
  }

  args.push(options.url || "about:blank");
  return args;
}

export async function launchChrome(options: ChromeLaunchOptions = {}): Promise<number> {
  const env = options.env || process.env;
  const chromePath = resolveChromePath(env);
  const port = options.port || getRemoteDebuggingPort(env);
  fs.mkdirSync(getChromeProfileDir(env), { recursive: true });
  await writeProfileMarker(env);
  const args = buildChromeArgs({ ...options, port });

  if (options.verbose) {
    process.stderr.write(`Launching Chrome: ${chromePath} ${args.join(" ")}\n`);
  }

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new Error("Chrome launched but did not report a process id.");
  }

  const processInfo = await getProcessInfo(pid);
  await writeSessionState(env, {
    pid,
    port,
    chromePath,
    headless: Boolean(options.headless),
    processCreationTime: processInfo?.creationTime
  });

  return pid;
}

export async function closeChromeOnPort(port: number, options: ChromeLaunchOptions = {}): Promise<void> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.close");
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function restartInMode(port: number, options: ChromeLaunchOptions, headless: boolean): Promise<void> {
  const env = options.env || process.env;
  await withSessionLock(env, async () => {
    const currentVersion = await getRemoteDebuggingVersion(port);
    if (currentVersion && isHeadlessRemoteDebugging(currentVersion) === headless) {
      return;
    }
    if (currentVersion) {
      await closeChromeOnPort(port, options);
      await waitForRemoteDebuggingToClose(port);
    }
    await launchChrome({ ...options, env, port, headless });
    await waitForRemoteDebugging(port);
  });
}

export async function getChromeSessionClassification(options: ChromeLaunchOptions = {}): Promise<SessionClassification> {
  const env = options.env || process.env;
  const port = options.port || getRemoteDebuggingPort(env);
  return classifySession(env, port, Boolean(await getRemoteDebuggingVersion(port)));
}

export async function inspectChromeSession(options: ChromeLaunchOptions = {}): Promise<ChromeSessionInspection> {
  const env = options.env || process.env;
  const port = options.port || getRemoteDebuggingPort(env);
  const version = await getRemoteDebuggingVersion(port);
  const classification = await classifySession(env, port, Boolean(version));

  if (!version) {
    return { port, connected: false, classification };
  }

  return {
    port,
    connected: true,
    classification,
    headless: isHeadlessRemoteDebugging(version),
    browser: typeof version.Browser === "string" ? version.Browser : undefined,
    userAgent: typeof version["User-Agent"] === "string" ? version["User-Agent"] : undefined
  };
}

export async function ensureChrome(options: ChromeLaunchOptions = {}): Promise<number> {
  const env = options.env || process.env;
  const port = options.port || getRemoteDebuggingPort(env);
  const existingVersion = await getRemoteDebuggingVersion(port);
  if (existingVersion) {
    await assertRemoteDebuggingCompatible(port, existingVersion, { ...options, env, port });
    return port;
  }

  await withSessionLock(env, async () => {
    const racedVersion = await getRemoteDebuggingVersion(port);
    if (racedVersion) {
      await assertRemoteDebuggingCompatible(port, racedVersion, { ...options, env, port });
      return;
    }

    await launchChrome({ ...options, env, port });
    await waitForRemoteDebugging(port);
    const launchedVersion = await getRemoteDebuggingVersion(port);
    if (launchedVersion) {
      await assertRemoteDebuggingCompatible(port, launchedVersion, { ...options, env, port });
    }
  });
  return port;
}

export async function connectToChrome(options: ChromeLaunchOptions = {}): Promise<Browser> {
  const env = options.env || process.env;
  const port = options.port || getRemoteDebuggingPort(env);
  if (options.launchIfNeeded === false) {
    const version = await getRemoteDebuggingVersion(port);
    if (!version) {
      throw new Error(`No Chrome debugging session is available on port ${port}. Run 'ask login' first.`);
    }
    await assertRemoteDebuggingCompatible(port, version, { ...options, env, port });
  } else {
    await ensureChrome({ ...options, env, port });
  }
  if (options.verbose) {
    process.stderr.write(`Connecting to Chrome CDP: http://127.0.0.1:${port}\n`);
  }

  return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}

