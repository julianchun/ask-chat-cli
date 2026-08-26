import os from "node:os";
import path from "node:path";

export const DEFAULT_TIMEOUT_MS = 600_000;
/** @deprecated Unset ASK_REMOTE_DEBUGGING_PORT now requests an automatic port. */
export const DEFAULT_REMOTE_DEBUGGING_PORT = 9222;

export function joinConfiguredPath(root: string, child: string): string {
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

/**
 * Return the explicitly pinned remote-debugging port. An absent value is
 * intentionally left undefined so Chrome can allocate an ephemeral port.
 */
export function getRemoteDebuggingPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.ASK_REMOTE_DEBUGGING_PORT;
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("ASK_REMOTE_DEBUGGING_PORT must be an integer between 1 and 65535");
  }
  const port = Number(normalized);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("ASK_REMOTE_DEBUGGING_PORT must be an integer between 1 and 65535");
  }
  return port;
}
