import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAskHome } from "./config";
import type { ProviderName } from "./providers";
import { getProcessInfo, type ProcessInfo } from "./session";

export const MAX_ACTIVE_EXECUTIONS = 4;
export const MAX_QUEUED_EXECUTIONS = 4;
export const EXECUTION_QUEUE_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

const EXECUTION_STATE_VERSION = 1;
const DEFAULT_POLL_MS = 250;
const PROCESS_RECHECK_MS = 2_000;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STALE_STATE_LOCK_MS = 30_000;

interface ExecutionEntry {
  id: string;
  pid: number;
  processCreationTime?: string;
  processCheckedAt: number;
  provider: ProviderName;
  conversationName?: string;
  exclusiveProvider: boolean;
  headless: boolean;
  createdAt: number;
  activatedAt?: number;
}

interface ExecutionState {
  version: 1;
  active: ExecutionEntry[];
  queued: ExecutionEntry[];
  guards: ExecutionGuard[];
}

interface ExecutionGuard {
  id: string;
  pid: number;
  processCreationTime?: string;
  processCheckedAt: number;
  createdAt: number;
  kind: "browser" | "conversation" | "provider-readiness";
  headless?: boolean;
  exclusive?: boolean;
  provider?: ProviderName;
  conversationName?: string;
}

export interface ExecutionQueueUpdate {
  phase: "queued" | "active";
  position: number;
  active: number;
  queued: number;
  waitedMs: number;
}

export interface ExecutionRequest {
  provider: ProviderName;
  conversationName?: string;
  exclusiveProvider?: boolean;
  headless?: boolean;
  onUpdate?: (update: ExecutionQueueUpdate) => void;
}

export interface ExecutionLease {
  id: string;
  release(): Promise<void>;
}

export interface BrowserLeaseRequest {
  headless: boolean;
  exclusive?: boolean;
  /** Wait for active executions and browser guards to drain before acquiring an exclusive lease. */
  waitForIdle?: boolean;
  /** Deadline used only while waiting for an idle exclusive lease. */
  timeoutMs?: number;
  action: string;
}

export interface ExecutionQueueSnapshot {
  active: number;
  queued: number;
}

interface ExecutionQueueOptions {
  maxActive?: number;
  maxQueued?: number;
  waitTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  getProcessInfo?: (pid: number) => Promise<ProcessInfo | undefined>;
  handleSignals?: boolean;
}

export interface ExecutionQueue {
  acquire(request: ExecutionRequest): Promise<ExecutionLease>;
  acquireBrowserLease(request: BrowserLeaseRequest): Promise<ExecutionLease>;
  acquireProviderReadinessLease(provider: ProviderName, timeoutMs?: number): Promise<ExecutionLease>;
  acquireConversationLease(provider: ProviderName, conversationName: string): Promise<ExecutionLease>;
  inspect(): Promise<ExecutionQueueSnapshot>;
  assertNoActive(action: string): Promise<void>;
  assertConversationIdle(provider: ProviderName, conversationName: string): Promise<void>;
}

export function getExecutionStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getAskHome(env), "executions.json");
}

export function getExecutionStateLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getAskHome(env), "executions.lock");
}

