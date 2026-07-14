import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifySession,
  getProfileMarkerPath,
  getSessionLockPath,
  getSessionStatePath,
  processMatchesAskSession,
  readSessionState,
  withSessionLock,
  writeProfileMarker,
  writeSessionState
} from "../src/session";

describe("session ownership helpers", () => {
  let tempDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-session-"));
    env = { ASK_HOME: tempDir } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("writes non-secret session state and profile marker", async () => {
    await writeProfileMarker(env);
    await writeSessionState(env, {
      pid: 1234,
      port: 9222,
      chromePath: "C:\\Chrome\\chrome.exe",
      headless: false,
      processCreationTime: "20260709120000.000000+000"
    });

    await expect(fs.promises.access(getProfileMarkerPath(env))).resolves.toBeUndefined();
    await expect(fs.promises.access(getSessionStatePath(env))).resolves.toBeUndefined();
    await expect(readSessionState(env)).resolves.toMatchObject({
      pid: 1234,
      port: 9222,
      profileDir: path.join(tempDir, "chrome-profile"),
      headless: false
    });
  });

  it("matches only processes with the ask profile and debugging port", () => {
    const profileDir = "C:\\Users\\Me\\.ask\\chrome-profile";

    expect(
      processMatchesAskSession(
        {
          pid: 1,
          commandLine: `chrome.exe --remote-debugging-port=9222 --user-data-dir=${profileDir}`
        },
        9222,
        profileDir
      )
    ).toBe(true);

    expect(
      processMatchesAskSession(
        {
          pid: 1,
          commandLine: "chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\Users\\Me\\Default"
        },
        9222,
        profileDir
      )
    ).toBe(false);
  });

  it("prevents concurrent session manager operations", async () => {
    await expect(
      withSessionLock(env, async () => {
        await expect(fs.promises.access(getSessionLockPath(env))).resolves.toBeUndefined();
        await expect(withSessionLock(env, async () => undefined)).rejects.toThrow("already in progress");
      })
    ).resolves.toBeUndefined();

    await expect(fs.promises.access(getSessionLockPath(env))).rejects.toThrow();
  });

  it("classifies absent, external, and mismatched lifecycle states", async () => {
    await expect(classifySession(env, 9222, false)).resolves.toMatchObject({ ownership: "absent" });
    await expect(classifySession(env, 9222, true)).resolves.toMatchObject({ ownership: "external" });

    await writeProfileMarker(env);
    await writeSessionState(env, {
      pid: process.pid,
      port: 9333,
      chromePath: "C:\\Chrome\\chrome.exe",
      headless: false
    });
    await expect(classifySession(env, 9222, true)).resolves.toMatchObject({ ownership: "external" });

  });
});
