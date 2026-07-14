import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAskHome, getChromeProfileDir } from "./config";

const execFileAsync = promisify(execFile);

export const SESSION_STATE_VERSION = 1;

export type SessionOwnership = "absent" | "ask-managed" | "external" | "unknown";

export interface SessionState {
  version: number;
  pid: number;
  port: number;
  profileDir: string;
  chromePath: string;
  headless: boolean;
  launchedAt: string;
  processCreationTime?: string;
  hostname: string;
  username: string;
  nonce: string;
}

export interface ProcessInfo {
  pid: number;
  name?: string;
  commandLine?: string;
  creationTime?: string;
  executablePath?: string;
}

export interface SessionClassification {
  ownership: SessionOwnership;
  state?: SessionState;
  process?: ProcessInfo;
  reason?: string;
}

export function getSessionStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getAskHome(env), "session.json");
}

export function getProfileMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getChromeProfileDir(env), ".ask-profile.json");
}

export function getSessionLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getAskHome(env), "chrome-manager.lock");
}

export async function withSessionLock<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  await fs.promises.mkdir(getAskHome(env), { recursive: true });
  const lockPath = getSessionLockPath(env);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await fn();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
      throw new Error("Another ask Chrome session operation is already in progress. Try again in a few seconds.");
    }
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
      await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
}
export function normalizePathForCompare(value: string): string {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(value) || value.includes("\\") ? path.win32 : path;
  return pathApi.resolve(value).toLowerCase();
}

export async function writeProfileMarker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const markerPath = getProfileMarkerPath(env);
  await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
  const marker = {
    manager: "ask",
    version: SESSION_STATE_VERSION,
    profileDir: getChromeProfileDir(env)
  };
  await fs.promises.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

export async function hasProfileMarker(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    await fs.promises.access(getProfileMarkerPath(env), fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readSessionState(env: NodeJS.ProcessEnv = process.env): Promise<SessionState | undefined> {
  try {
    const text = await fs.promises.readFile(getSessionStatePath(env), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    const state = parsed as Partial<SessionState>;
    if (
      state.version !== SESSION_STATE_VERSION ||
      typeof state.pid !== "number" ||
      typeof state.port !== "number" ||
      typeof state.profileDir !== "string" ||
      typeof state.chromePath !== "string" ||
      typeof state.headless !== "boolean" ||
      typeof state.nonce !== "string"
    ) {
      return undefined;
    }

    return state as SessionState;
  } catch {
    return undefined;
  }
}

export async function writeSessionState(
  env: NodeJS.ProcessEnv,
  input: {
    pid: number;
    port: number;
    chromePath: string;
    headless: boolean;
    processCreationTime?: string;
  }
): Promise<SessionState> {
  const state: SessionState = {
    version: SESSION_STATE_VERSION,
    pid: input.pid,
    port: input.port,
    profileDir: getChromeProfileDir(env),
    chromePath: input.chromePath,
    headless: input.headless,
    launchedAt: new Date().toISOString(),
    processCreationTime: input.processCreationTime,
    hostname: os.hostname(),
    username: os.userInfo().username,
    nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`
  };

  await fs.promises.mkdir(getAskHome(env), { recursive: true });
  await fs.promises.writeFile(getSessionStatePath(env), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export async function getProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  if (process.platform === "win32") {
    return getWindowsProcessInfo(pid);
  }

  try {
    process.kill(pid, 0);
    return { pid };
  } catch {
    return undefined;
  }
}

export async function getPortOwnerProcessInfo(port: number): Promise<ProcessInfo | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`
    ]);
    const pid = Number(stdout.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      return undefined;
    }
    return getProcessInfo(pid);
  } catch {
    return undefined;
  }
}

async function getWindowsProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | ConvertTo-Json -Compress`
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    const value = parsed as Record<string, unknown>;
    return {
      pid,
      name: typeof value.Name === "string" ? value.Name : undefined,
      commandLine: typeof value.CommandLine === "string" ? value.CommandLine : undefined,
      creationTime: typeof value.CreationDate === "string" ? value.CreationDate : undefined,
      executablePath: typeof value.ExecutablePath === "string" ? value.ExecutablePath : undefined
    };
  } catch {
    return undefined;
  }
}

export async function classifySession(
  env: NodeJS.ProcessEnv,
  port: number,
  debuggingConnected: boolean
): Promise<SessionClassification> {
  if (!debuggingConnected) {
    return { ownership: "absent", reason: "No Chrome debugging endpoint is available." };
  }

  const state = await readSessionState(env);
  if (!state) {
    const processInfo = await getPortOwnerProcessInfo(port);
    if (processInfo && processMatchesAskSession(processInfo, port, getChromeProfileDir(env))) {
      return {
        ownership: "ask-managed",
        process: processInfo,
        reason: "Chrome debugging matches the ask profile and port but has no session state yet."
      };
    }
    return { ownership: "external", process: processInfo, reason: "Chrome debugging is available, but no ask session state was found." };
  }

  if (state.port !== port) {
    return { ownership: "external", state, reason: "Chrome debugging port does not match ask session state." };
  }

  if (normalizePathForCompare(state.profileDir) !== normalizePathForCompare(getChromeProfileDir(env))) {
    return { ownership: "unknown", state, reason: "Ask session state points to a different profile directory." };
  }

  if (!(await hasProfileMarker(env))) {
    return { ownership: "unknown", state, reason: "Ask profile marker is missing." };
  }

  const processInfo = await getProcessInfo(state.pid);
  if (!processInfo) {
    const portOwner = await getPortOwnerProcessInfo(port);
    if (portOwner && processMatchesAskSession(portOwner, port, state.profileDir)) {
      return { ownership: "ask-managed", state, process: portOwner, reason: "Ask state PID is stale, but the port owner matches the ask profile." };
    }
    return { ownership: "unknown", state, reason: "Ask session process is not running." };
  }

  if (processInfo.commandLine && !processMatchesAskSession(processInfo, port, state.profileDir)) {
    return { ownership: "unknown", state, process: processInfo, reason: "Process command line does not match ask port/profile." };
  }

  if (state.processCreationTime && processInfo.creationTime && state.processCreationTime !== processInfo.creationTime) {
    return { ownership: "unknown", state, process: processInfo, reason: "Process creation time does not match ask state." };
  }

  return { ownership: "ask-managed", state, process: processInfo };
}

export function processMatchesAskSession(processInfo: ProcessInfo, port: number, profileDir: string): boolean {
  const commandLine = (processInfo.commandLine || "").toLowerCase();
  if (!commandLine) {
    return false;
  }

  const expectedProfile = normalizePathForCompare(profileDir);
  const expectedProfileAlt = expectedProfile.replace(/\\/g, "/");
  return (
    commandLine.includes(`--remote-debugging-port=${port}`.toLowerCase()) &&
    (commandLine.includes(`--user-data-dir=${expectedProfile}`) ||
      commandLine.includes(`--user-data-dir="${expectedProfile}"`) ||
      commandLine.includes(`--user-data-dir=${expectedProfileAlt}`) ||
      commandLine.includes(`--user-data-dir="${expectedProfileAlt}"`))
  );
}

