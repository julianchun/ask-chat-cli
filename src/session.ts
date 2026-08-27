import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { promisify } from "node:util";
import { getAskHome, getChromeProfileDir, joinConfiguredPath } from "./config";

const execFileAsync = promisify(execFile);
const WINDOWS_PROCESS_INFO_TIMEOUT_MS = 1_500;

export const SESSION_STATE_VERSION = 1;

export type SessionOwnership = "absent" | "ask-managed" | "external" | "unknown";
export type PersistedChromePortPolicy = "automatic" | "pinned";

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
  /** Optional so session-state v1 files written by older ask releases remain readable. */
  generation?: string;
  /** The policy and launch argument are additive v1 fields. */
  portPolicy?: PersistedChromePortPolicy;
  requestedPort?: number;
}

export interface ProcessInfo {
  pid: number;
  name?: string;
  commandLine?: string;
  args?: string[];
  creationTime?: string;
  executablePath?: string;
}

export interface SessionClassification {
  ownership: SessionOwnership;
  state?: SessionState;
  process?: ProcessInfo;
  reason?: string;
}

export interface SessionClassificationDependencies {
  getPortOwnerProcessInfo?: (port: number) => Promise<ProcessInfo | undefined>;
  /** Test/compatibility seam for v1 Linux state that stored `ps lstart`. */
  getLegacyProcessCreationTime?: (pid: number) => Promise<string | undefined>;
  /** Absolute lifecycle deadline for process-owner inspection. */
  deadlineAt?: number;
}

export interface DeadlineOptions {
  /** Relative budget measured from the API entry point. */
  timeoutMs?: number;
  /** Absolute wall-clock deadline used to share one budget across nested steps. */
  deadlineAt?: number;
}

export interface SessionLockDependencies {
  /** Test seam for bounded OS process-generation inspection. */
  getProcessCreationTime?: (pid: number) => Promise<string | undefined>;
  isProcessAlive?: (pid: number) => boolean;
}

export class DeadlineExceededError extends Error {
  readonly code = "DEADLINE_EXCEEDED";

  constructor(message: string) {
    super(message);
    this.name = "DeadlineExceededError";
  }
}

export function resolveDeadlineAt(
  options: DeadlineOptions = {},
  defaultTimeoutMs?: number
): number | undefined {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
    throw new Error("timeoutMs must be a finite non-negative number.");
  }
  if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) {
    throw new Error("deadlineAt must be a finite timestamp.");
  }
  if (defaultTimeoutMs !== undefined && (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs < 0)) {
    throw new Error("The default timeout must be a finite non-negative number.");
  }

  const candidates: number[] = [];
  if (options.deadlineAt !== undefined) {
    candidates.push(options.deadlineAt);
  }
  if (options.timeoutMs !== undefined) {
    candidates.push(Date.now() + options.timeoutMs);
  }
  if (candidates.length === 0 && defaultTimeoutMs !== undefined) {
    candidates.push(Date.now() + defaultTimeoutMs);
  }
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

export function remainingDeadlineMs(deadlineAt?: number): number | undefined {
  return deadlineAt === undefined ? undefined : Math.max(0, Math.ceil(deadlineAt - Date.now()));
}

export function throwIfDeadlineExceeded(deadlineAt: number | undefined, message: string): void {
  if (deadlineAt !== undefined && remainingDeadlineMs(deadlineAt) === 0) {
    throw new DeadlineExceededError(message);
  }
}

export async function raceWithDeadline<T>(
  operation: PromiseLike<T>,
  deadlineAt: number | undefined,
  message: string,
  onLateResolve?: (value: T) => void | Promise<void>
): Promise<T> {
  if (deadlineAt === undefined) {
    return operation;
  }

  const remainingMs = remainingDeadlineMs(deadlineAt)!;
  if (remainingMs === 0) {
    void Promise.resolve(operation).then(
      (value) => Promise.resolve(onLateResolve?.(value)).catch(() => undefined),
      () => undefined
    );
    throw new DeadlineExceededError(message);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new DeadlineExceededError(message));
    }, remainingMs);

    void Promise.resolve(operation).then(
      (value) => {
        if (settled) {
          void Promise.resolve(onLateResolve?.(value)).catch(() => undefined);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function delayWithinDeadline(
  timeoutMs: number,
  deadlineAt: number | undefined,
  message: string
): Promise<void> {
  await raceWithDeadline(delay(timeoutMs), deadlineAt, message);
}

interface SessionLockRecord {
  pid: number;
  token: string;
  createdAt: string;
  processCreationTime?: string;
}

export function getSessionStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return joinConfiguredPath(getAskHome(env), "session.json");
}

export function getProfileMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return joinConfiguredPath(getChromeProfileDir(env), ".ask-profile.json");
}

export function getSessionLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return joinConfiguredPath(getAskHome(env), "chrome-manager.lock");
}

const SESSION_LOCK_WAIT_MS = 35_000;
const SESSION_LOCK_MALFORMED_GRACE_MS = 250;
const SESSION_LOCK_TIMEOUT_MESSAGE = "Timed out waiting for another ask Chrome session operation to finish.";
interface SessionLockContext {
  token: string;
  targetIdentity: string;
  phase: "active" | "closing" | "sealed";
  deferredCriticalWork: Set<Promise<void>>;
}

const sessionLockContext = new AsyncLocalStorage<SessionLockContext>();
let currentProcessCreationTimeLookup: Promise<string | undefined> | undefined;

/**
 * Keep the currently held lifecycle lock published until an already-started,
 * non-cancellable canonical filesystem mutation has settled. Callers still
 * receive their deadline error promptly, but a newer lifecycle owner cannot
 * enter while the late mutation could affect its files.
 */
function getSessionLockTargetIdentity(env: NodeJS.ProcessEnv): string {
  return normalizePathForCompare(getSessionLockPath(env));
}

function getActiveSessionLockForTarget(env: NodeJS.ProcessEnv): SessionLockContext | undefined {
  const context = sessionLockContext.getStore();
  if (!context || context.phase !== "active") {
    return undefined;
  }
  const targetIdentity = getSessionLockTargetIdentity(env);
  if (context.targetIdentity !== targetIdentity) {
    throw new Error(
      "A nested Chrome lifecycle mutation cannot target a different ASK_HOME while another lifecycle lock is active."
    );
  }
  return context;
}

export function retainSessionLockUntil(
  operation: PromiseLike<unknown>,
  env: NodeJS.ProcessEnv
): boolean {
  const context = sessionLockContext.getStore();
  if (!context || context.phase === "sealed") {
    return false;
  }
  if (context.targetIdentity !== getSessionLockTargetIdentity(env)) {
    throw new Error(
      "Late Chrome lifecycle work cannot be retained by a lock for a different ASK_HOME."
    );
  }
  return retainSessionLockContextUntil(context, operation);
}

function retainSessionLockContextUntil(
  context: SessionLockContext,
  operation: PromiseLike<unknown>
): boolean {
  if (context.phase === "sealed") {
    return false;
  }
  let tracked: Promise<void>;
  tracked = Promise.resolve(operation)
    .then(() => undefined, () => undefined)
    .finally(() => context.deferredCriticalWork.delete(tracked));
  context.deferredCriticalWork.add(tracked);
  return true;
}

async function waitForDeferredSessionLockWork(context: SessionLockContext): Promise<void> {
  context.phase = "closing";
  for (;;) {
    const snapshot = [...context.deferredCriticalWork];
    if (snapshot.length === 0) {
      // This check and transition are synchronous. Registration either lands
      // in the snapshot before this point or observes sealed and is rejected.
      context.phase = "sealed";
      return;
    }
    await Promise.allSettled(snapshot);
  }
}

/**
 * Serialize every Chrome lifecycle mutation. Separate callers in one process
 * queue normally, while a nested acquisition fails immediately instead of
 * self-deadlocking.
 */