export function createExecutionQueue(
  env: NodeJS.ProcessEnv = process.env,
  options: ExecutionQueueOptions = {}
): ExecutionQueue {
  const maxActive = options.maxActive ?? MAX_ACTIVE_EXECUTIONS;
  const maxQueued = options.maxQueued ?? MAX_QUEUED_EXECUTIONS;
  const waitTimeoutMs = options.waitTimeoutMs ?? EXECUTION_QUEUE_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? Date.now;
  const inspectProcess = options.getProcessInfo ?? getProcessInfo;
  const handleSignals = options.handleSignals ?? true;

  return {
    acquire: async (request) => {
      const owner = await inspectProcess(process.pid);
      const entry: ExecutionEntry = {
        id: crypto.randomUUID(),
        pid: process.pid,
        processCreationTime: owner?.creationTime,
        processCheckedAt: now(),
        provider: request.provider,
        conversationName: request.conversationName,
        exclusiveProvider: Boolean(request.exclusiveProvider),
        headless: Boolean(request.headless),
        createdAt: now()
      };

      const initial = await updateState(env, now, inspectProcess, (state) => {
        promoteEligible(state, maxActive, now());
        if (state.queued.length >= maxQueued) {
          throw new Error(
            `ask: execution queue is full (${state.active.length} active, ${state.queued.length} waiting)`
          );
        }
        state.queued.push(entry);
        promoteEligible(state, maxActive, now());
        return locateEntry(state, entry.id, now());
      });

      let lastPhase: ExecutionQueueUpdate["phase"] | undefined;
      let lastPosition = -1;
      const notify = (update: ExecutionQueueUpdate) => {
        if (update.phase !== lastPhase || update.position !== lastPosition) {
          request.onUpdate?.(update);
          lastPhase = update.phase;
          lastPosition = update.position;
        }
      };
      if (initial.phase === "missing") {
        throw new Error("ask: execution queue entry disappeared during admission");
      }
      let terminating = false;
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
      const removeSignalHandlers = () => {
        if (!handleSignals) {
          return;
        }
        for (const signal of signals) {
          process.removeListener(signal, signalHandlers[signal]);
        }
      };
      const signalHandlers = Object.fromEntries(signals.map((signal) => [signal, () => {
        if (terminating) {
          return;
        }
        terminating = true;
        removeSignalHandlers();
        removeEntry(env, entry.id, now, inspectProcess, maxActive)
          .catch(() => undefined)
          .finally(() => process.kill(process.pid, signal));
      }])) as Record<NodeJS.Signals, () => void>;
      if (handleSignals) {
        for (const signal of signals) {
          process.once(signal, signalHandlers[signal]);
        }
      }
      notify(initial);

      try {
        let current: ExecutionQueueUpdate = initial;
        while (current.phase !== "active") {
          const waitedMs = now() - entry.createdAt;
          if (waitedMs >= waitTimeoutMs) {
            await removeEntry(env, entry.id, now, inspectProcess, maxActive);
            throw new Error(
              `ask: timed out after ${Math.ceil(waitTimeoutMs / 1000)} seconds waiting for an execution slot`
            );
          }

          await delay(Math.min(pollMs, waitTimeoutMs - waitedMs));
          current = await updateState(env, now, inspectProcess, (state) => {
            promoteEligible(state, maxActive, now());
            const located = locateEntry(state, entry.id, now());
            if (located.phase === "missing") {
              throw new Error("ask: execution queue entry disappeared while waiting");
            }
            return located;
          });
          notify(current);
        }

        let released = false;
        return {
          id: entry.id,
          release: async () => {
            if (released) {
              return;
            }
            released = true;
            removeSignalHandlers();
            await removeEntry(env, entry.id, now, inspectProcess, maxActive);
          }
        };
      } catch (error) {
        removeSignalHandlers();
        await removeEntry(env, entry.id, now, inspectProcess, maxActive).catch(() => undefined);
        throw error;
      }
    },

    acquireBrowserLease: async (request) => {
      const guard = await createGuard("browser", now, inspectProcess, {
        headless: request.headless,
        exclusive: Boolean(request.exclusive)
      });

      if (request.exclusive && request.waitForIdle) {
        const idleWaitTimeoutMs = Math.max(0, request.timeoutMs ?? waitTimeoutMs);
        const deadline = now() + idleWaitTimeoutMs;
        try {
          while (true) {
            const acquired = await updateState(env, now, inspectProcess, (state) => {
              promoteEligible(state, maxActive, now());
              const browserGuards = state.guards.filter((entry) => entry.kind === "browser");
              const anotherExclusiveGuard = browserGuards.some(
                (entry) => entry.exclusive && entry.id !== guard.id
              );
              if (anotherExclusiveGuard) {
                return false;
              }

              if (!state.guards.some((entry) => entry.id === guard.id)) {
                // Reserve the exclusive transition while existing operations
                // drain. This prevents a new prompt from racing into the gap
                // between the idle check and setup's browser connection.
                state.guards.push(guard);
              }

              const otherBrowserGuards = state.guards.some(
                (entry) => entry.kind === "browser" && entry.id !== guard.id
              );
              return state.active.length === 0 && !otherBrowserGuards;
            });

            if (acquired) {
              return guardLease(env, guard.id, now, inspectProcess, maxActive);
            }
            if (now() >= deadline) {
              throw new Error(
                `ask: timed out after ${Math.ceil(idleWaitTimeoutMs / 1000)} seconds waiting to ${request.action} until the browser is idle`
              );
            }
            await delay(Math.min(pollMs, Math.max(1, deadline - now())));
          }
        } catch (error) {
          // The reservation may have been installed before the timeout or a
          // state-write failure. Remove it so queued work can continue.
          await updateState(env, now, inspectProcess, (state) => {
            state.guards = state.guards.filter((entry) => entry.id !== guard.id);
            promoteEligible(state, maxActive, now());
          }).catch(() => undefined);
          throw error;
        }
      }

      await updateState(env, now, inspectProcess, (state) => {
        promoteEligible(state, maxActive, now());
        const browserGuards = state.guards.filter((entry) => entry.kind === "browser");
        if (request.exclusive) {
          if (state.active.length > 0 || browserGuards.length > 0) {
            const operationCount = state.active.length + browserGuards.length;
            throw new Error(
              `ask: cannot ${request.action} while ${operationCount} browser operation${operationCount === 1 ? " is" : "s are"} active`
            );
          }
        } else {
          const incompatibleActive = state.active.some((entry) => entry.headless !== request.headless);
          const incompatibleGuard = browserGuards.some(
            (entry) => entry.exclusive || entry.headless !== request.headless
          );
          if (incompatibleActive || incompatibleGuard) {
            throw new Error(`ask: cannot ${request.action} while an incompatible browser mode is active`);
          }
        }
        state.guards.push(guard);
      });
      return guardLease(env, guard.id, now, inspectProcess, maxActive);
    },

    acquireProviderReadinessLease: async (provider, readinessTimeoutMs = waitTimeoutMs) => {
      const guard = await createGuard("provider-readiness", now, inspectProcess, { provider });
      const deadline = now() + readinessTimeoutMs;

      while (true) {
        const acquired = await updateState(env, now, inspectProcess, (state) => {
          promoteEligible(state, maxActive, now());
          const existing = state.guards.some(
            (entry) => entry.kind === "provider-readiness" && entry.provider === provider
          );
          if (existing) {
            return false;
          }
          state.guards.push(guard);
          return true;
        });

        if (acquired) {
          return guardLease(env, guard.id, now, inspectProcess, maxActive);
        }
        if (now() >= deadline) {
          throw new Error(
            `ask: timed out after ${Math.ceil(readinessTimeoutMs / 1000)} seconds waiting for ${provider} readiness`
          );
        }
        await delay(Math.min(pollMs, Math.max(1, deadline - now())));
      }
    },

    acquireConversationLease: async (provider, conversationName) => {
      const guard = await createGuard("conversation", now, inspectProcess, {
        provider,
        conversationName
      });
      await updateState(env, now, inspectProcess, (state) => {
        promoteEligible(state, maxActive, now());
        const busy = [...state.active, ...state.queued].some(
          (entry) => entry.provider === provider && entry.conversationName === conversationName
        ) || state.guards.some(
          (entry) => entry.kind === "conversation" &&
            entry.provider === provider && entry.conversationName === conversationName
        );
        if (busy) {
          throw new Error(
            `ask: cannot forget conversation "${conversationName}" while it has an active or queued execution`
          );
        }
        state.guards.push(guard);
      });
      return guardLease(env, guard.id, now, inspectProcess, maxActive);
    },

    inspect: async () => updateState(env, now, inspectProcess, (state) => {
      promoteEligible(state, maxActive, now());
      return { active: state.active.length, queued: state.queued.length };
    }),

    assertNoActive: async (action) => {
      const snapshot = await updateState(env, now, inspectProcess, (state) => {
        promoteEligible(state, maxActive, now());
        return { active: state.active.length, queued: state.queued.length };
      });
      if (snapshot.active > 0) {
        throw new Error(
          `ask: cannot ${action} while ${snapshot.active} execution${snapshot.active === 1 ? " is" : "s are"} active`
        );
      }
    },

    assertConversationIdle: async (provider, conversationName) => {
      const busy = await updateState(env, now, inspectProcess, (state) =>
        [...state.active, ...state.queued].some(
          (entry) => entry.provider === provider && entry.conversationName === conversationName
        )
      );
      if (busy) {
        throw new Error(
          `ask: cannot forget conversation "${conversationName}" while it has an active or queued execution`
        );
      }
    }
  };
}

