import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifySession,
  getProcessInfo,
  getProfileMarkerPath,
  getSessionLockPath,
  getSessionStatePath,
  hasProfileMarker,
  normalizePathForCompare,
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
    vi.restoreAllMocks();
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

  it("keeps version-1 state readable when generation is absent", async () => {
    const legacyState = {
      version: 1,
      pid: 1234,
      port: 9222,
      profileDir: path.join(tempDir, "chrome-profile"),
      chromePath: "C:\\Chrome\\chrome.exe",
      headless: false,
      launchedAt: "2026-08-06T12:00:00.000Z",
      hostname: "host",
      username: "user",
      nonce: "legacy-nonce"
    };
    await fs.promises.writeFile(getSessionStatePath(env), JSON.stringify(legacyState), "utf8");

    await expect(readSessionState(env)).resolves.toMatchObject({
      version: 1,
      port: 9222,
      nonce: "legacy-nonce"
    });
  });

  it("atomically replaces session state without leaving temporary files", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => writeSessionState(env, {
      pid: 2000 + index,
      port: 9300 + index,
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: index % 2 === 0,
      generation: `generation-${index}`
    })));

    await expect(readSessionState(env)).resolves.toMatchObject({ version: 1 });
    const files = await fs.promises.readdir(tempDir);
    expect(files.filter((file) => file.includes("session.json.") && file.endsWith(".tmp"))).toEqual([]);
  });

  it("removes a profile marker that publishes after its write deadline", async () => {
    const markerPath = getProfileMarkerPath(env);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let releaseRename: (() => void) | undefined;
    let markRenameStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const renameStarted = new Promise<void>((resolve) => {
      markRenameStarted = resolve;
    });
    let gatedFirstPublication = false;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (oldPath, newPath) => {
      if (!gatedFirstPublication && String(newPath) === markerPath) {
        gatedFirstPublication = true;
        markRenameStarted?.();
        await gate;
      }
      await originalRename(oldPath, newPath);
    });

    const writing = writeProfileMarker(env, { timeoutMs: 100 });
    await renameStarted;
    await expect(writing).rejects.toThrow("Timed out writing");
    await expect(fs.promises.access(markerPath)).rejects.toThrow();

    let newerOwnerEntered = false;
    const newerWrite = withSessionLock(env, async () => {
      newerOwnerEntered = true;
      await writeProfileMarker(env);
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(newerOwnerEntered).toBe(false);

    releaseRename?.();
    await newerWrite;
    expect(newerOwnerEntered).toBe(true);
    await expect(hasProfileMarker(env)).resolves.toBe(true);
  });

  it("removes session state that publishes after its persistence deadline", async () => {
    const statePath = getSessionStatePath(env);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let releaseRename: (() => void) | undefined;
    let markRenameStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const renameStarted = new Promise<void>((resolve) => {
      markRenameStarted = resolve;
    });
    let gatedFirstPublication = false;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (oldPath, newPath) => {
      if (!gatedFirstPublication && String(newPath) === statePath) {
        gatedFirstPublication = true;
        markRenameStarted?.();
        await gate;
      }
      await originalRename(oldPath, newPath);
    });

    const writing = writeSessionState(env, {
      pid: 1234,
      port: 9222,
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      generation: "late-state-generation"
    }, { timeoutMs: 100 });
    await renameStarted;
    await expect(writing).rejects.toThrow("Timed out persisting");
    await expect(readSessionState(env)).resolves.toBeUndefined();

    let newerOwnerEntered = false;
    const newerWrite = withSessionLock(env, async () => {
      newerOwnerEntered = true;
      await writeSessionState(env, {
        pid: 5678,
        port: 9333,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: false,
        generation: "newer-state-generation"
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(newerOwnerEntered).toBe(false);

    releaseRename?.();
    await newerWrite;
    expect(newerOwnerEntered).toBe(true);
    await expect(readSessionState(env)).resolves.toMatchObject({
      port: 9333,
      generation: "newer-state-generation"
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

    expect(
      processMatchesAskSession(
        {
          pid: 1,
          commandLine: "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --remote-debugging-port 0 --user-data-dir '/Users/Me/Ask Profile'"
        },
        0,
        "/Users/Me/Ask Profile"
      )
    ).toBe(true);
    expect(
      processMatchesAskSession(
        {
          pid: 1,
          commandLine: "Google Chrome --remote-debugging-port=0 --user-data-dir=/Users/Me/Ask Profile --no-first-run"
        },
        0,
        "/Users/Me/Ask Profile"
      )
    ).toBe(true);

    const generatedProcess = {
      pid: 1,
      commandLine: `chrome --remote-debugging-port=0 --user-data-dir="${profileDir}" --ask-session-generation=generation-a`
    };
    expect(processMatchesAskSession(generatedProcess, 0, profileDir, "generation-a")).toBe(true);
    expect(processMatchesAskSession(generatedProcess, 0, profileDir, "generation-b")).toBe(false);
  });

  it("rejects internally inconsistent additive version-1 port metadata", async () => {
    await expect(writeSessionState(env, {
      pid: 1234,
      port: 9222,
      chromePath: "C:\\Chrome\\chrome.exe",
      headless: false,
      portPolicy: "automatic",
      requestedPort: 9222
    })).rejects.toThrow("inconsistent");
  });

  it("bounds hung session-state and profile-marker reads by their shared deadlines", async () => {
    const statePath = getSessionStatePath(env);
    const markerPath = getProfileMarkerPath(env);
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation(((filePath: fs.PathLike, options?: unknown) => {
      if (String(filePath) === statePath || String(filePath) === markerPath) {
        return new Promise<never>(() => undefined);
      }
      return Reflect.apply(originalReadFile, fs.promises, [filePath, options]);
    }) as typeof fs.promises.readFile);

    const stateStartedAt = Date.now();
    await expect(readSessionState(env, { timeoutMs: 35 })).rejects.toThrow("Timed out reading");
    expect(Date.now() - stateStartedAt).toBeLessThan(500);

    const markerStartedAt = Date.now();
    await expect(hasProfileMarker(env, { timeoutMs: 35 })).rejects.toThrow("Timed out reading");
    expect(Date.now() - markerStartedAt).toBeLessThan(500);
  });

  it("rejects a nested lifecycle lock instead of self-deadlocking", async () => {
    await withSessionLock(env, async () => {
      await expect(withSessionLock(env, async () => undefined)).rejects.toThrow("not reentrant");
    });
  });

  it("serializes independent concurrent session manager operations", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withSessionLock(env, async () => {
      await expect(fs.promises.access(getSessionLockPath(env))).resolves.toBeUndefined();
      markStarted?.();
      await firstGate;
      order.push("first");
    });
    await firstStarted;
    const second = withSessionLock(env, async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["first", "second"]);
    await expect(fs.promises.access(getSessionLockPath(env))).rejects.toThrow();
  });

  it("takes over a fresh lock when its owner is no longer alive", async () => {
    await fs.promises.writeFile(getSessionLockPath(env), JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-owner",
      createdAt: new Date().toISOString()
    }), "utf8");

    await expect(withSessionLock(env, async () => "acquired")).resolves.toBe("acquired");
    await expect(fs.promises.access(getSessionLockPath(env))).rejects.toThrow();
  });

  it("takes over a lock when its PID has been reused by another process generation", async () => {
    const currentProcess = await getProcessInfo(process.pid);
    if (!currentProcess?.creationTime) {
      // Restricted environments may deny the OS process-creation lookup. In
      // that case the lock deliberately treats a live PID conservatively.
      return;
    }
    await fs.promises.writeFile(getSessionLockPath(env), JSON.stringify({
      pid: process.pid,
      token: "reused-pid-owner",
      createdAt: new Date().toISOString(),
      processCreationTime: `${currentProcess.creationTime}-different`
    }), "utf8");

    await expect(withSessionLock(env, async () => "acquired")).resolves.toBe("acquired");
  });

  it("bounds lifecycle-lock contention by the caller's shared deadline", async () => {
    let releaseFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withSessionLock(env, async () => {
      markStarted?.();
      await gate;
    });
    await started;

    const startedAt = Date.now();
    await expect(withSessionLock(env, async () => undefined, { timeoutMs: 35 })).rejects.toThrow(
      "Timed out waiting"
    );
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(500);

    releaseFirst?.();
    await first;
  });

  it("bounds a hung ASK_HOME directory setup operation", async () => {
    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, "mkdir").mockImplementation(((directoryPath: fs.PathLike, options?: unknown) => {
      if (String(directoryPath) === tempDir) {
        return new Promise<never>(() => undefined);
      }
      return Reflect.apply(originalMkdir, fs.promises, [directoryPath, options]);
    }) as typeof fs.promises.mkdir);
    const startedAt = Date.now();

    await expect(withSessionLock(env, async () => undefined, { timeoutMs: 35 })).rejects.toThrow(
      "Timed out creating"
    );
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(500);
  });

  it.each(["writeFile", "sync"] as const)(
    "does not block cleanup when lifecycle-owner %s resolves after the deadline",
    async (blockedStep) => {
      let releaseStep: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseStep = resolve;
      });
      const close = vi.fn(async () => undefined);
      const fakeHandle = {
        writeFile: blockedStep === "writeFile" ? () => gate : async () => undefined,
        sync: blockedStep === "sync" ? () => gate : async () => undefined,
        close
      } as unknown as fs.promises.FileHandle;
      vi.spyOn(fs.promises, "open").mockResolvedValue(fakeHandle);
      const startedAt = Date.now();

      await expect(withSessionLock(env, async () => undefined, { timeoutMs: 35 })).rejects.toThrow("Timed out");
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(close).not.toHaveBeenCalled();

      releaseStep?.();
      for (let attempt = 0; attempt < 20 && close.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(close).toHaveBeenCalledOnce();
    }
  );

  it("removes a canonical lock published after its link deadline", async () => {
    const lockPath = getSessionLockPath(env);
    const originalLink = fs.promises.link.bind(fs.promises);
    let releaseLink: (() => void) | undefined;
    const linkGate = new Promise<void>((resolve) => {
      releaseLink = resolve;
    });
    vi.spyOn(fs.promises, "link").mockImplementation(async (existingPath, newPath) => {
      if (String(newPath) === lockPath) {
        await linkGate;
      }
      await originalLink(existingPath, newPath);
    });

    await expect(withSessionLock(env, async () => undefined, { timeoutMs: 35 })).rejects.toThrow("Timed out");
    expect((await fs.promises.readdir(tempDir)).some((name) => name.includes("chrome-manager.lock.owner."))).toBe(true);

    releaseLink?.();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const files = await fs.promises.readdir(tempDir);
      if (!files.some((name) => name.startsWith("chrome-manager.lock"))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await fs.promises.readdir(tempDir)).filter((name) => name.startsWith("chrome-manager.lock"))).toEqual([]);
  });

  it("reclaims a malformed legacy lock within one acquisition window", async () => {
    await fs.promises.writeFile(getSessionLockPath(env), "{", "utf8");
    const startedAt = Date.now();

    await expect(withSessionLock(env, async () => "acquired", { timeoutMs: 1_500 })).resolves.toBe("acquired");

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("recovers when a dead reclaimer leaves its guard behind", async () => {
    const lockPath = getSessionLockPath(env);
    const reclaimPath = `${lockPath}.reclaim`;
    await fs.promises.writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-lock-owner",
      createdAt: new Date().toISOString()
    }), "utf8");
    await fs.promises.mkdir(reclaimPath);
    await fs.promises.writeFile(path.join(reclaimPath, "owner.dead-reclaimer"), JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-reclaimer",
      createdAt: new Date().toISOString()
    }), "utf8");

    await expect(withSessionLock(env, async () => "acquired", { timeoutMs: 1_000 })).resolves.toBe("acquired");
    await expect(fs.promises.access(reclaimPath)).rejects.toThrow();
  });

  it("recovers a dead hard-linked file reclaim guard", async () => {
    const lockPath = getSessionLockPath(env);
    const reclaimPath = `${lockPath}.reclaim`;
    const deadPid = 2_147_483_647;
    const guardToken = "dead-file-reclaimer";
    const guardOwnerPath = `${reclaimPath}.owner.${deadPid}.${guardToken}`;
    await fs.promises.writeFile(lockPath, JSON.stringify({
      pid: deadPid,
      token: "dead-lock-owner",
      createdAt: new Date().toISOString()
    }), "utf8");
    await fs.promises.writeFile(guardOwnerPath, JSON.stringify({
      pid: deadPid,
      token: guardToken,
      createdAt: new Date().toISOString()
    }), "utf8");
    await fs.promises.link(guardOwnerPath, reclaimPath);

    await expect(withSessionLock(env, async () => "acquired", { timeoutMs: 1_000 })).resolves.toBe("acquired");
    await expect(fs.promises.access(reclaimPath)).rejects.toThrow();
    await expect(fs.promises.access(guardOwnerPath)).rejects.toThrow();
  });

  it("preserves a reaper sidecar when canonical release fails and recovers on retry", async () => {
    const lockPath = getSessionLockPath(env);
    const reclaimPath = `${lockPath}.reclaim`;
    const deadPid = 2_147_483_647;
    const guardToken = "release-failure-reclaimer";
    const guardOwnerPath = `${reclaimPath}.owner.${deadPid}.${guardToken}`;
    await fs.promises.writeFile(lockPath, JSON.stringify({
      pid: deadPid,
      token: "dead-lock-owner",
      createdAt: new Date().toISOString()
    }), "utf8");
    await fs.promises.writeFile(guardOwnerPath, JSON.stringify({
      pid: deadPid,
      token: guardToken,
      createdAt: new Date().toISOString()
    }), "utf8");
    await fs.promises.link(guardOwnerPath, reclaimPath);

    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    let injectedFailure = false;
    const unlinkSpy = vi.spyOn(fs.promises, "unlink").mockImplementation(async (filePath) => {
      if (!injectedFailure && String(filePath) === reclaimPath) {
        injectedFailure = true;
        throw Object.assign(new Error("forced reclaim release failure"), { code: "EIO" });
      }
      await originalUnlink(filePath);
    });

    await expect(withSessionLock(
      env,
      async () => undefined,
      { timeoutMs: 1_000 },
      { isProcessAlive: () => false }
    )).rejects.toThrow("forced reclaim release failure");

    const reclaimStat = await fs.promises.stat(reclaimPath);
    const reaperName = (await fs.promises.readdir(tempDir)).find((name) =>
      name.startsWith(`${path.basename(guardOwnerPath)}.reaping.`)
    );
    expect(reaperName).toBeDefined();
    const reaperStat = await fs.promises.stat(path.join(tempDir, reaperName!));
    expect({ dev: reaperStat.dev, ino: reaperStat.ino }).toEqual({
      dev: reclaimStat.dev,
      ino: reclaimStat.ino
    });

    unlinkSpy.mockRestore();
    await expect(withSessionLock(
      env,
      async () => "recovered",
      { timeoutMs: 1_000 },
      { isProcessAlive: () => false }
    )).resolves.toBe("recovered");
    await expect(fs.promises.access(reclaimPath)).rejects.toThrow();
  });

  it("reclaims a reaper claim when its PID has been reused", async () => {
    const lockPath = getSessionLockPath(env);
    const reclaimPath = `${lockPath}.reclaim`;
    const deadPid = 2_147_483_647;
    const guardToken = "pid-reuse-reclaimer";
    const guardOwnerPath = `${reclaimPath}.owner.${deadPid}.${guardToken}`;
    const oldCreationTime = Buffer.from("old-reaper-generation", "utf8").toString("base64url");
    const reaperClaimPath = `${guardOwnerPath}.reaping.${process.pid}.${oldCreationTime}.fixture`;
    await fs.promises.writeFile(lockPath, JSON.stringify({
      pid: deadPid,
      token: "dead-lock-owner",
      createdAt: new Date().toISOString()
    }), "utf8");
    await fs.promises.writeFile(guardOwnerPath, JSON.stringify({
      pid: deadPid,
      token: guardToken,
      createdAt: new Date().toISOString()
    }), "utf8");
    await fs.promises.link(guardOwnerPath, reclaimPath);
    await fs.promises.rename(guardOwnerPath, reaperClaimPath);

    await expect(withSessionLock(
      env,
      async () => "acquired",
      { timeoutMs: 1_000 },
      {
        isProcessAlive: (pid) => pid === process.pid,
        getProcessCreationTime: async (pid) => pid === process.pid ? "new-reaper-generation" : undefined
      }
    )).resolves.toBe("acquired");
    await expect(fs.promises.access(reclaimPath)).rejects.toThrow();
    await expect(fs.promises.access(reaperClaimPath)).rejects.toThrow();
  });

  it("bounds a hung stale-lock deletion while retaining the reclaim guard", async () => {
    const lockPath = getSessionLockPath(env);
    const reclaimPath = `${lockPath}.reclaim`;
    await fs.promises.writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-lock-owner",
      createdAt: new Date().toISOString()
    }), "utf8");
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    let releaseUnlink: (() => void) | undefined;
    let markUnlinkStarted: (() => void) | undefined;
    let gated = false;
    const gate = new Promise<void>((resolve) => {
      releaseUnlink = resolve;
    });
    const unlinkStarted = new Promise<void>((resolve) => {
      markUnlinkStarted = resolve;
    });
    vi.spyOn(fs.promises, "unlink").mockImplementation(async (filePath) => {
      if (!gated && String(filePath) === lockPath) {
        gated = true;
        markUnlinkStarted?.();
        await gate;
      }
      await originalUnlink(filePath);
    });

    const acquisition = withSessionLock(
      env,
      async () => undefined,
      { timeoutMs: 60 },
      { isProcessAlive: () => false }
    );
    await unlinkStarted;
    const startedAt = Date.now();
    await expect(acquisition).rejects.toThrow("Timed out waiting");
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(fs.promises.access(reclaimPath)).resolves.toBeUndefined();

    releaseUnlink?.();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await fs.promises.access(reclaimPath);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(withSessionLock(env, async () => "recovered", { timeoutMs: 1_000 }, {
      isProcessAlive: () => false
    })).resolves.toBe("recovered");
  });

  it("recovers an empty guard left before reclaimer owner publication", async () => {
    const lockPath = getSessionLockPath(env);
    const reclaimPath = `${lockPath}.reclaim`;
    await fs.promises.writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-lock-owner",
      createdAt: new Date().toISOString()
    }), "utf8");
    await fs.promises.mkdir(reclaimPath);
    const staleTime = new Date(Date.now() - 1_000);
    await fs.promises.utimes(reclaimPath, staleTime, staleTime);

    await expect(withSessionLock(env, async () => "acquired", { timeoutMs: 1_000 })).resolves.toBe("acquired");
    await expect(fs.promises.access(reclaimPath)).rejects.toThrow();
  });

  it("does not steal a reclaim guard from a live owner", async () => {
    const lockPath = getSessionLockPath(env);
    const reclaimPath = `${lockPath}.reclaim`;
    await fs.promises.writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-lock-owner",
      createdAt: new Date().toISOString()
    }), "utf8");
    await fs.promises.mkdir(reclaimPath);
    await fs.promises.writeFile(path.join(reclaimPath, "owner.live-reclaimer"), JSON.stringify({
      pid: process.pid,
      token: "live-reclaimer",
      createdAt: new Date().toISOString()
    }), "utf8");

    await expect(withSessionLock(env, async () => undefined, { timeoutMs: 80 })).rejects.toThrow(
      "Timed out waiting"
    );
    await expect(fs.promises.access(reclaimPath)).resolves.toBeUndefined();
  });

  it("does not replace a legacy directory that appears during a hard-link guard claim", async () => {
    const lockPath = getSessionLockPath(env);
    const reclaimPath = `${lockPath}.reclaim`;
    const markerPath = path.join(reclaimPath, "owner.live-legacy-reclaimer");
    await fs.promises.writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-lock-owner",
      createdAt: new Date().toISOString()
    }), "utf8");

    const originalLink = fs.promises.link.bind(fs.promises);
    let legacyGuardPublished = false;
    vi.spyOn(fs.promises, "link").mockImplementation(async (existingPath, newPath) => {
      if (!legacyGuardPublished && String(newPath) === reclaimPath) {
        legacyGuardPublished = true;
        await fs.promises.mkdir(reclaimPath);
        await fs.promises.writeFile(markerPath, JSON.stringify({
          pid: process.pid,
          token: "live-legacy-reclaimer",
          createdAt: new Date().toISOString()
        }), "utf8");
      }
      await originalLink(existingPath, newPath);
    });

    await expect(withSessionLock(env, async () => undefined, { timeoutMs: 80 })).rejects.toThrow(
      "Timed out waiting"
    );
    await expect(fs.promises.stat(reclaimPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    expect((await fs.promises.stat(reclaimPath)).isDirectory()).toBe(true);
    await expect(fs.promises.readFile(markerPath, "utf8")).resolves.toContain("live-legacy-reclaimer");
  });

  it("bounds a hung canonical-lock file inspection by the shared deadline", async () => {
    const lockPath = getSessionLockPath(env);
    await fs.promises.writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      token: "live-lock-owner",
      createdAt: new Date().toISOString()
    }), "utf8");
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation(((filePath: fs.PathLike, options?: unknown) => {
      if (String(filePath) === lockPath) {
        return new Promise<never>(() => undefined);
      }
      return Reflect.apply(originalReadFile, fs.promises, [filePath, options]);
    }) as typeof fs.promises.readFile);

    const startedAt = Date.now();
    await expect(withSessionLock(env, async () => undefined, { timeoutMs: 35 })).rejects.toThrow(
      "Timed out waiting"
    );
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("bounds hung lock-owner generation inspection by the shared deadline", async () => {
    await fs.promises.writeFile(getSessionLockPath(env), JSON.stringify({
      pid: process.pid,
      token: "live-lock-owner",
      createdAt: new Date().toISOString(),
      processCreationTime: "owner-generation"
    }), "utf8");

    const startedAt = Date.now();
    await expect(withSessionLock(env, async () => undefined, { timeoutMs: 35 }, {
      isProcessAlive: () => true,
      getProcessCreationTime: async () => new Promise<string | undefined>(() => undefined)
    })).rejects.toThrow("Timed out waiting");
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("never persists a synthetic node-start process generation in the lock", async () => {
    await withSessionLock(env, async () => {
      const record = JSON.parse(await fs.promises.readFile(getSessionLockPath(env), "utf8")) as {
        processCreationTime?: string;
      };
      expect(record.processCreationTime || "").not.toMatch(/^node-start:/);
    });
  });

  it("does not delete a replacement lock owned by a different token", async () => {
    const lockPath = getSessionLockPath(env);
    await withSessionLock(env, async () => {
      await fs.promises.unlink(lockPath);
      await fs.promises.writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        token: "replacement-owner",
        createdAt: new Date().toISOString()
      }), "utf8");
    });

    await expect(fs.promises.readFile(lockPath, "utf8")).resolves.toContain("replacement-owner");
    await fs.promises.unlink(lockPath);
  });

  it("uses the default lock timeout only while acquiring the lock", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await expect(withSessionLock(env, async () => {
        now += 35_001;
        return "completed";
      })).resolves.toBe("completed");
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves POSIX case while comparing Windows paths case-insensitively", () => {
    expect(normalizePathForCompare("/tmp/Ask/Profile")).not.toBe(normalizePathForCompare("/tmp/ask/profile"));
    expect(normalizePathForCompare("C:\\Users\\Me\\Ask")).toBe(normalizePathForCompare("c:\\users\\me\\ask"));
  });

  it("matches injected Windows process arguments case-insensitively without weakening POSIX paths", () => {
    expect(processMatchesAskSession(
      {
        pid: 1,
        args: [
          "chrome.exe",
          "--remote-debugging-port=51437",
          "--user-data-dir=c:/users/me/.ask/CHROME-PROFILE"
        ]
      },
      51437,
      "C:\\Users\\Me\\.ask\\chrome-profile"
    )).toBe(true);

    expect(processMatchesAskSession(
      {
        pid: 1,
        args: [
          "google-chrome",
          "--remote-debugging-port=51437",
          "--user-data-dir=/tmp/ask/profile"
        ]
      },
      51437,
      "/tmp/Ask/Profile"
    )).toBe(false);
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
    const replacement = {
      pid: 5678,
      commandLine: `chrome --remote-debugging-port=0 --user-data-dir=${path.join(tempDir, "chrome-profile")}`
    };
    await expect(classifySession(env, 9222, true, {
      getPortOwnerProcessInfo: async () => replacement
    })).resolves.toMatchObject({
      ownership: "unknown",
      process: { pid: 5678 },
      reason: expect.stringContaining("uses the ask profile")
    });

  });

  it("does not adopt a different listener process even when its Chrome flags match", async () => {
    const port = 9444;
    const profileDir = path.join(tempDir, "chrome-profile");
    const generation = "replacement-generation";
    await writeProfileMarker(env);
    await writeSessionState(env, {
      pid: 1234,
      port,
      chromePath: "C:\\Chrome\\chrome.exe",
      headless: false,
      processCreationTime: "stale-process-generation",
      generation,
      portPolicy: "pinned",
      requestedPort: port
    });
    const replacement = {
      pid: 5678,
      commandLine:
        `chrome --remote-debugging-port=${port} --user-data-dir="${profileDir}" ` +
        `--ask-session-generation=${generation}`,
      creationTime: "replacement-process-generation"
    };

    await expect(classifySession(env, port, true, {
      getPortOwnerProcessInfo: async () => replacement
    })).resolves.toMatchObject({
      ownership: "unknown",
      process: { pid: 5678 },
      reason: expect.stringContaining("different process")
    });
  });

  it("accepts legacy Linux ps creation time when current inspection uses start ticks", async () => {
    const port = 9555;
    const profileDir = path.join(tempDir, "chrome-profile");
    const legacyCreationTime = "Thu Aug  6 12:00:00 2026";
    await writeProfileMarker(env);
    await writeSessionState(env, {
      pid: 1234,
      port,
      chromePath: "/usr/bin/google-chrome",
      headless: false,
      processCreationTime: legacyCreationTime,
      portPolicy: "pinned",
      requestedPort: port
    });

    await expect(classifySession(env, port, true, {
      getPortOwnerProcessInfo: async () => ({
        pid: 1234,
        commandLine: `google-chrome --remote-debugging-port=${port} --user-data-dir=${profileDir}`,
        creationTime: "linux-start-ticks:123456"
      }),
      getLegacyProcessCreationTime: async () => legacyCreationTime
    })).resolves.toMatchObject({ ownership: "ask-managed" });
  });

  it("bounds raw session process-owner inspection by an absolute deadline", async () => {
    const startedAt = Date.now();
    await expect(classifySession(env, 9666, true, {
      deadlineAt: startedAt + 35,
      getPortOwnerProcessInfo: async () => new Promise<never>(() => undefined)
    })).rejects.toThrow("Timed out while verifying ownership");
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(500);
  });
});