export async function withSessionLock<T>(
  env: NodeJS.ProcessEnv,
  fn: () => Promise<T>,
  options: DeadlineOptions = {},
  dependencies: SessionLockDependencies = {}
): Promise<T> {
  const targetIdentity = getSessionLockTargetIdentity(env);
  const inheritedContext = sessionLockContext.getStore();
  if (inheritedContext?.phase === "active") {
    if (inheritedContext.targetIdentity !== targetIdentity) {
      throw new Error(
        "The ask Chrome lifecycle lock cannot acquire a different ASK_HOME from a nested operation."
      );
    }
    throw new Error("The ask Chrome lifecycle lock is not reentrant.");
  }

  const operationDeadlineAt = resolveDeadlineAt(options);
  const acquisitionDeadlineAt = operationDeadlineAt ?? Date.now() + SESSION_LOCK_WAIT_MS;
  await raceWithDeadline(
    fs.promises.mkdir(getAskHome(env), { recursive: true }),
    acquisitionDeadlineAt,
    "Timed out creating the ask session directory."
  );
  const lockPath = getSessionLockPath(env);
  const token = randomUUID();
  const processCreationTime = await raceWithDeadline(
    getCurrentProcessCreationTime(),
    acquisitionDeadlineAt,
    "Timed out while preparing the ask Chrome lifecycle lock."
  );
  const record: SessionLockRecord = {
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
    processCreationTime
  };
  const ownedText = `${JSON.stringify(record)}\n`;
  const ownerPath = `${lockPath}.owner.${process.pid}.${token}`;
  const reclaimPath = `${lockPath}.reclaim`;
  const context: SessionLockContext = {
    token,
    targetIdentity,
    phase: "closing",
    deferredCriticalWork: new Set()
  };
  let ownerHandle: fs.promises.FileHandle | undefined;
  let acquired = false;
  let deferredOwnerUnlink = false;
  let bodyFailed = false;

  try {
    const openOperation = fs.promises.open(ownerPath, "wx", 0o600);
    ownerHandle = await raceWithDeadline(
      openOperation,
      acquisitionDeadlineAt,
      "Timed out opening the ask Chrome lifecycle owner record.",
      async (lateHandle) => {
        await lateHandle.close().catch(() => undefined);
        await fs.promises.unlink(ownerPath).catch(() => undefined);
      }
    );
    const writeOperation = ownerHandle.writeFile(ownedText, "utf8");
    try {
      await raceWithDeadline(
        writeOperation,
        acquisitionDeadlineAt,
        "Timed out writing the ask Chrome lifecycle owner record."
      );
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        deferredOwnerUnlink = true;
        attachLatePreparedFileCleanup(writeOperation, ownerHandle, [ownerPath]);
        ownerHandle = undefined;
      }
      throw error;
    }
    const syncOperation = ownerHandle.sync();
    try {
      await raceWithDeadline(
        syncOperation,
        acquisitionDeadlineAt,
        "Timed out syncing the ask Chrome lifecycle owner record."
      );
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        deferredOwnerUnlink = true;
        attachLatePreparedFileCleanup(syncOperation, ownerHandle, [ownerPath]);
        ownerHandle = undefined;
      }
      throw error;
    }

    while (!acquired) {
      throwIfDeadlineExceeded(acquisitionDeadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
      const publication = fs.promises.link(ownerPath, lockPath);
      try {
        // The complete owner record is published atomically. A crashed writer
        // can no longer leave a partially written canonical lock.
        await raceWithDeadline(publication, acquisitionDeadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
        acquired = true;
        break;
      } catch (error) {
        if (error instanceof DeadlineExceededError) {
          deferredOwnerUnlink = true;
          attachLateOwnedLinkCleanup(publication, lockPath, ownerPath, token);
          throw error;
        }
        if (!isFileExistsError(error)) {
          throw error;
        }
      }

      const observed = await inspectLock(lockPath, acquisitionDeadlineAt);
      if (!observed) {
        continue;
      }

      const ownerAlive = await isLockOwnerAlive(observed, acquisitionDeadlineAt, dependencies);
      const malformedPastGrace = observed.pid === undefined &&
        Date.now() - observed.mtimeMs >= SESSION_LOCK_MALFORMED_GRACE_MS;
      if ((observed.pid !== undefined && !ownerAlive) || malformedPastGrace) {
        if (await reclaimStaleLock(lockPath, reclaimPath, record, acquisitionDeadlineAt, dependencies)) {
          continue;
        }
      }

      await delayWithinDeadline(
        50,
        acquisitionDeadlineAt,
        SESSION_LOCK_TIMEOUT_MESSAGE
      );
    }

    context.phase = "active";
    try {
      try {
        return await sessionLockContext.run(context, fn);
      } catch (error) {
        bodyFailed = true;
        throw error;
      }
    } finally {
      // Closing is a synchronous registration barrier: every critical tail
      // registered while active is already in the set, and detached ALS
      // descendants can no longer append work after draining begins.
      context.phase = "closing";
    }
  } finally {
    try {
      await finishOwnedLinkCleanup(
        lockPath,
        ownerPath,
        token,
        ownerHandle,
        acquired,
        deferredOwnerUnlink,
        operationDeadlineAt,
        context
      );
    } catch (error) {
      // A body deadline is the actionable failure. Cleanup may keep the lease
      // published in the background until its non-cancellable work settles.
      if (!bodyFailed) {
        throw error;
      }
    }
  }
}

function attachLateOwnedLinkCleanup(
  publication: Promise<void>,
  canonicalPath: string,
  ownerPath: string,
  token: string
): void {
  void publication.then(async () => {
    let ownerMayBeRemoved = false;
    try {
      ownerMayBeRemoved = (await releaseOwnedLock(canonicalPath, ownerPath, token)).ownerMayBeRemoved;
    } catch {
      // Preserve the sidecar. A future stale-owner recovery needs its exact
      // inode/token if canonical release could not be verified.
    }
    if (ownerMayBeRemoved) {
      await fs.promises.unlink(ownerPath).catch(() => undefined);
    }
  }, async () => {
    // link() failed, so this sidecar was never published as canonical.
    await fs.promises.unlink(ownerPath).catch(() => undefined);
  });
}