type LocatedEntry = ExecutionQueueUpdate | { phase: "missing" };

function locateEntry(state: ExecutionState, id: string, currentTime: number): LocatedEntry {
  const activeIndex = state.active.findIndex((entry) => entry.id === id);
  if (activeIndex >= 0) {
    const entry = state.active[activeIndex];
    return {
      phase: "active",
      position: 0,
      active: state.active.length,
      queued: state.queued.length,
      waitedMs: Math.max(0, (entry.activatedAt ?? currentTime) - entry.createdAt)
    };
  }

  const queuedIndex = state.queued.findIndex((entry) => entry.id === id);
  if (queuedIndex >= 0) {
    return {
      phase: "queued",
      position: queuedIndex + 1,
      active: state.active.length,
      queued: state.queued.length,
      waitedMs: Math.max(0, currentTime - state.queued[queuedIndex].createdAt)
    };
  }

  return { phase: "missing" };
}

function promoteEligible(state: ExecutionState, maxActive: number, currentTime: number): void {
  while (state.active.length < maxActive) {
    const index = state.queued.findIndex((entry, entryIndex) =>
      isEligible(entry, state.active, state.queued.slice(0, entryIndex), state.guards)
    );
    if (index < 0) {
      return;
    }
    const [entry] = state.queued.splice(index, 1);
    entry.activatedAt = currentTime;
    state.active.push(entry);
  }
}

