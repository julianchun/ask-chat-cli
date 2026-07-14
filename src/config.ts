import os from "node:os";
import path from "node:path";

export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_REMOTE_DEBUGGING_PORT = 9222;

function joinConfiguredPath(root: string, child: string): string {
  return /^[a-zA-Z]:[\\/]/.test(root) || root.includes("\\")
    ? path.win32.join(root, child)
    : path.join(root, child);
}

export function getAskHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ASK_HOME || path.join(os.homedir(), ".ask");
}

export function getChromeProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return joinConfiguredPath(getAskHome(env), "chrome-profile");
}

export function getScreenshotsDir(env: NodeJS.ProcessEnv = process.env): string {
  return joinConfiguredPath(getAskHome(env), "screenshots");
}

export function getRemoteDebuggingPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ASK_REMOTE_DEBUGGING_PORT;
  if (!raw) {
    return DEFAULT_REMOTE_DEBUGGING_PORT;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("ASK_REMOTE_DEBUGGING_PORT must be an integer between 1 and 65535");
  }
  return port;
}