async function finishOwnedLinkCleanup(
  canonicalPath: string,
  ownerPath: string,
  token: string,
  handle: fs.promises.FileHandle | undefined,
  acquired: boolean,
  ownerUnlinkDeferred: boolean,
  deadlineAt: number | undefined,
  context?: SessionLockContext
): Promise<void> {
  const cleanup = (async () => {
    try {
      if (context) {
        await waitForDeferredSessionLockWork(context);
      }
      let ownerMayBeRemoved = !acquired;
      if (acquired) {
        try {
          ownerMayBeRemoved = (await releaseOwnedLock(canonicalPath, ownerPath, token)).ownerMayBeRemoved;
        } catch {
          // Keep the owner sidecar recoverable when canonical release failed.
          ownerMayBeRemoved = false;
        }
      }
      await handle?.close().catch(() => undefined);
      if (!ownerUnlinkDeferred && ownerMayBeRemoved) {
        await fs.promises.unlink(ownerPath).catch(() => undefined);
      }
    } finally {
      if (context) {
        context.phase = "sealed";
      }
    }
  })();
  if (remainingDeadlineMs(deadlineAt) === 0) {
    void cleanup.catch(() => undefined);
    throw new DeadlineExceededError(SESSION_LOCK_TIMEOUT_MESSAGE);
  }
  try {
    await raceWithDeadline(cleanup, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
  } catch (error) {
    void cleanup.catch(() => undefined);
    throw error;
  }
}

async function reclaimStaleLock(
  lockPath: string,
  reclaimPath: string,
  owner: SessionLockRecord,
  deadlineAt: number,
  dependencies: SessionLockDependencies
): Promise<boolean> {
  const guardOwnerPath = `${reclaimPath}.owner.${process.pid}.${owner.token}`;
  let guardHandle: fs.promises.FileHandle | undefined;
  let acquired = false;
  let deferredOwnerUnlink = false;
  let guardCleanupDeferred = false;
  try {
    const openOperation = fs.promises.open(guardOwnerPath, "wx", 0o600);
    guardHandle = await raceWithDeadline(
      openOperation,
      deadlineAt,
      SESSION_LOCK_TIMEOUT_MESSAGE,
      async (lateHandle) => {
        await lateHandle.close().catch(() => undefined);
        await fs.promises.unlink(guardOwnerPath).catch(() => undefined);
      }
    );
    const writeOperation = guardHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    try {
      await raceWithDeadline(writeOperation, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        deferredOwnerUnlink = true;
        attachLatePreparedFileCleanup(writeOperation, guardHandle, [guardOwnerPath]);
        guardHandle = undefined;
      }
      throw error;
    }
    const syncOperation = guardHandle.sync();
    try {
      await raceWithDeadline(syncOperation, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        deferredOwnerUnlink = true;
        attachLatePreparedFileCleanup(syncOperation, guardHandle, [guardOwnerPath]);
        guardHandle = undefined;
      }
      throw error;
    }
    const publication = fs.promises.link(guardOwnerPath, reclaimPath);
    try {
      // link() is an atomic no-replace publication. It cannot overwrite either
      // a new file guard or an older ask release's directory guard.
      await raceWithDeadline(publication, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
      acquired = true;
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        deferredOwnerUnlink = true;
        attachLateOwnedLinkCleanup(publication, reclaimPath, guardOwnerPath, owner.token);
        throw error;
      }
      if (isFileExistsError(error) || await pathExistsWithinDeadline(reclaimPath, deadlineAt)) {
        await reclaimAbandonedReclaimGuard(reclaimPath, deadlineAt, dependencies);
        return false;
      }
      throw error;
    }

    throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    const observed = await inspectLock(lockPath, deadlineAt);
    if (!observed) {
      return true;
    }
    const ownerAlive = await isLockOwnerAlive(observed, deadlineAt, dependencies);
    const malformedPastGrace = observed.pid === undefined &&
      Date.now() - observed.mtimeMs >= SESSION_LOCK_MALFORMED_GRACE_MS;
    if ((observed.pid !== undefined && !ownerAlive) || malformedPastGrace) {
      // Only one reclaimer can mutate the canonical path, and it re-reads the
      // owner while holding the reclaim guard. It performs exactly one unlink,
      // so a replacement owner published afterward cannot be removed.
      const staleUnlink = fs.promises.unlink(lockPath).catch((error: unknown) => {
        if (!isMissingFileError(error)) {
          throw error;
        }
      });
      try {
        await raceWithDeadline(staleUnlink, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
      } catch (error) {
        if (error instanceof DeadlineExceededError) {
          guardCleanupDeferred = true;
          attachLateGuardMutationCleanup(
            staleUnlink,
            reclaimPath,
            guardOwnerPath,
            owner.token,
            guardHandle
          );
          guardHandle = undefined;
        }
        throw error;
      }
      return true;
    }
    return false;
  } finally {
    if (!guardCleanupDeferred) {
      await finishOwnedLinkCleanup(
        reclaimPath,
        guardOwnerPath,
        owner.token,
        guardHandle,
        acquired,
        deferredOwnerUnlink,
        deadlineAt
      );
    }
  }
}

function attachLateGuardMutationCleanup(
  mutation: PromiseLike<unknown>,
  canonicalPath: string,
  ownerPath: string,
  token: string,
  handle: fs.promises.FileHandle | undefined
): void {
  void Promise.resolve(mutation)
    .catch(() => undefined)
    .then(async () => {
      let ownerMayBeRemoved = false;
      try {
        ownerMayBeRemoved = (await releaseOwnedLock(canonicalPath, ownerPath, token)).ownerMayBeRemoved;
      } catch {
        // Preserve the sidecar if guard release is not verifiable.
      }
      await handle?.close().catch(() => undefined);
      if (ownerMayBeRemoved) {
        await fs.promises.unlink(ownerPath).catch(() => undefined);
      }
    });
}

async function pathExistsWithinDeadline(filePath: string, deadlineAt: number): Promise<boolean> {
  throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
  try {
    await raceWithDeadline(fs.promises.stat(filePath), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function reclaimAbandonedReclaimGuard(
  reclaimPath: string,
  deadlineAt: number,
  dependencies: SessionLockDependencies
): Promise<boolean> {
  let guardStat: fs.Stats;
  try {
    throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    guardStat = await raceWithDeadline(
      fs.promises.lstat(reclaimPath),
      deadlineAt,
      SESSION_LOCK_TIMEOUT_MESSAGE
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return true;
    }
    throw error;
  }

  if (guardStat.isDirectory()) {
    return reclaimLegacyReclaimGuardDirectory(reclaimPath, deadlineAt, dependencies, guardStat);
  }
  if (!guardStat.isFile()) {
    return false;
  }

  const observed = await inspectLock(reclaimPath, deadlineAt);
  if (!observed || observed.pid === undefined || !observed.token) {
    return false;
  }
  if (await isLockOwnerAlive(observed, deadlineAt, dependencies)) {
    return false;
  }
  return reclaimAbandonedFileGuard(reclaimPath, observed, deadlineAt, dependencies);
}

async function reclaimAbandonedFileGuard(
  reclaimPath: string,
  observed: ObservedSessionLock,
  deadlineAt: number,
  dependencies: SessionLockDependencies
): Promise<boolean> {
  const ownerPath = `${reclaimPath}.owner.${observed.pid}.${observed.token}`;
  const ownerName = path.basename(ownerPath);
  const reaperPrefix = `${ownerName}.reaping.`;
  throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
  const names = await raceWithDeadline(
    fs.promises.readdir(path.dirname(reclaimPath)),
    deadlineAt,
    SESSION_LOCK_TIMEOUT_MESSAGE
  );
  const candidates = names
    .filter((name) => name === ownerName || name.startsWith(reaperPrefix))
    .map((name) => path.join(path.dirname(reclaimPath), name));
  const matchingCandidates: Array<{
    filePath: string;
    reaperPid?: number;
    reaperProcessCreationTime?: string;
  }> = [];
  for (const candidatePath of candidates) {
    try {
      const candidateStat = await raceWithDeadline(
        fs.promises.stat(candidatePath),
        deadlineAt,
        SESSION_LOCK_TIMEOUT_MESSAGE
      );
      if (candidateStat.dev !== observed.dev || candidateStat.ino !== observed.ino) {
        continue;
      }
      const candidateName = path.basename(candidatePath);
      const reaperOwner = candidateName.startsWith(reaperPrefix)
        ? parseReaperClaimOwner(candidateName.slice(reaperPrefix.length))
        : undefined;
      matchingCandidates.push({
        filePath: candidatePath,
        reaperPid: reaperOwner?.pid,
        reaperProcessCreationTime: reaperOwner?.processCreationTime
      });
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  for (const candidate of matchingCandidates) {
    if (candidate.reaperPid === undefined) {
      continue;
    }
    if (await isReaperClaimOwnerAlive(candidate, deadlineAt, dependencies)) {
      return false;
    }
  }
  const sourcePath = matchingCandidates[0]?.filePath;
  if (!sourcePath) {
    // A canonical file is only published by hard-linking this token-derived
    // sidecar. A missing sidecar is treated conservatively rather than risking
    // deletion of a replacement guard.
    return false;
  }

  const reaperProcessCreationTime = await raceWithDeadline(
    getCurrentProcessCreationTime(),
    deadlineAt,
    SESSION_LOCK_TIMEOUT_MESSAGE
  );
  const encodedCreationTime = reaperProcessCreationTime
    ? Buffer.from(reaperProcessCreationTime, "utf8").toString("base64url")
    : "_";
  const reaperClaimPath =
    `${ownerPath}.reaping.${process.pid}.${encodedCreationTime}.${randomUUID()}`;
  const publication = fs.promises.rename(sourcePath, reaperClaimPath);
  try {
    await raceWithDeadline(
      publication,
      deadlineAt,
      SESSION_LOCK_TIMEOUT_MESSAGE
    );
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      attachLateReaperClaimCleanup(publication, reclaimPath, reaperClaimPath, observed.token!);
      throw error;
    }
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }

  // Moving the old sidecar is the atomic election. The winner verifies that
  // canonical still names that exact inode/token, unlinks it once, and never
  // touches canonical again, so a subsequent owner cannot be removed.
  const releaseOperation = releaseOwnedLock(reclaimPath, reaperClaimPath, observed.token!);
  let release: OwnedLockReleaseResult;
  try {
    release = await raceWithDeadline(
      releaseOperation,
      deadlineAt,
      SESSION_LOCK_TIMEOUT_MESSAGE
    );
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      attachLateOwnedReleaseCleanup(releaseOperation, reaperClaimPath);
    }
    throw error;
  }
  if (release.ownerMayBeRemoved) {
    const sidecarCleanup = fs.promises.unlink(reaperClaimPath).catch((error: unknown) => {
      if (!isMissingFileError(error)) {
        throw error;
      }
    });
    try {
      await raceWithDeadline(sidecarCleanup, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        // This token-derived path can never name a successor's claim. Let the
        // exact unlink finish in the background without extending the caller's
        // deadline; until then it remains harmless recovery evidence.
        void sidecarCleanup.catch(() => undefined);
      }
      throw error;
    }
  }
  return release.released;
}

function parseReaperClaimOwner(
  suffix: string
): { pid: number; processCreationTime?: string } | undefined {
  const fields = suffix.split(".");
  const pid = Number(fields[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  // Older file-guard implementations wrote only <pid>.<uuid>. They remain
  // conservatively live when that PID exists because no generation evidence
  // is available. New claims include base64url(processCreationTime).
  if (fields.length < 3) {
    return { pid };
  }
  if (fields[1] === "_") {
    return { pid };
  }
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(fields[1])) {
      return { pid };
    }
    const decoded = Buffer.from(fields[1], "base64url");
    if (decoded.toString("base64url") !== fields[1]) {
      return { pid };
    }
    const processCreationTime = decoded.toString("utf8");
    return processCreationTime ? { pid, processCreationTime } : { pid };
  } catch {
    return { pid };
  }
}

async function isReaperClaimOwnerAlive(
  candidate: { reaperPid?: number; reaperProcessCreationTime?: string },
  deadlineAt: number,
  dependencies: SessionLockDependencies
): Promise<boolean> {
  const pid = candidate.reaperPid;
  if (pid === undefined || !(dependencies.isProcessAlive || isProcessAlive)(pid)) {
    return false;
  }
  if (!candidate.reaperProcessCreationTime) {
    return true;
  }
  const creationTime = dependencies.getProcessCreationTime
    ? dependencies.getProcessCreationTime(pid)
    : pid === process.pid
      ? getCurrentProcessCreationTime()
      : getProcessCreationTime(pid);
  const actualCreationTime = await raceWithDeadline(
    creationTime,
    deadlineAt,
    SESSION_LOCK_TIMEOUT_MESSAGE
  );
  return actualCreationTime === undefined || actualCreationTime === candidate.reaperProcessCreationTime;
}

function attachLateReaperClaimCleanup(
  publication: Promise<void>,
  reclaimPath: string,
  reaperClaimPath: string,
  token: string
): void {
  void publication.then(async () => {
    attachLateOwnedReleaseCleanup(
      releaseOwnedLock(reclaimPath, reaperClaimPath, token),
      reaperClaimPath
    );
  }, () => undefined);
}

function attachLateOwnedReleaseCleanup(
  release: Promise<OwnedLockReleaseResult>,
  ownerPath: string
): void {
  void release.then(async (result) => {
    if (result.ownerMayBeRemoved) {
      await fs.promises.unlink(ownerPath).catch(() => undefined);
    }
  }, () => {
    // Preserve the owner/reaper sidecar when release was not verifiable.
  });
}

async function reclaimLegacyReclaimGuardDirectory(
  reclaimPath: string,
  deadlineAt: number,
  dependencies: SessionLockDependencies,
  initialStat: fs.Stats
): Promise<boolean> {
  let directoryStat: fs.Stats;
  let markerNames: string[];
  try {
    throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    [directoryStat, markerNames] = await raceWithDeadline(
      Promise.all([Promise.resolve(initialStat), fs.promises.readdir(reclaimPath)]),
      deadlineAt,
      SESSION_LOCK_TIMEOUT_MESSAGE
    );
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      throw error;
    }
    return isMissingFileError(error);
  }

  // A legacy owner may be between mkdir and marker publication, or Windows
  // may expose the directory before its marker is immediately readable. Never
  // reclaim a newly created directory guard regardless of partial evidence.
  if (Date.now() - directoryStat.mtimeMs < SESSION_LOCK_MALFORMED_GRACE_MS) {
    return false;
  }

  if (markerNames.length === 0) {
    try {
      await raceWithDeadline(
        fs.promises.rmdir(reclaimPath),
        deadlineAt,
        SESSION_LOCK_TIMEOUT_MESSAGE
      );
      return true;
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        throw error;
      }
      // A replacement guard publishes a marker before entering its critical
      // section, making rmdir fail safely if it won the race.
      return false;
    }
  }

  const observedMarkers = await raceWithDeadline(Promise.all(markerNames.map(async (markerName) => {
    const markerPath = path.join(reclaimPath, markerName);
    try {
      const [text, stat] = await Promise.all([
        fs.promises.readFile(markerPath, "utf8"),
        fs.promises.stat(markerPath)
      ]);
      return {
        markerPath,
        observed: { text, ...parseLockOwner(text), mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino }
      };
    } catch {
      return { markerPath, observed: undefined };
    }
  })), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);

  for (const marker of observedMarkers) {
    if (!marker.observed) {
      if (Date.now() - directoryStat.mtimeMs < SESSION_LOCK_MALFORMED_GRACE_MS) {
        return false;
      }
      continue;
    }
    if (
      marker.observed.pid !== undefined &&
      await isLockOwnerAlive(marker.observed, deadlineAt, dependencies)
    ) {
      return false;
    }
    if (
      marker.observed.pid === undefined &&
      Date.now() - marker.observed.mtimeMs < SESSION_LOCK_MALFORMED_GRACE_MS
    ) {
      return false;
    }
  }

  // Marker filenames contain their owners' random tokens. Removing only those
  // exact paths cannot delete a marker from a replacement guard generation.
  await raceWithDeadline(
    Promise.all(observedMarkers.map(async (marker) => {
      await fs.promises.unlink(marker.markerPath).catch(() => undefined);
    })),
    deadlineAt,
    SESSION_LOCK_TIMEOUT_MESSAGE
  );
  try {
    await raceWithDeadline(
      fs.promises.rmdir(reclaimPath),
      deadlineAt,
      SESSION_LOCK_TIMEOUT_MESSAGE
    );
    return true;
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      throw error;
    }
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

interface ObservedSessionLock {
  text: string;
  pid?: number;
  token?: string;
  processCreationTime?: string;
  mtimeMs: number;
  dev: number;
  ino: number;
}

async function inspectLock(lockPath: string, deadlineAt?: number): Promise<ObservedSessionLock | undefined> {
  try {
    throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    const [text, stat] = await raceWithDeadline(Promise.all([
      fs.promises.readFile(lockPath, "utf8"),
      fs.promises.stat(lockPath)
    ]), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    return { text, ...parseLockOwner(text), mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function parseLockOwner(text: string): Pick<ObservedSessionLock, "pid" | "token" | "processCreationTime"> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "pid" in parsed) {
      const record = parsed as { pid?: unknown; token?: unknown; processCreationTime?: unknown };
      const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0
        ? record.pid
        : undefined;
      return {
        pid,
        token: typeof record.token === "string" && record.token ? record.token : undefined,
        processCreationTime: typeof record.processCreationTime === "string"
          ? record.processCreationTime
          : undefined
      };
    }
  } catch {
    // Read the pre-token lock format so a live older ask process is respected.
    const legacyPid = Number(text.split(/\r?\n/, 1)[0]);
    return { pid: Number.isInteger(legacyPid) && legacyPid > 0 ? legacyPid : undefined };
  }
  return {};
}

async function isLockOwnerAlive(
  observed: ObservedSessionLock,
  deadlineAt?: number,
  dependencies: SessionLockDependencies = {}
): Promise<boolean> {
  throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
  if (observed.pid === undefined || !(dependencies.isProcessAlive || isProcessAlive)(observed.pid)) {
    return false;
  }
  if (!observed.processCreationTime) {
    return true;
  }
  const creationTime = dependencies.getProcessCreationTime
    ? dependencies.getProcessCreationTime(observed.pid)
    : observed.pid === process.pid
      ? getCurrentProcessCreationTime()
      : getProcessCreationTime(observed.pid);
  const actualCreationTime = await raceWithDeadline(creationTime, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
  return actualCreationTime === undefined || actualCreationTime === observed.processCreationTime;
}

function getCurrentProcessCreationTime(): Promise<string | undefined> {
  if (process.platform === "win32") {
    // Node does not expose the current Windows process creation timestamp.
    // Starting PowerShell here makes every queue/lock admission contend on WMI
    // when several CLI processes launch together. Omit this optional evidence;
    // token-checked ownership remains exact, and PID-only liveness fails closed
    // until a potentially reused live PID exits.
    return Promise.resolve(undefined);
  }
  currentProcessCreationTimeLookup ??= getProcessCreationTime(process.pid);
  return currentProcessCreationTimeLookup;
}

interface OwnedLockReleaseResult {
  released: boolean;
  ownerMayBeRemoved: boolean;
}

async function releaseOwnedLock(
  lockPath: string,
  ownerPath: string,
  token: string
): Promise<OwnedLockReleaseResult> {
  let lockHandle: fs.promises.FileHandle;
  try {
    lockHandle = await fs.promises.open(lockPath, "r");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { released: false, ownerMayBeRemoved: true };
    }
    throw error;
  }

  try {
    const [text, lockStat] = await Promise.all([
      lockHandle.readFile("utf8"),
      lockHandle.stat()
    ]);
    let ownerStat: fs.Stats;
    try {
      ownerStat = await fs.promises.stat(ownerPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return { released: false, ownerMayBeRemoved: false };
      }
      throw error;
    }
    const samePublishedFile = lockStat.dev === ownerStat.dev && lockStat.ino === ownerStat.ino;
    if (!samePublishedFile) {
      return { released: false, ownerMayBeRemoved: true };
    }

    let parsed: Partial<SessionLockRecord>;
    try {
      parsed = JSON.parse(text) as Partial<SessionLockRecord>;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { released: false, ownerMayBeRemoved: false };
      }
      throw error;
    }
    if (parsed.token !== token) {
      return { released: false, ownerMayBeRemoved: false };
    }
    try {
      await fs.promises.unlink(lockPath);
      return { released: true, ownerMayBeRemoved: true };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { released: false, ownerMayBeRemoved: true };
      }
      throw error;
    }
  } finally {
    await lockHandle.close().catch(() => undefined);
  }
}

export function normalizePathForCompare(value: string): string {
  if (isWindowsStylePath(value)) {
    return path.win32.resolve(value).replace(/\//g, "\\").toLowerCase();
  }
  return path.posix.resolve(value);
}

function isWindowsStylePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.includes("\\");
}

export function writeProfileMarker(
  env: NodeJS.ProcessEnv = process.env,
  options: DeadlineOptions = {}
): Promise<void> {
  const deadlineAt = resolveDeadlineAt(options);
  const context = getActiveSessionLockForTarget(env);
  if (!context) {
    return withSessionLock(env, () => writeProfileMarkerLocked(env, deadlineAt), { deadlineAt });
  }
  const operation = writeProfileMarkerLocked(env, deadlineAt);
  retainSessionLockContextUntil(context, operation);
  return operation;
}

async function writeProfileMarkerLocked(
  env: NodeJS.ProcessEnv,
  deadlineAt: number | undefined
): Promise<void> {
  const markerPath = getProfileMarkerPath(env);
  const marker = {
    manager: "ask",
    version: SESSION_STATE_VERSION,
    profileDir: getChromeProfileDir(env)
  };
  await writeFileAtomically(
    markerPath,
    `${JSON.stringify(marker, null, 2)}\n`,
    deadlineAt,
    "Timed out writing the ask Chrome profile marker."
  );
}

export async function hasProfileMarker(
  env: NodeJS.ProcessEnv = process.env,
  options: DeadlineOptions = {}
): Promise<boolean> {
  const deadlineAt = resolveDeadlineAt(options);
  const timeoutMessage = "Timed out reading the ask Chrome profile marker.";
  try {
    throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
    const text = await raceWithDeadline(
      fs.promises.readFile(getProfileMarkerPath(env), "utf8"),
      deadlineAt,
      timeoutMessage
    );
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return false;
    }
    const marker = parsed as Record<string, unknown>;
    return (
      marker.manager === "ask" &&
      marker.version === SESSION_STATE_VERSION &&
      typeof marker.profileDir === "string" &&
      normalizePathForCompare(marker.profileDir) === normalizePathForCompare(getChromeProfileDir(env))
    );
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      throw error;
    }
    return false;
  }
}

export async function readSessionState(
  env: NodeJS.ProcessEnv = process.env,
  options: DeadlineOptions = {}
): Promise<SessionState | undefined> {
  const deadlineAt = resolveDeadlineAt(options);
  const timeoutMessage = "Timed out reading ask Chrome session state.";
  try {
    throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
    const text = await raceWithDeadline(
      fs.promises.readFile(getSessionStatePath(env), "utf8"),
      deadlineAt,
      timeoutMessage
    );
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    const state = parsed as Partial<SessionState>;
    if (
      state.version !== SESSION_STATE_VERSION ||
      typeof state.pid !== "number" || !Number.isInteger(state.pid) || state.pid <= 0 ||
      typeof state.port !== "number" || !isValidAssignedPort(state.port) ||
      typeof state.profileDir !== "string" ||
      typeof state.chromePath !== "string" ||
      typeof state.headless !== "boolean" ||
      typeof state.launchedAt !== "string" ||
      typeof state.hostname !== "string" ||
      typeof state.username !== "string" ||
      typeof state.nonce !== "string" ||
      (state.generation !== undefined && typeof state.generation !== "string") ||
      (state.portPolicy !== undefined && state.portPolicy !== "automatic" && state.portPolicy !== "pinned") ||
      !hasValidPersistedPortMetadata(state.port, state.portPolicy, state.requestedPort)
    ) {
      return undefined;
    }

    return state as SessionState;
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      throw error;
    }
    return undefined;
  }
}