function isEligible(
  candidate: ExecutionEntry,
  active: ExecutionEntry[],
  earlierQueued: ExecutionEntry[],
  guards: ExecutionGuard[]
): boolean {
  if (guards.some((guard) => guard.kind === "browser" && guard.exclusive)) {
    return false;
  }
  if (guards.some((guard) => guard.kind === "browser" && guard.headless !== candidate.headless)) {
    return false;
  }
  if (candidate.conversationName && guards.some(
    (guard) => guard.kind === "conversation" &&
      guard.provider === candidate.provider && guard.conversationName === candidate.conversationName
  )) {
    return false;
  }
  if (active.some((entry) => entry.headless !== candidate.headless)) {
    return false;
  }
  const sameProvider = active.filter((entry) => entry.provider === candidate.provider);
  const earlierSameProvider = earlierQueued.filter((entry) => entry.provider === candidate.provider);
  if (earlierSameProvider.some((entry) => entry.exclusiveProvider)) {
    return false;
  }
  if (candidate.exclusiveProvider) {
    return sameProvider.length === 0 && earlierSameProvider.length === 0;
  }
  if (sameProvider.some((entry) => entry.exclusiveProvider)) {
    return false;
  }
  if (!candidate.conversationName) {
    return true;
  }
  if (earlierSameProvider.some((entry) => entry.conversationName === candidate.conversationName)) {
    return false;
  }
  return !sameProvider.some((entry) => entry.conversationName === candidate.conversationName);
}

async function removeEntry(
  env: NodeJS.ProcessEnv,
  id: string,
  now: () => number,
  inspectProcess: (pid: number) => Promise<ProcessInfo | undefined>,
  maxActive: number
): Promise<void> {
  await updateState(env, now, inspectProcess, (state) => {
    state.active = state.active.filter((entry) => entry.id !== id);
    state.queued = state.queued.filter((entry) => entry.id !== id);
    promoteEligible(state, maxActive, now());
  });
}

