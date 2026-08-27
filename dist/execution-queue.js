"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXECUTION_QUEUE_WAIT_TIMEOUT_MS = exports.MAX_QUEUED_EXECUTIONS = exports.MAX_ACTIVE_EXECUTIONS = void 0;
exports.getExecutionStatePath = getExecutionStatePath;
exports.getExecutionStateLockPath = getExecutionStateLockPath;
exports.createExecutionQueue = createExecutionQueue;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const session_1 = require("./session");
exports.MAX_ACTIVE_EXECUTIONS = 4;
exports.MAX_QUEUED_EXECUTIONS = 4;
exports.EXECUTION_QUEUE_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const EXECUTION_STATE_VERSION = 1;
const DEFAULT_POLL_MS = 250;
const PROCESS_RECHECK_MS = 2_000;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STALE_STATE_LOCK_MS = 30_000;
function getExecutionStatePath(env = process.env) {
    return node_path_1.default.join((0, config_1.getAskHome)(env), "executions.json");
}
function getExecutionStateLockPath(env = process.env) {
    return node_path_1.default.join((0, config_1.getAskHome)(env), "executions.lock");
}
function createExecutionQueue(env = process.env, options = {}) {
    const maxActive = options.maxActive ?? exports.MAX_ACTIVE_EXECUTIONS;
    const maxQueued = options.maxQueued ?? exports.MAX_QUEUED_EXECUTIONS;
    const waitTimeoutMs = options.waitTimeoutMs ?? exports.EXECUTION_QUEUE_WAIT_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const now = options.now ?? Date.now;
    const inspectProcess = options.getProcessInfo ?? session_1.getProcessInfo;
    const handleSignals = options.handleSignals ?? true;
    return {
        acquire: async (request) => {
            const owner = await inspectProcess(process.pid);
            const entry = {
                id: node_crypto_1.default.randomUUID(),
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
                    throw new Error(`ask: execution queue is full (${state.active.length} active, ${state.queued.length} waiting)`);
                }
                state.queued.push(entry);
                promoteEligible(state, maxActive, now());
                return locateEntry(state, entry.id, now());
            });
            let lastPhase;
            let lastPosition = -1;
            const notify = (update) => {
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
            const signals = ["SIGINT", "SIGTERM"];
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
                }]));
            if (handleSignals) {
                for (const signal of signals) {
                    process.once(signal, signalHandlers[signal]);
                }
            }
            notify(initial);
            try {
                let current = initial;
                while (current.phase !== "active") {
                    const waitedMs = now() - entry.createdAt;
                    if (waitedMs >= waitTimeoutMs) {
                        await removeEntry(env, entry.id, now, inspectProcess, maxActive);
                        throw new Error(`ask: timed out after ${Math.ceil(waitTimeoutMs / 1000)} seconds waiting for an execution slot`);
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
            }
            catch (error) {
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
                            const anotherExclusiveGuard = browserGuards.some((entry) => entry.exclusive && entry.id !== guard.id);
                            if (anotherExclusiveGuard) {
                                return false;
                            }
                            if (!state.guards.some((entry) => entry.id === guard.id)) {
                                // Reserve the exclusive transition while existing operations
                                // drain. This prevents a new prompt from racing into the gap
                                // between the idle check and setup's browser connection.
                                state.guards.push(guard);
                            }
                            const otherBrowserGuards = state.guards.some((entry) => entry.kind === "browser" && entry.id !== guard.id);
                            return state.active.length === 0 && !otherBrowserGuards;
                        });
                        if (acquired) {
                            return guardLease(env, guard.id, now, inspectProcess, maxActive);
                        }
                        if (now() >= deadline) {
                            throw new Error(`ask: timed out after ${Math.ceil(idleWaitTimeoutMs / 1000)} seconds waiting to ${request.action} until the browser is idle`);
                        }
                        await delay(Math.min(pollMs, Math.max(1, deadline - now())));
                    }
                }
                catch (error) {
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
                        throw new Error(`ask: cannot ${request.action} while ${operationCount} browser operation${operationCount === 1 ? " is" : "s are"} active`);
                    }
                }
                else {
                    const incompatibleActive = state.active.some((entry) => entry.headless !== request.headless);
                    const incompatibleGuard = browserGuards.some((entry) => entry.exclusive || entry.headless !== request.headless);
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
                    const existing = state.guards.some((entry) => entry.kind === "provider-readiness" && entry.provider === provider);
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
                    throw new Error(`ask: timed out after ${Math.ceil(readinessTimeoutMs / 1000)} seconds waiting for ${provider} readiness`);
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
                const busy = [...state.active, ...state.queued].some((entry) => entry.provider === provider && entry.conversationName === conversationName) || state.guards.some((entry) => entry.kind === "conversation" &&
                    entry.provider === provider && entry.conversationName === conversationName);
                if (busy) {
                    throw new Error(`ask: cannot forget conversation "${conversationName}" while it has an active or queued execution`);
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
                throw new Error(`ask: cannot ${action} while ${snapshot.active} execution${snapshot.active === 1 ? " is" : "s are"} active`);
            }
        },
        assertConversationIdle: async (provider, conversationName) => {
            const busy = await updateState(env, now, inspectProcess, (state) => [...state.active, ...state.queued].some((entry) => entry.provider === provider && entry.conversationName === conversationName));
            if (busy) {
                throw new Error(`ask: cannot forget conversation "${conversationName}" while it has an active or queued execution`);
            }
        }
    };
}
function locateEntry(state, id, currentTime) {
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
function promoteEligible(state, maxActive, currentTime) {
    while (state.active.length < maxActive) {
        const index = state.queued.findIndex((entry, entryIndex) => isEligible(entry, state.active, state.queued.slice(0, entryIndex), state.guards));
        if (index < 0) {
            return;
        }
        const [entry] = state.queued.splice(index, 1);
        entry.activatedAt = currentTime;
        state.active.push(entry);
    }
}
function isEligible(candidate, active, earlierQueued, guards) {
    if (guards.some((guard) => guard.kind === "browser" && guard.exclusive)) {
        return false;
    }
    if (guards.some((guard) => guard.kind === "browser" && guard.headless !== candidate.headless)) {
        return false;
    }
    if (candidate.conversationName && guards.some((guard) => guard.kind === "conversation" &&
        guard.provider === candidate.provider && guard.conversationName === candidate.conversationName)) {
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
async function removeEntry(env, id, now, inspectProcess, maxActive) {
    await updateState(env, now, inspectProcess, (state) => {
        state.active = state.active.filter((entry) => entry.id !== id);
        state.queued = state.queued.filter((entry) => entry.id !== id);
        promoteEligible(state, maxActive, now());
    });
}
async function createGuard(kind, now, inspectProcess, details) {
    const owner = await inspectProcess(process.pid);
    return {
        id: node_crypto_1.default.randomUUID(),
        pid: process.pid,
        processCreationTime: owner?.creationTime,
        processCheckedAt: now(),
        createdAt: now(),
        kind,
        ...details
    };
}
function guardLease(env, id, now, inspectProcess, maxActive) {
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
async function updateState(env, now, inspectProcess, update) {
    return withStateLock(env, now, async () => {
        const state = await readState(env);
        await removeDeadEntries(state, now(), inspectProcess);
        const result = await update(state);
        await writeState(env, state);
        return result;
    });
}
async function removeDeadEntries(state, currentTime, inspectProcess) {
    const entries = [...state.active, ...state.queued, ...state.guards];
    // Windows process inspection starts PowerShell/WMI for non-current PIDs.
    // Inspect stale entries concurrently so one dead queued worker cannot make
    // cleanup exceed the queue poll deadline while unrelated active workers are
    // checked serially.
    const inspected = await Promise.all(entries.map(async (entry) => {
        if (currentTime - entry.processCheckedAt < PROCESS_RECHECK_MS) {
            return { entry, processInfo: true };
        }
        return { entry, processInfo: await inspectProcess(entry.pid) };
    }));
    const alive = [];
    for (const { entry, processInfo } of inspected) {
        if (processInfo === true) {
            alive.push(entry);
            continue;
        }
        if (!processInfo) {
            // A process-table query can fail transiently (notably while Windows
            // PowerShell/WMI is starting). Do not treat missing metadata as proof
            // that a worker is dead: retaining a live entry is fail-closed for
            // admission and avoids dispatching a duplicate execution. A later
            // refresh can still remove it once the PID is no longer alive.
            if ((0, session_1.isProcessAlive)(entry.pid)) {
                entry.processCheckedAt = currentTime;
                alive.push(entry);
            }
            continue;
        }
        if (entry.processCreationTime &&
            processInfo.creationTime &&
            entry.processCreationTime !== processInfo.creationTime) {
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
async function readState(env) {
    try {
        const parsed = JSON.parse(await node_fs_1.default.promises.readFile(getExecutionStatePath(env), "utf8"));
        if (parsed.version === EXECUTION_STATE_VERSION && Array.isArray(parsed.active) && Array.isArray(parsed.queued)) {
            return {
                version: 1,
                active: parsed.active,
                queued: parsed.queued,
                guards: Array.isArray(parsed.guards) ? parsed.guards : []
            };
        }
    }
    catch {
        // Missing or invalid state starts empty.
    }
    return { version: 1, active: [], queued: [], guards: [] };
}
async function writeState(env, state) {
    const statePath = getExecutionStatePath(env);
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await node_fs_1.default.promises.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        await node_fs_1.default.promises.rename(temporaryPath, statePath);
    }
    finally {
        await node_fs_1.default.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}
async function withStateLock(env, now, fn) {
    const lockPath = getExecutionStateLockPath(env);
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(lockPath), { recursive: true });
    const deadline = now() + STATE_LOCK_TIMEOUT_MS;
    let handle;
    while (!handle) {
        try {
            handle = await node_fs_1.default.promises.open(lockPath, "wx");
            await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
        }
        catch (error) {
            if (!isFileExistsError(error)) {
                throw error;
            }
            try {
                const stat = await node_fs_1.default.promises.stat(lockPath);
                if (now() - stat.mtimeMs > STALE_STATE_LOCK_MS) {
                    await node_fs_1.default.promises.rm(lockPath, { force: true });
                    continue;
                }
            }
            catch {
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
    }
    finally {
        await handle.close().catch(() => undefined);
        await node_fs_1.default.promises.rm(lockPath, { force: true }).catch(() => undefined);
    }
}
function isFileExistsError(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