interface SessionStateWriteInput {
  pid: number;
  port: number;
  chromePath: string;
  headless: boolean;
  processCreationTime?: string;
  generation?: string;
  portPolicy?: PersistedChromePortPolicy;
  requestedPort?: number;
}

export function writeSessionState(
  env: NodeJS.ProcessEnv,
  input: SessionStateWriteInput,
  options: DeadlineOptions = {}
): Promise<SessionState> {
  const deadlineAt = resolveDeadlineAt(options);
  const context = getActiveSessionLockForTarget(env);
  if (!context) {
    return withSessionLock(env, () => writeSessionStateLocked(env, input, deadlineAt), { deadlineAt });
  }
  const operation = writeSessionStateLocked(env, input, deadlineAt);
  retainSessionLockContextUntil(context, operation);
  return operation;
}

async function writeSessionStateLocked(
  env: NodeJS.ProcessEnv,
  input: SessionStateWriteInput,
  deadlineAt: number | undefined
): Promise<SessionState> {
  throwIfDeadlineExceeded(deadlineAt, "Timed out before ask Chrome session state could be persisted.");
  if (!Number.isInteger(input.pid) || input.pid <= 0) {
    throw new Error("Session state PID must be a positive integer.");
  }
  if (!isValidAssignedPort(input.port)) {
    throw new Error("Session state port must be an integer between 1 and 65535.");
  }
  if (!input.chromePath) {
    throw new Error("Session state Chrome path is required.");
  }
  if (!hasValidPersistedPortMetadata(input.port, input.portPolicy, input.requestedPort)) {
    throw new Error("Session state port policy and requested port are inconsistent.");
  }
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
    nonce: randomUUID(),
    generation: input.generation,
    portPolicy: input.portPolicy,
    requestedPort: input.requestedPort
  };

  await writeFileAtomically(
    getSessionStatePath(env),
    `${JSON.stringify(state, null, 2)}\n`,
    deadlineAt,
    "Timed out persisting ask Chrome session state."
  );
  return state;
}