async function createGuard(
  kind: ExecutionGuard["kind"],
  now: () => number,
  inspectProcess: (pid: number) => Promise<ProcessInfo | undefined>,
  details: Partial<ExecutionGuard>
): Promise<ExecutionGuard> {
  const owner = await inspectProcess(process.pid);
  return {
    id: crypto.randomUUID(),
    pid: process.pid,
    processCreationTime: owner?.creationTime,
    processCheckedAt: now(),
    createdAt: now(),
    kind,
    ...details
  };
}

function guardLease(
  env: NodeJS.ProcessEnv,
  id: string,
  now: () => number,
  inspectProcess: (pid: number) => Promise<ProcessInfo | undefined>,
  maxActive: number
): ExecutionLease {
  let released = false;
  return {
    id,
    release: async () => {
      if (released) {
        return;
      }
      await updateState(env, now, inspectProcess, (state) => {
        state.guards = state.guards.filter((guard) => guard.id !== id);
        promoteEligible(state, maxActive, now());
      });
      released = true;
    }
  };
}

async function updateState<T>(
  env: NodeJS.ProcessEnv,
  now: () => number,
  inspectProcess: (pid: number) => Promise<ProcessInfo | undefined>,
  update: (state: ExecutionState) => T | Promise<T>
): Promise<T> {
  return withStateLock(env, now, async () => {
    const state = await readState(env);
    await removeDeadEntries(state, now(), inspectProcess);
    const result = await update(state);
    await writeState(env, state);
    return result;
  });
}

async function removeDeadEntries(
  state: ExecutionState,
  currentTime: number,
  inspectProcess: (pid: number) => Promise<ProcessInfo | undefined>
): Promise<void> {
  const alive: Array<ExecutionEntry | ExecutionGuard> = [];
  for (const entry of [...state.active, ...state.queued, ...state.guards]) {
    if (currentTime - entry.processCheckedAt < PROCESS_RECHECK_MS) {
      alive.push(entry);
      continue;
    }
    const processInfo = await inspectProcess(entry.pid);
    if (!processInfo) {
      continue;
    }
    if (
      entry.processCreationTime &&
      processInfo.creationTime &&
      entry.processCreationTime !== processInfo.creationTime
    ) {
      continue;
    }
    entry.processCheckedAt = currentTime;
    alive.push(entry);
  }

  const ids = new Set(alive.map((entry) => entry.id));
  state.active = state.active.filter((entry) => ids.has(entry.id));
  state.queued = state.queued.filter((entry) => ids.has(entry.id));
  state.guards = state.guards.filter((entry) => ids.has(entry.id));
}

async function readState(env: NodeJS.ProcessEnv): Promise<ExecutionState> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(getExecutionStatePath(env), "utf8")) as Partial<ExecutionState>;
    if (parsed.version === EXECUTION_STATE_VERSION && Array.isArray(parsed.active) && Array.isArray(parsed.queued)) {
      return {
        version: 1,
        active: parsed.active,
        queued: parsed.queued,
        guards: Array.isArray(parsed.guards) ? parsed.guards : []
      };
    }
  } catch {
    // Missing or invalid state starts empty.
  }
  return { version: 1, active: [], queued: [], guards: [] };
}

async function writeState(env: NodeJS.ProcessEnv, state: ExecutionState): Promise<void> {
  const statePath = getExecutionStatePath(env);
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.promises.rename(temporaryPath, statePath);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function withStateLock<T>(env: NodeJS.ProcessEnv, now: () => number, fn: () => Promise<T>): Promise<T> {
  const lockPath = getExecutionStateLockPath(env);
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = now() + STATE_LOCK_TIMEOUT_MS;
  let handle: fs.promises.FileHandle | undefined;

  while (!handle) {
    try {
      handle = await fs.promises.open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      try {
        const stat = await fs.promises.stat(lockPath);
        if (now() - stat.mtimeMs > STALE_STATE_LOCK_MS) {
          await fs.promises.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (now() >= deadline) {
        throw new Error("ask: timed out waiting to update execution queue state");
      }
      await delay(25);
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