async function writeFileAtomically(
  filePath: string,
  contents: string,
  deadlineAt: number | undefined,
  timeoutMessage: string
): Promise<void> {
  throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
  await raceWithDeadline(
    fs.promises.mkdir(path.dirname(filePath), { recursive: true }),
    deadlineAt,
    timeoutMessage
  );
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const verificationPath = `${tempPath}.owner`;
  let handle: fs.promises.FileHandle | undefined;
  let deferredCleanup = false;
  let cleanupRequired = true;
  try {
    const openOperation = fs.promises.open(tempPath, "wx", 0o600);
    handle = await raceWithDeadline(openOperation, deadlineAt, timeoutMessage, async (lateHandle) => {
      await lateHandle.close().catch(() => undefined);
      await fs.promises.unlink(tempPath).catch(() => undefined);
    });

    const writeOperation = handle.writeFile(contents, "utf8");
    try {
      await raceWithDeadline(writeOperation, deadlineAt, timeoutMessage);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        deferredCleanup = true;
        attachLatePreparedFileCleanup(writeOperation, handle, [tempPath, verificationPath]);
        handle = undefined;
      }
      throw error;
    }

    const syncOperation = handle.sync();
    try {
      await raceWithDeadline(syncOperation, deadlineAt, timeoutMessage);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        deferredCleanup = true;
        attachLatePreparedFileCleanup(syncOperation, handle, [tempPath, verificationPath]);
        handle = undefined;
      }
      throw error;
    }

    const closeOperation = handle.close();
    try {
      await raceWithDeadline(closeOperation, deadlineAt, timeoutMessage);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        deferredCleanup = true;
        attachLatePreparedFileCleanup(closeOperation, undefined, [tempPath, verificationPath]);
      }
      throw error;
    }
    handle = undefined;

    const verificationPublication = fs.promises.link(tempPath, verificationPath);
    try {
      await raceWithDeadline(verificationPublication, deadlineAt, timeoutMessage);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        deferredCleanup = true;
        attachLatePreparedFileCleanup(verificationPublication, undefined, [tempPath, verificationPath]);
      }
      throw error;
    }

    const publication = fs.promises.rename(tempPath, filePath);
    try {
      await raceWithDeadline(publication, deadlineAt, timeoutMessage);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        deferredCleanup = true;
        const lateCleanup = finishLateAtomicWriteCleanup(
          publication,
          filePath,
          tempPath,
          verificationPath
        );
        const context = sessionLockContext.getStore();
        if (!context || !retainSessionLockContextUntil(context, lateCleanup)) {
          // Exported writers normally acquire the lifecycle lock above. Keep
          // this fallback safe for an unexpected internal call context.
          await lateCleanup;
        }
      }
      throw error;
    }
    const verificationCleanup = fs.promises.unlink(verificationPath).catch((error: unknown) => {
      if (!isMissingFileError(error)) {
        throw error;
      }
    });
    try {
      await finishFileCleanupWithinDeadline(verificationCleanup, deadlineAt, timeoutMessage);
      cleanupRequired = false;
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        // Persistence completed within the budget. Verification-sidecar
        // removal is cleanup-only, so let it finish in the background instead
        // of turning a successful atomic publication into a timeout.
        deferredCleanup = true;
        cleanupRequired = false;
        return;
      }
      throw error;
    }
  } finally {
    if (cleanupRequired && !deferredCleanup) {
      const cleanup = (async () => {
        await handle?.close().catch(() => undefined);
        await Promise.all([tempPath, verificationPath].map(async (candidatePath) => {
          await fs.promises.unlink(candidatePath).catch((error: unknown) => {
            if (!isMissingFileError(error)) {
              throw error;
            }
          });
        }));
      })();
      await finishFileCleanupWithinDeadline(cleanup, deadlineAt, timeoutMessage);
    }
  }
}

async function finishFileCleanupWithinDeadline(
  cleanup: PromiseLike<unknown>,
  deadlineAt: number | undefined,
  timeoutMessage: string
): Promise<void> {
  const cleanupPromise = Promise.resolve(cleanup);
  if (deadlineAt === undefined) {
    await cleanupPromise;
    return;
  }
  if (remainingDeadlineMs(deadlineAt) === 0) {
    void cleanupPromise.catch(() => undefined);
    throw new DeadlineExceededError(timeoutMessage);
  }
  try {
    await raceWithDeadline(cleanupPromise, deadlineAt, timeoutMessage);
  } catch (error) {
    void cleanupPromise.catch(() => undefined);
    throw error;
  }
}

function attachLatePreparedFileCleanup(
  operation: PromiseLike<unknown>,
  handle: fs.promises.FileHandle | undefined,
  paths: string[]
): void {
  void Promise.resolve(operation)
    .catch(() => undefined)
    .then(() => handle?.close().catch(() => undefined))
    .then(() => Promise.all(paths.map((candidatePath) => fs.promises.unlink(candidatePath).catch(() => undefined))))
    .catch(() => undefined);
}

async function finishLateAtomicWriteCleanup(
  publication: Promise<void>,
  filePath: string,
  tempPath: string,
  verificationPath: string
): Promise<void> {
  let published = false;
  try {
    await publication;
    published = true;
  } catch {
    // A failed rename cannot have replaced canonical.
  }
  if (published) {
    // The lifecycle lease remains published until this tail settles, so no
    // newer ask generation can replace canonical between publication and this
    // unlink. Avoid a stat-then-unlink TOCTOU on the replaceable state path.
    await fs.promises.unlink(filePath).catch((error: unknown) => {
      if (!isMissingFileError(error)) {
        throw error;
      }
    });
  }
  await Promise.all([tempPath, verificationPath].map(async (candidatePath) => {
    try {
      await fs.promises.unlink(candidatePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }));
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

export async function getProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  // Process-table queries through PowerShell/WMI are comparatively expensive
  // on Windows. We already have complete, trustworthy argv information for
  // this process, so avoid starting a PowerShell child for every queue
  // admission and state refresh.
  if (pid === process.pid) {
    const args = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
    return {
      pid,
      args,
      commandLine: args.map(formatCommandLineArgument).join(" "),
      executablePath: process.execPath,
      name: path.basename(process.execPath),
      creationTime: await getCurrentProcessCreationTime()
    };
  }
  if (!isProcessAlive(pid)) {
    return undefined;
  }
  if (process.platform === "win32") {
    const inspection = await inspectWindowsProcessInfo(pid);
    if (inspection.status === "found") {
      return inspection.info;
    }
    if (inspection.status === "absent") {
      return undefined;
    }
    // A PowerShell/WMI startup failure is not evidence that a live owner is
    // gone. Return a minimal record so queue admission remains fail-closed.
    return isProcessAlive(pid) ? { pid } : undefined;
  }
  if (process.platform === "linux") {
    const linuxInfo = await getLinuxProcessInfo(pid);
    if (linuxInfo) {
      return linuxInfo;
    }
  }

  const [creationTime, commandLine, executablePath] = await Promise.all([
    getPosixProcessField(pid, "lstart="),
    getPosixProcessField(pid, "command="),
    getPosixProcessField(pid, "comm=")
  ]);
  return {
    pid,
    creationTime,
    commandLine,
    executablePath,
    name: executablePath ? path.basename(executablePath) : undefined
  };
}

async function getProcessCreationTime(pid: number): Promise<string | undefined> {
  if (!isProcessAlive(pid)) {
    return undefined;
  }
  if (process.platform === "win32") {
    return (await getWindowsProcessInfo(pid))?.creationTime;
  }
  if (process.platform === "linux") {
    return getLinuxProcessCreationTime(pid);
  }
  return getPosixProcessField(pid, "lstart=");
}

async function getLinuxProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  try {
    const [rawCommandLine, executablePath, creationTime] = await Promise.all([
      fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8"),
      fs.promises.readlink(`/proc/${pid}/exe`).catch(() => undefined),
      getLinuxProcessCreationTime(pid)
    ]);
    const args = rawCommandLine.split("\0").filter(Boolean);
    return {
      pid,
      args,
      commandLine: args.map(formatCommandLineArgument).join(" ") || undefined,
      executablePath,
      creationTime,
      name: executablePath ? path.basename(executablePath) : undefined
    };
  } catch {
    return undefined;
  }
}

async function getLinuxProcessCreationTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      return undefined;
    }
    const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19];
    return startTicks ? `linux-start-ticks:${startTicks}` : undefined;
  } catch {
    return undefined;
  }
}

function formatCommandLineArgument(argument: string): string {
  return /\s/.test(argument) ? JSON.stringify(argument) : argument;
}

async function getPosixProcessField(pid: number, field: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", field]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function getPortOwnerProcessInfo(port: number): Promise<ProcessInfo | undefined> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], {
        timeout: WINDOWS_PROCESS_INFO_TIMEOUT_MS,
        windowsHide: true
      });
      const pid = parseWindowsNetstatPortOwnerPid(String(stdout), port);
      return pid === undefined ? undefined : getProcessInfo(pid);
    } catch {
      return undefined;
    }
  }

  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const pid = Number(stdout.trim().split(/\s+/, 1)[0]);
    return Number.isInteger(pid) && pid > 0 ? getProcessInfo(pid) : undefined;
  } catch {
    return process.platform === "linux" ? getLinuxPortOwnerProcessInfo(port) : undefined;
  }
}

/** Parse native Windows netstat output without depending on localized state labels. */
export function parseWindowsNetstatPortOwnerPid(output: string, port: number): number | undefined {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0]?.toUpperCase() !== "TCP") {
      continue;
    }
    const localPort = parseEndpointPort(fields[1]);
    const remotePort = parseEndpointPort(fields[2]);
    const state = fields[3]?.toUpperCase();
    const pid = Number(fields.at(-1));
    if (
      localPort === port &&
      (remotePort === 0 || state === "LISTENING") &&
      Number.isInteger(pid) &&
      pid > 0
    ) {
      return pid;
    }
  }
  return undefined;
}

function parseEndpointPort(endpoint: string | undefined): number | undefined {
  const match = /:(\d+)$/.exec(endpoint || "");
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}

/**
 * Return the top-level Chrome browser processes that explicitly claim this
 * profile. A failed process-table inspection is deliberately distinguishable
 * from an empty result: callers that want to transfer ownership must fail
 * closed when the operating system cannot provide this evidence.
 *
 * Chrome child processes normally carry `--type=…`; they are not independent
 * profile owners, so this intentionally returns only browser-root processes.
 */
export async function getChromeBrowserProcessesUsingProfile(
  profileDir: string,
  options: DeadlineOptions = {}
): Promise<ProcessInfo[] | undefined> {
  const deadlineAt = resolveDeadlineAt(options);
  const timeoutMessage = "Timed out while inspecting Chrome processes using the ask profile.";
  throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
  return raceWithDeadline(
    listChromeBrowserProcessesUsingProfile(profileDir, deadlineAt),
    deadlineAt,
    timeoutMessage
  );
}

async function listChromeBrowserProcessesUsingProfile(
  profileDir: string,
  deadlineAt: number | undefined
): Promise<ProcessInfo[] | undefined> {
  if (process.platform === "win32") {
    return getWindowsChromeBrowserProcessesUsingProfile(profileDir, deadlineAt);
  }
  if (process.platform === "linux") {
    return getLinuxChromeBrowserProcessesUsingProfile(profileDir, deadlineAt);
  }
  return getPosixChromeBrowserProcessesUsingProfile(profileDir, deadlineAt);
}

async function getLinuxChromeBrowserProcessesUsingProfile(
  profileDir: string,
  deadlineAt: number | undefined
): Promise<ProcessInfo[] | undefined> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir("/proc", { withFileTypes: true });
  } catch {
    return undefined;
  }

  const matches: ProcessInfo[] = [];
  for (const entry of entries) {
    throwIfDeadlineExceeded(deadlineAt, "Timed out while inspecting Chrome processes using the ask profile.");
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    let rawCommandLine: string;
    try {
      rawCommandLine = await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const args = rawCommandLine.split("\0").filter(Boolean);
    if (!processUsesChromeProfile({ pid, args }, profileDir) || processIsChromeChild({ pid, args })) {
      continue;
    }
    const info = await getLinuxProcessInfo(pid);
    if (info && processUsesChromeProfile(info, profileDir) && !processIsChromeChild(info)) {
      matches.push(info);
    }
  }
  return matches;
}

async function getPosixChromeBrowserProcessesUsingProfile(
  profileDir: string,
  deadlineAt: number | undefined
): Promise<ProcessInfo[] | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,command="]));
  } catch {
    return undefined;
  }

  const candidatePids = stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .filter((match) => commandLineContainsProfile(match[2], profileDir) && !commandLineContainsChromeChildSwitch(match[2]))
    .map((match) => Number(match[1]));

  const matches: ProcessInfo[] = [];
  for (const pid of candidatePids) {
    throwIfDeadlineExceeded(deadlineAt, "Timed out while inspecting Chrome processes using the ask profile.");
    const info = await getProcessInfo(pid);
    if (info && processUsesChromeProfile(info, profileDir) && !processIsChromeChild(info)) {
      matches.push(info);
    }
  }
  return matches;
}

async function getWindowsChromeBrowserProcessesUsingProfile(
  profileDir: string,
  deadlineAt: number | undefined
): Promise<ProcessInfo[] | undefined> {
  try {
    throwIfDeadlineExceeded(deadlineAt, "Timed out while inspecting Chrome processes using the ask profile.");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,CreationDate,ExecutablePath | ConvertTo-Json -Compress"
    ]);
    const parsed: unknown = JSON.parse(stdout);
    const values = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const matches: ProcessInfo[] = [];
    for (const value of values) {
      throwIfDeadlineExceeded(deadlineAt, "Timed out while inspecting Chrome processes using the ask profile.");
      if (!value || typeof value !== "object") {
        continue;
      }
      const record = value as Record<string, unknown>;
      const pid = Number(record.ProcessId);
      const info: ProcessInfo = {
        pid,
        name: typeof record.Name === "string" ? record.Name : undefined,
        commandLine: typeof record.CommandLine === "string" ? record.CommandLine : undefined,
        creationTime: typeof record.CreationDate === "string" ? record.CreationDate : undefined,
        executablePath: typeof record.ExecutablePath === "string" ? record.ExecutablePath : undefined
      };
      if (Number.isInteger(pid) && pid > 0 && processUsesChromeProfile(info, profileDir) && !processIsChromeChild(info)) {
        matches.push(info);
      }
    }
    return matches;
  } catch {
    return undefined;
  }
}

async function getLinuxPortOwnerProcessInfo(port: number): Promise<ProcessInfo | undefined> {
  const socketInodes = new Set<string>();
  for (const tablePath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const table = await fs.promises.readFile(tablePath, "utf8");
      for (const line of table.split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10 || fields[3] !== "0A") {
          continue;
        }
        const localPortHex = fields[1]?.split(":").at(-1);
        if (localPortHex && Number.parseInt(localPortHex, 16) === port) {
          socketInodes.add(fields[9]);
        }
      }
    } catch {
      // The IPv4 or IPv6 table may be unavailable in a restricted container.
    }
  }
  if (socketInodes.size === 0) {
    return undefined;
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir("/proc", { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    let descriptors: string[];
    try {
      descriptors = await fs.promises.readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        const target = await fs.promises.readlink(`/proc/${pid}/fd/${descriptor}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match && socketInodes.has(match[1])) {
          return getProcessInfo(pid);
        }
      } catch {
        // Descriptors can disappear while the process is being inspected.
      }
    }
  }
  return undefined;
}

async function getWindowsProcessInfo(
  pid: number,
  timeoutMs = WINDOWS_PROCESS_INFO_TIMEOUT_MS
): Promise<ProcessInfo | undefined> {
  const inspection = await inspectWindowsProcessInfo(pid, timeoutMs);
  return inspection.status === "found" ? inspection.info : undefined;
}

type WindowsProcessInspection =
  | { status: "found"; info: ProcessInfo }
  | { status: "absent" }
  | { status: "unavailable" };

async function inspectWindowsProcessInfo(
  pid: number,
  timeoutMs = WINDOWS_PROCESS_INFO_TIMEOUT_MS
): Promise<WindowsProcessInspection> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | ConvertTo-Json -Compress`
    ], { timeout: timeoutMs, windowsHide: true });
    const trimmed = String(stdout).trim();
    if (!trimmed) {
      return { status: "absent" };
    }

    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") {
      return { status: "unavailable" };
    }

    const value = parsed as Record<string, unknown>;
    return {
      status: "found",
      info: {
        pid,
        name: typeof value.Name === "string" ? value.Name : undefined,
        commandLine: typeof value.CommandLine === "string" ? value.CommandLine : undefined,
        creationTime: typeof value.CreationDate === "string" ? value.CreationDate : undefined,
        executablePath: typeof value.ExecutablePath === "string" ? value.ExecutablePath : undefined
      }
    };
  } catch {
    return { status: "unavailable" };
  }
}

export async function classifySession(
  env: NodeJS.ProcessEnv,
  port: number,
  debuggingConnected: boolean,
  dependencies: SessionClassificationDependencies = {}
): Promise<SessionClassification> {
  const deadlineAt = dependencies.deadlineAt;
  const timeoutMessage = `Timed out while verifying ownership of Chrome debugging on port ${port}.`;
  throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
  if (!debuggingConnected) {
    return { ownership: "absent", reason: "No Chrome debugging endpoint is available." };
  }

  const state = await readSessionState(env, { deadlineAt });
  if (!state) {
    return {
      ownership: "external",
      process: await inspectPortOwnerWithinDeadline(port, dependencies, timeoutMessage),
      reason: "Chrome debugging is available, but no valid ask session state was found."
    };
  }

  if (state.port !== port) {
    const processInfo = await inspectPortOwnerWithinDeadline(port, dependencies, timeoutMessage);
    // A process using the dedicated profile on a different endpoint is not an
    // ordinary external listener. Browser lifecycle recovery may later prove
    // an exact automatic-generation handoff, but callers must otherwise treat
    // this as unknown rather than attach to or replace it.
    if (processInfo && processUsesChromeProfile(processInfo, getChromeProfileDir(env))) {
      return {
        ownership: "unknown",
        state,
        process: processInfo,
        reason: "Chrome debugging port differs from ask state, but the listener uses the ask profile."
      };
    }
    return {
      ownership: "external",
      state,
      process: processInfo,
      reason: "Chrome debugging port does not match ask session state."
    };
  }

  if (normalizePathForCompare(state.profileDir) !== normalizePathForCompare(getChromeProfileDir(env))) {
    return { ownership: "unknown", state, reason: "Ask session state points to a different profile directory." };
  }

  if (!(await hasProfileMarker(env, { deadlineAt }))) {
    return { ownership: "unknown", state, reason: "Ask profile marker is missing or invalid." };
  }

  const expectedLaunchPort = state.requestedPort ?? (state.portPolicy === "automatic" ? 0 : port);
  const processInfo = await inspectPortOwnerWithinDeadline(port, dependencies, timeoutMessage);
  if (!processInfo) {
    return {
      ownership: "unknown",
      state,
      reason: "The debugging endpoint listener process could not be verified."
    };
  }
  if (processInfo.pid !== state.pid) {
    return {
      ownership: "unknown",
      state,
      process: processInfo,
      reason: "The debugging endpoint is owned by a different process than ask session state."
    };
  }
  if (!processMatchesAskSession(processInfo, expectedLaunchPort, state.profileDir, state.generation)) {
    return {
      ownership: "unknown",
      state,
      process: processInfo,
      reason: "Debugging endpoint owner command line does not match the ask port/profile/generation."
    };
  }

  if (!state.generation && (!state.processCreationTime || !processInfo.creationTime)) {
    return {
      ownership: "unknown",
      state,
      process: processInfo,
      reason: "Legacy ask session state lacks enough process-generation evidence to verify ownership."
    };
  }

  if (
    state.processCreationTime &&
    processInfo.creationTime &&
    !(await processCreationTimesMatch(
      state.processCreationTime,
      processInfo.creationTime,
      processInfo.pid,
      dependencies
    ))
  ) {
    return { ownership: "unknown", state, process: processInfo, reason: "Process creation time does not match ask state." };
  }

  return { ownership: "ask-managed", state, process: processInfo };
}

async function inspectPortOwnerWithinDeadline(
  port: number,
  dependencies: SessionClassificationDependencies,
  timeoutMessage: string
): Promise<ProcessInfo | undefined> {
  throwIfDeadlineExceeded(dependencies.deadlineAt, timeoutMessage);
  return raceWithDeadline(
    (dependencies.getPortOwnerProcessInfo || getPortOwnerProcessInfo)(port),
    dependencies.deadlineAt,
    timeoutMessage
  );
}

async function processCreationTimesMatch(
  expected: string,
  current: string,
  pid: number,
  dependencies: SessionClassificationDependencies
): Promise<boolean> {
  if (expected === current) {
    return true;
  }

  // Linux ownership inspection now uses /proc start ticks, while early v1
  // state used `ps lstart`. Re-read the legacy representation only when the
  // two stored values are from those different domains.
  if (!expected.startsWith("linux-start-ticks:") && current.startsWith("linux-start-ticks:")) {
    const getLegacyCreationTime = dependencies.getLegacyProcessCreationTime ||
      (process.platform === "linux"
        ? (candidatePid: number) => getPosixProcessField(candidatePid, "lstart=")
        : undefined);
    if (!getLegacyCreationTime) {
      return false;
    }
    const timeoutMessage = `Timed out while verifying process ${pid} creation time.`;
    throwIfDeadlineExceeded(dependencies.deadlineAt, timeoutMessage);
    return await raceWithDeadline(
      getLegacyCreationTime(pid),
      dependencies.deadlineAt,
      timeoutMessage
    ) === expected;
  }
  return false;
}

export function processMatchesAskSession(
  processInfo: ProcessInfo,
  port: number,
  profileDir: string,
  generation?: string
): boolean {
  if (!processInfo.commandLine && !processInfo.args) {
    return false;
  }

  const portMatches = processSwitchMatches(processInfo, "remote-debugging-port", String(port), false, (value) =>
    /^\d+$/.test(value) && Number(value) === port
  );
  const profileMatches = processUsesChromeProfile(processInfo, profileDir);
  const generationMatches = generation === undefined || processSwitchMatches(
    processInfo,
    "ask-session-generation",
    generation,
    false,
    (value) => value === generation
  );

  return portMatches && profileMatches && generationMatches;
}

/**
 * Check only the dedicated user-data-dir claim. This is intentionally exposed
 * separately from processMatchesAskSession so a same-profile process with a
 * malformed, missing, or wrong debugging-generation flag remains unsafe to
 * adopt instead of being mistaken for an unrelated external listener.
 */
export function processUsesChromeProfile(processInfo: ProcessInfo, profileDir: string): boolean {
  if (!processInfo.commandLine && !processInfo.args) {
    return false;
  }
  return processSwitchMatches(
    processInfo,
    "user-data-dir",
    profileDir,
    isWindowsStylePath(profileDir),
    (value) => normalizePathForCompare(value) === normalizePathForCompare(profileDir),
    (commandLine) => commandLineContainsProfile(commandLine, profileDir)
  );
}

function processIsChromeChild(processInfo: ProcessInfo): boolean {
  if (processInfo.args) {
    return commandLineSwitchValues(processInfo.args, "type").length > 0;
  }
  return commandLineContainsChromeChildSwitch(processInfo.commandLine || "");
}

function commandLineContainsChromeChildSwitch(commandLine: string): boolean {
  return /(?:^|\s)(?:["']?--type(?:=|\s+))/i.test(commandLine);
}

function processSwitchMatches(
  processInfo: ProcessInfo,
  name: string,
  expectedValue: string,
  caseInsensitive: boolean,
  valueMatches: (value: string) => boolean = (value) => value === expectedValue,
  rawFallback?: (commandLine: string) => boolean
): boolean {
  if (processInfo.args) {
    const values = commandLineSwitchValues(processInfo.args, name);
    // With an argv vector we can reject contradictory duplicate switches
    // instead of accepting whichever one happened to appear first.
    return values.length > 0 && values.every(valueMatches);
  }
  const commandLine = processInfo.commandLine || "";
  if (rawFallback) {
    return rawFallback(commandLine);
  }
  return commandLineContainsSwitchValue(commandLine, name, expectedValue, caseInsensitive);
}

function commandLineContainsProfile(commandLine: string, profileDir: string): boolean {
  const normalized = normalizePathForCompare(profileDir);
  const candidates = isWindowsStylePath(profileDir)
    ? [profileDir, normalized, normalized.replace(/\\/g, "/")]
    : [profileDir, normalized];
  return [...new Set(candidates)].some((candidate) =>
    commandLineContainsSwitchValue(commandLine, "user-data-dir", candidate, isWindowsStylePath(profileDir))
  );
}

function commandLineContainsSwitchValue(
  commandLine: string,
  name: string,
  expectedValue: string,
  caseInsensitive: boolean
): boolean {
  if (!commandLine) {
    return false;
  }
  const flag = `--${escapeRegExp(name)}`;
  const value = escapeRegExp(expectedValue);
  const expressions = [
    `(?:^|\\s)${flag}=(?:"${value}"|'${value}'|${value})(?=\\s|$)`,
    `(?:^|\\s)${flag}\\s+(?:"${value}"|'${value}'|${value})(?=\\s|$)`,
    `(?:^|\\s)"${flag}=${value}"(?=\\s|$)`,
    `(?:^|\\s)'${flag}=${value}'(?=\\s|$)`
  ];
  return expressions.some((expression) => new RegExp(expression, caseInsensitive ? "i" : "").test(commandLine));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;

  for (let index = 0; index < commandLine.length; index += 1) {
    const character = commandLine[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && commandLine[index + 1] === quote) {
        current += quote;
        index += 1;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function commandLineSwitchValues(args: string[], name: string): string[] {
  const values: string[] = [];
  const flag = `--${name}`.toLowerCase();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const lower = argument.toLowerCase();
    if (lower === flag) {
      const value = args[index + 1];
      if (value !== undefined) {
        values.push(value);
      }
      index += 1;
      continue;
    }
    if (lower.startsWith(`${flag}=`)) {
      values.push(argument.slice(flag.length + 1));
    }
  }
  return values;
}

function commandLineSwitchValue(args: string[], name: string): string | undefined {
  return commandLineSwitchValues(args, name)[0];
}

function isValidAssignedPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function hasValidPersistedPortMetadata(
  assignedPort: number,
  portPolicy: PersistedChromePortPolicy | undefined,
  requestedPort: number | undefined
): boolean {
  if (portPolicy === undefined && requestedPort === undefined) {
    return true;
  }
  if (portPolicy === undefined || requestedPort === undefined) {
    return false;
  }
  return portPolicy === "automatic"
    ? requestedPort === 0
    : requestedPort === assignedPort;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
