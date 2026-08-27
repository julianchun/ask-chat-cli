"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeadlineExceededError = exports.SESSION_STATE_VERSION = void 0;
exports.resolveDeadlineAt = resolveDeadlineAt;
exports.remainingDeadlineMs = remainingDeadlineMs;
exports.throwIfDeadlineExceeded = throwIfDeadlineExceeded;
exports.raceWithDeadline = raceWithDeadline;
exports.delayWithinDeadline = delayWithinDeadline;
exports.getSessionStatePath = getSessionStatePath;
exports.getProfileMarkerPath = getProfileMarkerPath;
exports.getSessionLockPath = getSessionLockPath;
exports.retainSessionLockUntil = retainSessionLockUntil;
exports.withSessionLock = withSessionLock;
exports.normalizePathForCompare = normalizePathForCompare;
exports.writeProfileMarker = writeProfileMarker;
exports.hasProfileMarker = hasProfileMarker;
exports.readSessionState = readSessionState;
exports.writeSessionState = writeSessionState;
exports.isProcessAlive = isProcessAlive;
exports.getProcessInfo = getProcessInfo;
exports.getPortOwnerProcessInfo = getPortOwnerProcessInfo;
exports.parseWindowsNetstatPortOwnerPid = parseWindowsNetstatPortOwnerPid;
exports.getChromeBrowserProcessesUsingProfile = getChromeBrowserProcessesUsingProfile;
exports.classifySession = classifySession;
exports.processMatchesAskSession = processMatchesAskSession;
exports.processUsesChromeProfile = processUsesChromeProfile;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_async_hooks_1 = require("node:async_hooks");
const node_util_1 = require("node:util");
const config_1 = require("./config");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const WINDOWS_PROCESS_INFO_TIMEOUT_MS = 1_500;
exports.SESSION_STATE_VERSION = 1;
class DeadlineExceededError extends Error {
    code = "DEADLINE_EXCEEDED";
    constructor(message) {
        super(message);
        this.name = "DeadlineExceededError";
    }
}
exports.DeadlineExceededError = DeadlineExceededError;
function resolveDeadlineAt(options = {}, defaultTimeoutMs) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
        throw new Error("timeoutMs must be a finite non-negative number.");
    }
    if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) {
        throw new Error("deadlineAt must be a finite timestamp.");
    }
    if (defaultTimeoutMs !== undefined && (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs < 0)) {
        throw new Error("The default timeout must be a finite non-negative number.");
    }
    const candidates = [];
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
function remainingDeadlineMs(deadlineAt) {
    return deadlineAt === undefined ? undefined : Math.max(0, Math.ceil(deadlineAt - Date.now()));
}
function throwIfDeadlineExceeded(deadlineAt, message) {
    if (deadlineAt !== undefined && remainingDeadlineMs(deadlineAt) === 0) {
        throw new DeadlineExceededError(message);
    }
}
async function raceWithDeadline(operation, deadlineAt, message, onLateResolve) {
    if (deadlineAt === undefined) {
        return operation;
    }
    const remainingMs = remainingDeadlineMs(deadlineAt);
    if (remainingMs === 0) {
        void Promise.resolve(operation).then((value) => Promise.resolve(onLateResolve?.(value)).catch(() => undefined), () => undefined);
        throw new DeadlineExceededError(message);
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            reject(new DeadlineExceededError(message));
        }, remainingMs);
        void Promise.resolve(operation).then((value) => {
            if (settled) {
                void Promise.resolve(onLateResolve?.(value)).catch(() => undefined);
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}
async function delayWithinDeadline(timeoutMs, deadlineAt, message) {
    await raceWithDeadline(delay(timeoutMs), deadlineAt, message);
}
function getSessionStatePath(env = process.env) {
    return (0, config_1.joinConfiguredPath)((0, config_1.getAskHome)(env), "session.json");
}
function getProfileMarkerPath(env = process.env) {
    return (0, config_1.joinConfiguredPath)((0, config_1.getChromeProfileDir)(env), ".ask-profile.json");
}
function getSessionLockPath(env = process.env) {
    return (0, config_1.joinConfiguredPath)((0, config_1.getAskHome)(env), "chrome-manager.lock");
}
const SESSION_LOCK_WAIT_MS = 35_000;
const SESSION_LOCK_MALFORMED_GRACE_MS = 250;
const SESSION_LOCK_TIMEOUT_MESSAGE = "Timed out waiting for another ask Chrome session operation to finish.";
const sessionLockContext = new node_async_hooks_1.AsyncLocalStorage();
let currentProcessCreationTimeLookup;
/**
 * Keep the currently held lifecycle lock published until an already-started,
 * non-cancellable canonical filesystem mutation has settled. Callers still
 * receive their deadline error promptly, but a newer lifecycle owner cannot
 * enter while the late mutation could affect its files.
 */
function getSessionLockTargetIdentity(env) {
    return normalizePathForCompare(getSessionLockPath(env));
}
function getActiveSessionLockForTarget(env) {
    const context = sessionLockContext.getStore();
    if (!context || context.phase !== "active") {
        return undefined;
    }
    const targetIdentity = getSessionLockTargetIdentity(env);
    if (context.targetIdentity !== targetIdentity) {
        throw new Error("A nested Chrome lifecycle mutation cannot target a different ASK_HOME while another lifecycle lock is active.");
    }
    return context;
}
function retainSessionLockUntil(operation, env) {
    const context = sessionLockContext.getStore();
    if (!context || context.phase === "sealed") {
        return false;
    }
    if (context.targetIdentity !== getSessionLockTargetIdentity(env)) {
        throw new Error("Late Chrome lifecycle work cannot be retained by a lock for a different ASK_HOME.");
    }
    return retainSessionLockContextUntil(context, operation);
}
function retainSessionLockContextUntil(context, operation) {
    if (context.phase === "sealed") {
        return false;
    }
    let tracked;
    tracked = Promise.resolve(operation)
        .then(() => undefined, () => undefined)
        .finally(() => context.deferredCriticalWork.delete(tracked));
    context.deferredCriticalWork.add(tracked);
    return true;
}
async function waitForDeferredSessionLockWork(context) {
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
async function withSessionLock(env, fn, options = {}, dependencies = {}) {
    const targetIdentity = getSessionLockTargetIdentity(env);
    const inheritedContext = sessionLockContext.getStore();
    if (inheritedContext?.phase === "active") {
        if (inheritedContext.targetIdentity !== targetIdentity) {
            throw new Error("The ask Chrome lifecycle lock cannot acquire a different ASK_HOME from a nested operation.");
        }
        throw new Error("The ask Chrome lifecycle lock is not reentrant.");
    }
    const operationDeadlineAt = resolveDeadlineAt(options);
    const acquisitionDeadlineAt = operationDeadlineAt ?? Date.now() + SESSION_LOCK_WAIT_MS;
    await raceWithDeadline(node_fs_1.default.promises.mkdir((0, config_1.getAskHome)(env), { recursive: true }), acquisitionDeadlineAt, "Timed out creating the ask session directory.");
    const lockPath = getSessionLockPath(env);
    const token = (0, node_crypto_1.randomUUID)();
    const processCreationTime = await raceWithDeadline(getCurrentProcessCreationTime(), acquisitionDeadlineAt, "Timed out while preparing the ask Chrome lifecycle lock.");
    const record = {
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
        processCreationTime
    };
    const ownedText = `${JSON.stringify(record)}\n`;
    const ownerPath = `${lockPath}.owner.${process.pid}.${token}`;
    const reclaimPath = `${lockPath}.reclaim`;
    const context = {
        token,
        targetIdentity,
        phase: "closing",
        deferredCriticalWork: new Set()
    };
    let ownerHandle;
    let acquired = false;
    let deferredOwnerUnlink = false;
    let bodyFailed = false;
    try {
        const openOperation = node_fs_1.default.promises.open(ownerPath, "wx", 0o600);
        ownerHandle = await raceWithDeadline(openOperation, acquisitionDeadlineAt, "Timed out opening the ask Chrome lifecycle owner record.", async (lateHandle) => {
            await lateHandle.close().catch(() => undefined);
            await node_fs_1.default.promises.unlink(ownerPath).catch(() => undefined);
        });
        const writeOperation = ownerHandle.writeFile(ownedText, "utf8");
        try {
            await raceWithDeadline(writeOperation, acquisitionDeadlineAt, "Timed out writing the ask Chrome lifecycle owner record.");
        }
        catch (error) {
            if (error instanceof DeadlineExceededError) {
                deferredOwnerUnlink = true;
                attachLatePreparedFileCleanup(writeOperation, ownerHandle, [ownerPath]);
                ownerHandle = undefined;
            }
            throw error;
        }
        const syncOperation = ownerHandle.sync();
        try {
            await raceWithDeadline(syncOperation, acquisitionDeadlineAt, "Timed out syncing the ask Chrome lifecycle owner record.");
        }
        catch (error) {
            if (error instanceof DeadlineExceededError) {
                deferredOwnerUnlink = true;
                attachLatePreparedFileCleanup(syncOperation, ownerHandle, [ownerPath]);
                ownerHandle = undefined;
            }
            throw error;
        }
        while (!acquired) {
            throwIfDeadlineExceeded(acquisitionDeadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
            const publication = node_fs_1.default.promises.link(ownerPath, lockPath);
            try {
                // The complete owner record is published atomically. A crashed writer
                // can no longer leave a partially written canonical lock.
                await raceWithDeadline(publication, acquisitionDeadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
                acquired = true;
                break;
            }
            catch (error) {
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
            await delayWithinDeadline(50, acquisitionDeadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
        }
        context.phase = "active";
        try {
            try {
                return await sessionLockContext.run(context, fn);
            }
            catch (error) {
                bodyFailed = true;
                throw error;
            }
        }
        finally {
            // Closing is a synchronous registration barrier: every critical tail
            // registered while active is already in the set, and detached ALS
            // descendants can no longer append work after draining begins.
            context.phase = "closing";
        }
    }
    finally {
        try {
            await finishOwnedLinkCleanup(lockPath, ownerPath, token, ownerHandle, acquired, deferredOwnerUnlink, operationDeadlineAt, context);
        }
        catch (error) {
            // A body deadline is the actionable failure. Cleanup may keep the lease
            // published in the background until its non-cancellable work settles.
            if (!bodyFailed) {
                throw error;
            }
        }
    }
}
function attachLateOwnedLinkCleanup(publication, canonicalPath, ownerPath, token) {
    void publication.then(async () => {
        let ownerMayBeRemoved = false;
        try {
            ownerMayBeRemoved = (await releaseOwnedLock(canonicalPath, ownerPath, token)).ownerMayBeRemoved;
        }
        catch {
            // Preserve the sidecar. A future stale-owner recovery needs its exact
            // inode/token if canonical release could not be verified.
        }
        if (ownerMayBeRemoved) {
            await node_fs_1.default.promises.unlink(ownerPath).catch(() => undefined);
        }
    }, async () => {
        // link() failed, so this sidecar was never published as canonical.
        await node_fs_1.default.promises.unlink(ownerPath).catch(() => undefined);
    });
}
async function finishOwnedLinkCleanup(canonicalPath, ownerPath, token, handle, acquired, ownerUnlinkDeferred, deadlineAt, context) {
    const cleanup = (async () => {
        try {
            if (context) {
                await waitForDeferredSessionLockWork(context);
            }
            let ownerMayBeRemoved = !acquired;
            if (acquired) {
                try {
                    ownerMayBeRemoved = (await releaseOwnedLock(canonicalPath, ownerPath, token)).ownerMayBeRemoved;
                }
                catch {
                    // Keep the owner sidecar recoverable when canonical release failed.
                    ownerMayBeRemoved = false;
                }
            }
            await handle?.close().catch(() => undefined);
            if (!ownerUnlinkDeferred && ownerMayBeRemoved) {
                await node_fs_1.default.promises.unlink(ownerPath).catch(() => undefined);
            }
        }
        finally {
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
    }
    catch (error) {
        void cleanup.catch(() => undefined);
        throw error;
    }
}
async function reclaimStaleLock(lockPath, reclaimPath, owner, deadlineAt, dependencies) {
    const guardOwnerPath = `${reclaimPath}.owner.${process.pid}.${owner.token}`;
    let guardHandle;
    let acquired = false;
    let deferredOwnerUnlink = false;
    let guardCleanupDeferred = false;
    try {
        const openOperation = node_fs_1.default.promises.open(guardOwnerPath, "wx", 0o600);
        guardHandle = await raceWithDeadline(openOperation, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE, async (lateHandle) => {
            await lateHandle.close().catch(() => undefined);
            await node_fs_1.default.promises.unlink(guardOwnerPath).catch(() => undefined);
        });
        const writeOperation = guardHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        try {
            await raceWithDeadline(writeOperation, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
        }
        catch (error) {
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
        }
        catch (error) {
            if (error instanceof DeadlineExceededError) {
                deferredOwnerUnlink = true;
                attachLatePreparedFileCleanup(syncOperation, guardHandle, [guardOwnerPath]);
                guardHandle = undefined;
            }
            throw error;
        }
        const publication = node_fs_1.default.promises.link(guardOwnerPath, reclaimPath);
        try {
            // link() is an atomic no-replace publication. It cannot overwrite either
            // a new file guard or an older ask release's directory guard.
            await raceWithDeadline(publication, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
            acquired = true;
        }
        catch (error) {
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
            const staleUnlink = node_fs_1.default.promises.unlink(lockPath).catch((error) => {
                if (!isMissingFileError(error)) {
                    throw error;
                }
            });
            try {
                await raceWithDeadline(staleUnlink, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
            }
            catch (error) {
                if (error instanceof DeadlineExceededError) {
                    guardCleanupDeferred = true;
                    attachLateGuardMutationCleanup(staleUnlink, reclaimPath, guardOwnerPath, owner.token, guardHandle);
                    guardHandle = undefined;
                }
                throw error;
            }
            return true;
        }
        return false;
    }
    finally {
        if (!guardCleanupDeferred) {
            await finishOwnedLinkCleanup(reclaimPath, guardOwnerPath, owner.token, guardHandle, acquired, deferredOwnerUnlink, deadlineAt);
        }
    }
}
function attachLateGuardMutationCleanup(mutation, canonicalPath, ownerPath, token, handle) {
    void Promise.resolve(mutation)
        .catch(() => undefined)
        .then(async () => {
        let ownerMayBeRemoved = false;
        try {
            ownerMayBeRemoved = (await releaseOwnedLock(canonicalPath, ownerPath, token)).ownerMayBeRemoved;
        }
        catch {
            // Preserve the sidecar if guard release is not verifiable.
        }
        await handle?.close().catch(() => undefined);
        if (ownerMayBeRemoved) {
            await node_fs_1.default.promises.unlink(ownerPath).catch(() => undefined);
        }
    });
}
async function pathExistsWithinDeadline(filePath, deadlineAt) {
    throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    try {
        await raceWithDeadline(node_fs_1.default.promises.stat(filePath), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
        return true;
    }
    catch (error) {
        if (isMissingFileError(error)) {
            return false;
        }
        throw error;
    }
}
async function reclaimAbandonedReclaimGuard(reclaimPath, deadlineAt, dependencies) {
    let guardStat;
    try {
        throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
        guardStat = await raceWithDeadline(node_fs_1.default.promises.lstat(reclaimPath), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    }
    catch (error) {
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
async function reclaimAbandonedFileGuard(reclaimPath, observed, deadlineAt, dependencies) {
    const ownerPath = `${reclaimPath}.owner.${observed.pid}.${observed.token}`;
    const ownerName = node_path_1.default.basename(ownerPath);
    const reaperPrefix = `${ownerName}.reaping.`;
    throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    const names = await raceWithDeadline(node_fs_1.default.promises.readdir(node_path_1.default.dirname(reclaimPath)), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    const candidates = names
        .filter((name) => name === ownerName || name.startsWith(reaperPrefix))
        .map((name) => node_path_1.default.join(node_path_1.default.dirname(reclaimPath), name));
    const matchingCandidates = [];
    for (const candidatePath of candidates) {
        try {
            const candidateStat = await raceWithDeadline(node_fs_1.default.promises.stat(candidatePath), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
            if (candidateStat.dev !== observed.dev || candidateStat.ino !== observed.ino) {
                continue;
            }
            const candidateName = node_path_1.default.basename(candidatePath);
            const reaperOwner = candidateName.startsWith(reaperPrefix)
                ? parseReaperClaimOwner(candidateName.slice(reaperPrefix.length))
                : undefined;
            matchingCandidates.push({
                filePath: candidatePath,
                reaperPid: reaperOwner?.pid,
                reaperProcessCreationTime: reaperOwner?.processCreationTime
            });
        }
        catch (error) {
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
    const reaperProcessCreationTime = await raceWithDeadline(getCurrentProcessCreationTime(), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    const encodedCreationTime = reaperProcessCreationTime
        ? Buffer.from(reaperProcessCreationTime, "utf8").toString("base64url")
        : "_";
    const reaperClaimPath = `${ownerPath}.reaping.${process.pid}.${encodedCreationTime}.${(0, node_crypto_1.randomUUID)()}`;
    const publication = node_fs_1.default.promises.rename(sourcePath, reaperClaimPath);
    try {
        await raceWithDeadline(publication, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    }
    catch (error) {
        if (error instanceof DeadlineExceededError) {
            attachLateReaperClaimCleanup(publication, reclaimPath, reaperClaimPath, observed.token);
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
    const releaseOperation = releaseOwnedLock(reclaimPath, reaperClaimPath, observed.token);
    let release;
    try {
        release = await raceWithDeadline(releaseOperation, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    }
    catch (error) {
        if (error instanceof DeadlineExceededError) {
            attachLateOwnedReleaseCleanup(releaseOperation, reaperClaimPath);
        }
        throw error;
    }
    if (release.ownerMayBeRemoved) {
        const sidecarCleanup = node_fs_1.default.promises.unlink(reaperClaimPath).catch((error) => {
            if (!isMissingFileError(error)) {
                throw error;
            }
        });
        try {
            await raceWithDeadline(sidecarCleanup, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
        }
        catch (error) {
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
function parseReaperClaimOwner(suffix) {
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
    }
    catch {
        return { pid };
    }
}
async function isReaperClaimOwnerAlive(candidate, deadlineAt, dependencies) {
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
    const actualCreationTime = await raceWithDeadline(creationTime, deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    return actualCreationTime === undefined || actualCreationTime === candidate.reaperProcessCreationTime;
}
function attachLateReaperClaimCleanup(publication, reclaimPath, reaperClaimPath, token) {
    void publication.then(async () => {
        attachLateOwnedReleaseCleanup(releaseOwnedLock(reclaimPath, reaperClaimPath, token), reaperClaimPath);
    }, () => undefined);
}
function attachLateOwnedReleaseCleanup(release, ownerPath) {
    void release.then(async (result) => {
        if (result.ownerMayBeRemoved) {
            await node_fs_1.default.promises.unlink(ownerPath).catch(() => undefined);
        }
    }, () => {
        // Preserve the owner/reaper sidecar when release was not verifiable.
    });
}
async function reclaimLegacyReclaimGuardDirectory(reclaimPath, deadlineAt, dependencies, initialStat) {
    let directoryStat;
    let markerNames;
    try {
        throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
        [directoryStat, markerNames] = await raceWithDeadline(Promise.all([Promise.resolve(initialStat), node_fs_1.default.promises.readdir(reclaimPath)]), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    }
    catch (error) {
        if (error instanceof DeadlineExceededError) {
            throw error;
        }
        return isMissingFileError(error);
    }
    if (markerNames.length === 0) {
        if (Date.now() - directoryStat.mtimeMs < SESSION_LOCK_MALFORMED_GRACE_MS) {
            return false;
        }
        try {
            await raceWithDeadline(node_fs_1.default.promises.rmdir(reclaimPath), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
            return true;
        }
        catch (error) {
            if (error instanceof DeadlineExceededError) {
                throw error;
            }
            // A replacement guard publishes a marker before entering its critical
            // section, making rmdir fail safely if it won the race.
            return false;
        }
    }
    const observedMarkers = await raceWithDeadline(Promise.all(markerNames.map(async (markerName) => {
        const markerPath = node_path_1.default.join(reclaimPath, markerName);
        try {
            const [text, stat] = await Promise.all([
                node_fs_1.default.promises.readFile(markerPath, "utf8"),
                node_fs_1.default.promises.stat(markerPath)
            ]);
            return {
                markerPath,
                observed: { text, ...parseLockOwner(text), mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino }
            };
        }
        catch {
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
        if (marker.observed.pid !== undefined &&
            await isLockOwnerAlive(marker.observed, deadlineAt, dependencies)) {
            return false;
        }
        if (marker.observed.pid === undefined &&
            Date.now() - marker.observed.mtimeMs < SESSION_LOCK_MALFORMED_GRACE_MS) {
            return false;
        }
    }
    // Marker filenames contain their owners' random tokens. Removing only those
    // exact paths cannot delete a marker from a replacement guard generation.
    await raceWithDeadline(Promise.all(observedMarkers.map(async (marker) => {
        await node_fs_1.default.promises.unlink(marker.markerPath).catch(() => undefined);
    })), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
    try {
        await raceWithDeadline(node_fs_1.default.promises.rmdir(reclaimPath), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
        return true;
    }
    catch (error) {
        if (error instanceof DeadlineExceededError) {
            throw error;
        }
        return false;
    }
}
function isMissingFileError(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function isFileExistsError(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
async function inspectLock(lockPath, deadlineAt) {
    try {
        throwIfDeadlineExceeded(deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
        const [text, stat] = await raceWithDeadline(Promise.all([
            node_fs_1.default.promises.readFile(lockPath, "utf8"),
            node_fs_1.default.promises.stat(lockPath)
        ]), deadlineAt, SESSION_LOCK_TIMEOUT_MESSAGE);
        return { text, ...parseLockOwner(text), mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
    }
    catch (error) {
        if (isMissingFileError(error)) {
            return undefined;
        }
        throw error;
    }
}
function parseLockOwner(text) {
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "pid" in parsed) {
            const record = parsed;
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
    }
    catch {
        // Read the pre-token lock format so a live older ask process is respected.
        const legacyPid = Number(text.split(/\r?\n/, 1)[0]);
        return { pid: Number.isInteger(legacyPid) && legacyPid > 0 ? legacyPid : undefined };
    }
    return {};
}
async function isLockOwnerAlive(observed, deadlineAt, dependencies = {}) {
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
function getCurrentProcessCreationTime() {
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
async function releaseOwnedLock(lockPath, ownerPath, token) {
    let lockHandle;
    try {
        lockHandle = await node_fs_1.default.promises.open(lockPath, "r");
    }
    catch (error) {
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
        let ownerStat;
        try {
            ownerStat = await node_fs_1.default.promises.stat(ownerPath);
        }
        catch (error) {
            if (isMissingFileError(error)) {
                return { released: false, ownerMayBeRemoved: false };
            }
            throw error;
        }
        const samePublishedFile = lockStat.dev === ownerStat.dev && lockStat.ino === ownerStat.ino;
        if (!samePublishedFile) {
            return { released: false, ownerMayBeRemoved: true };
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (error) {
            if (error instanceof SyntaxError) {
                return { released: false, ownerMayBeRemoved: false };
            }
            throw error;
        }
        if (parsed.token !== token) {
            return { released: false, ownerMayBeRemoved: false };
        }
        try {
            await node_fs_1.default.promises.unlink(lockPath);
            return { released: true, ownerMayBeRemoved: true };
        }
        catch (error) {
            if (isMissingFileError(error)) {
                return { released: false, ownerMayBeRemoved: true };
            }
            throw error;
        }
    }
    finally {
        await lockHandle.close().catch(() => undefined);
    }
}
function normalizePathForCompare(value) {
    if (isWindowsStylePath(value)) {
        return node_path_1.default.win32.resolve(value).replace(/\//g, "\\").toLowerCase();
    }
    return node_path_1.default.posix.resolve(value);
}
function isWindowsStylePath(value) {
    return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.includes("\\");
}
function writeProfileMarker(env = process.env, options = {}) {
    const deadlineAt = resolveDeadlineAt(options);
    const context = getActiveSessionLockForTarget(env);
    if (!context) {
        return withSessionLock(env, () => writeProfileMarkerLocked(env, deadlineAt), { deadlineAt });
    }
    const operation = writeProfileMarkerLocked(env, deadlineAt);
    retainSessionLockContextUntil(context, operation);
    return operation;
}
async function writeProfileMarkerLocked(env, deadlineAt) {
    const markerPath = getProfileMarkerPath(env);
    const marker = {
        manager: "ask",
        version: exports.SESSION_STATE_VERSION,
        profileDir: (0, config_1.getChromeProfileDir)(env)
    };
    await writeFileAtomically(markerPath, `${JSON.stringify(marker, null, 2)}\n`, deadlineAt, "Timed out writing the ask Chrome profile marker.");
}
async function hasProfileMarker(env = process.env, options = {}) {
    const deadlineAt = resolveDeadlineAt(options);
    const timeoutMessage = "Timed out reading the ask Chrome profile marker.";
    try {
        throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
        const text = await raceWithDeadline(node_fs_1.default.promises.readFile(getProfileMarkerPath(env), "utf8"), deadlineAt, timeoutMessage);
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") {
            return false;
        }
        const marker = parsed;
        return (marker.manager === "ask" &&
            marker.version === exports.SESSION_STATE_VERSION &&
            typeof marker.profileDir === "string" &&
            normalizePathForCompare(marker.profileDir) === normalizePathForCompare((0, config_1.getChromeProfileDir)(env)));
    }
    catch (error) {
        if (error instanceof DeadlineExceededError) {
            throw error;
        }
        return false;
    }
}
async function readSessionState(env = process.env, options = {}) {
    const deadlineAt = resolveDeadlineAt(options);
    const timeoutMessage = "Timed out reading ask Chrome session state.";
    try {
        throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
        const text = await raceWithDeadline(node_fs_1.default.promises.readFile(getSessionStatePath(env), "utf8"), deadlineAt, timeoutMessage);
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") {
            return undefined;
        }
        const state = parsed;
        if (state.version !== exports.SESSION_STATE_VERSION ||
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
            !hasValidPersistedPortMetadata(state.port, state.portPolicy, state.requestedPort)) {
            return undefined;
        }
        return state;
    }
    catch (error) {
        if (error instanceof DeadlineExceededError) {
            throw error;
        }
        return undefined;
    }
}
function writeSessionState(env, input, options = {}) {
    const deadlineAt = resolveDeadlineAt(options);
    const context = getActiveSessionLockForTarget(env);
    if (!context) {
        return withSessionLock(env, () => writeSessionStateLocked(env, input, deadlineAt), { deadlineAt });
    }
    const operation = writeSessionStateLocked(env, input, deadlineAt);
    retainSessionLockContextUntil(context, operation);
    return operation;
}
async function writeSessionStateLocked(env, input, deadlineAt) {
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
    const state = {
        version: exports.SESSION_STATE_VERSION,
        pid: input.pid,
        port: input.port,
        profileDir: (0, config_1.getChromeProfileDir)(env),
        chromePath: input.chromePath,
        headless: input.headless,
        launchedAt: new Date().toISOString(),
        processCreationTime: input.processCreationTime,
        hostname: node_os_1.default.hostname(),
        username: node_os_1.default.userInfo().username,
        nonce: (0, node_crypto_1.randomUUID)(),
        generation: input.generation,
        portPolicy: input.portPolicy,
        requestedPort: input.requestedPort
    };
    await writeFileAtomically(getSessionStatePath(env), `${JSON.stringify(state, null, 2)}\n`, deadlineAt, "Timed out persisting ask Chrome session state.");
    return state;
}
async function writeFileAtomically(filePath, contents, deadlineAt, timeoutMessage) {
    throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
    await raceWithDeadline(node_fs_1.default.promises.mkdir(node_path_1.default.dirname(filePath), { recursive: true }), deadlineAt, timeoutMessage);
    const tempPath = `${filePath}.${process.pid}.${(0, node_crypto_1.randomUUID)()}.tmp`;
    const verificationPath = `${tempPath}.owner`;
    let handle;
    let deferredCleanup = false;
    let cleanupRequired = true;
    try {
        const openOperation = node_fs_1.default.promises.open(tempPath, "wx", 0o600);
        handle = await raceWithDeadline(openOperation, deadlineAt, timeoutMessage, async (lateHandle) => {
            await lateHandle.close().catch(() => undefined);
            await node_fs_1.default.promises.unlink(tempPath).catch(() => undefined);
        });
        const writeOperation = handle.writeFile(contents, "utf8");
        try {
            await raceWithDeadline(writeOperation, deadlineAt, timeoutMessage);
        }
        catch (error) {
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
        }
        catch (error) {
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
        }
        catch (error) {
            if (error instanceof DeadlineExceededError) {
                deferredCleanup = true;
                attachLatePreparedFileCleanup(closeOperation, undefined, [tempPath, verificationPath]);
            }
            throw error;
        }
        handle = undefined;
        const verificationPublication = node_fs_1.default.promises.link(tempPath, verificationPath);
        try {
            await raceWithDeadline(verificationPublication, deadlineAt, timeoutMessage);
        }
        catch (error) {
            if (error instanceof DeadlineExceededError) {
                deferredCleanup = true;
                attachLatePreparedFileCleanup(verificationPublication, undefined, [tempPath, verificationPath]);
            }
            throw error;
        }
        const publication = node_fs_1.default.promises.rename(tempPath, filePath);
        try {
            await raceWithDeadline(publication, deadlineAt, timeoutMessage);
        }
        catch (error) {
            if (error instanceof DeadlineExceededError) {
                deferredCleanup = true;
                const lateCleanup = finishLateAtomicWriteCleanup(publication, filePath, tempPath, verificationPath);
                const context = sessionLockContext.getStore();
                if (!context || !retainSessionLockContextUntil(context, lateCleanup)) {
                    // Exported writers normally acquire the lifecycle lock above. Keep
                    // this fallback safe for an unexpected internal call context.
                    await lateCleanup;
                }
            }
            throw error;
        }
        const verificationCleanup = node_fs_1.default.promises.unlink(verificationPath).catch((error) => {
            if (!isMissingFileError(error)) {
                throw error;
            }
        });
        try {
            await finishFileCleanupWithinDeadline(verificationCleanup, deadlineAt, timeoutMessage);
            cleanupRequired = false;
        }
        catch (error) {
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
    }
    finally {
        if (cleanupRequired && !deferredCleanup) {
            const cleanup = (async () => {
                await handle?.close().catch(() => undefined);
                await Promise.all([tempPath, verificationPath].map(async (candidatePath) => {
                    await node_fs_1.default.promises.unlink(candidatePath).catch((error) => {
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
async function finishFileCleanupWithinDeadline(cleanup, deadlineAt, timeoutMessage) {
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
    }
    catch (error) {
        void cleanupPromise.catch(() => undefined);
        throw error;
    }
}
function attachLatePreparedFileCleanup(operation, handle, paths) {
    void Promise.resolve(operation)
        .catch(() => undefined)
        .then(() => handle?.close().catch(() => undefined))
        .then(() => Promise.all(paths.map((candidatePath) => node_fs_1.default.promises.unlink(candidatePath).catch(() => undefined))))
        .catch(() => undefined);
}
async function finishLateAtomicWriteCleanup(publication, filePath, tempPath, verificationPath) {
    let published = false;
    try {
        await publication;
        published = true;
    }
    catch {
        // A failed rename cannot have replaced canonical.
    }
    if (published) {
        // The lifecycle lease remains published until this tail settles, so no
        // newer ask generation can replace canonical between publication and this
        // unlink. Avoid a stat-then-unlink TOCTOU on the replaceable state path.
        await node_fs_1.default.promises.unlink(filePath).catch((error) => {
            if (!isMissingFileError(error)) {
                throw error;
            }
        });
    }
    await Promise.all([tempPath, verificationPath].map(async (candidatePath) => {
        try {
            await node_fs_1.default.promises.unlink(candidatePath);
        }
        catch (error) {
            if (!isMissingFileError(error)) {
                throw error;
            }
        }
    }));
}
function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
    }
}
async function getProcessInfo(pid) {
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
            name: node_path_1.default.basename(process.execPath),
            creationTime: await getCurrentProcessCreationTime()
        };
    }
    if (process.platform === "win32") {
        return getWindowsProcessInfo(pid);
    }
    if (!isProcessAlive(pid)) {
        return undefined;
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
        name: executablePath ? node_path_1.default.basename(executablePath) : undefined
    };
}
async function getProcessCreationTime(pid) {
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
async function getLinuxProcessInfo(pid) {
    try {
        const [rawCommandLine, executablePath, creationTime] = await Promise.all([
            node_fs_1.default.promises.readFile(`/proc/${pid}/cmdline`, "utf8"),
            node_fs_1.default.promises.readlink(`/proc/${pid}/exe`).catch(() => undefined),
            getLinuxProcessCreationTime(pid)
        ]);
        const args = rawCommandLine.split("\0").filter(Boolean);
        return {
            pid,
            args,
            commandLine: args.map(formatCommandLineArgument).join(" ") || undefined,
            executablePath,
            creationTime,
            name: executablePath ? node_path_1.default.basename(executablePath) : undefined
        };
    }
    catch {
        return undefined;
    }
}
async function getLinuxProcessCreationTime(pid) {
    try {
        const stat = await node_fs_1.default.promises.readFile(`/proc/${pid}/stat`, "utf8");
        const commandEnd = stat.lastIndexOf(")");
        if (commandEnd < 0) {
            return undefined;
        }
        const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
        const startTicks = fieldsAfterCommand[19];
        return startTicks ? `linux-start-ticks:${startTicks}` : undefined;
    }
    catch {
        return undefined;
    }
}
function formatCommandLineArgument(argument) {
    return /\s/.test(argument) ? JSON.stringify(argument) : argument;
}
async function getPosixProcessField(pid, field) {
    try {
        const { stdout } = await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", field]);
        return stdout.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
async function getPortOwnerProcessInfo(port) {
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
        }
        catch {
            return undefined;
        }
    }
    try {
        const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
        const pid = Number(stdout.trim().split(/\s+/, 1)[0]);
        return Number.isInteger(pid) && pid > 0 ? getProcessInfo(pid) : undefined;
    }
    catch {
        return process.platform === "linux" ? getLinuxPortOwnerProcessInfo(port) : undefined;
    }
}
/** Parse native Windows netstat output without depending on localized state labels. */
function parseWindowsNetstatPortOwnerPid(output, port) {
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
        if (localPort === port &&
            (remotePort === 0 || state === "LISTENING") &&
            Number.isInteger(pid) &&
            pid > 0) {
            return pid;
        }
    }
    return undefined;
}
function parseEndpointPort(endpoint) {
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
async function getChromeBrowserProcessesUsingProfile(profileDir, options = {}) {
    const deadlineAt = resolveDeadlineAt(options);
    const timeoutMessage = "Timed out while inspecting Chrome processes using the ask profile.";
    throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
    return raceWithDeadline(listChromeBrowserProcessesUsingProfile(profileDir, deadlineAt), deadlineAt, timeoutMessage);
}
async function listChromeBrowserProcessesUsingProfile(profileDir, deadlineAt) {
    if (process.platform === "win32") {
        return getWindowsChromeBrowserProcessesUsingProfile(profileDir, deadlineAt);
    }
    if (process.platform === "linux") {
        return getLinuxChromeBrowserProcessesUsingProfile(profileDir, deadlineAt);
    }
    return getPosixChromeBrowserProcessesUsingProfile(profileDir, deadlineAt);
}
async function getLinuxChromeBrowserProcessesUsingProfile(profileDir, deadlineAt) {
    let entries;
    try {
        entries = await node_fs_1.default.promises.readdir("/proc", { withFileTypes: true });
    }
    catch {
        return undefined;
    }
    const matches = [];
    for (const entry of entries) {
        throwIfDeadlineExceeded(deadlineAt, "Timed out while inspecting Chrome processes using the ask profile.");
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
            continue;
        }
        const pid = Number(entry.name);
        let rawCommandLine;
        try {
            rawCommandLine = await node_fs_1.default.promises.readFile(`/proc/${pid}/cmdline`, "utf8");
        }
        catch {
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
async function getPosixChromeBrowserProcessesUsingProfile(profileDir, deadlineAt) {
    let stdout;
    try {
        ({ stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,command="]));
    }
    catch {
        return undefined;
    }
    const candidatePids = stdout
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
        .filter((match) => Boolean(match))
        .filter((match) => commandLineContainsProfile(match[2], profileDir) && !commandLineContainsChromeChildSwitch(match[2]))
        .map((match) => Number(match[1]));
    const matches = [];
    for (const pid of candidatePids) {
        throwIfDeadlineExceeded(deadlineAt, "Timed out while inspecting Chrome processes using the ask profile.");
        const info = await getProcessInfo(pid);
        if (info && processUsesChromeProfile(info, profileDir) && !processIsChromeChild(info)) {
            matches.push(info);
        }
    }
    return matches;
}
async function getWindowsChromeBrowserProcessesUsingProfile(profileDir, deadlineAt) {
    try {
        throwIfDeadlineExceeded(deadlineAt, "Timed out while inspecting Chrome processes using the ask profile.");
        const { stdout } = await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,CreationDate,ExecutablePath | ConvertTo-Json -Compress"
        ]);
        const parsed = JSON.parse(stdout);
        const values = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        const matches = [];
        for (const value of values) {
            throwIfDeadlineExceeded(deadlineAt, "Timed out while inspecting Chrome processes using the ask profile.");
            if (!value || typeof value !== "object") {
                continue;
            }
            const record = value;
            const pid = Number(record.ProcessId);
            const info = {
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
    }
    catch {
        return undefined;
    }
}
async function getLinuxPortOwnerProcessInfo(port) {
    const socketInodes = new Set();
    for (const tablePath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        try {
            const table = await node_fs_1.default.promises.readFile(tablePath, "utf8");
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
        }
        catch {
            // The IPv4 or IPv6 table may be unavailable in a restricted container.
        }
    }
    if (socketInodes.size === 0) {
        return undefined;
    }
    let entries;
    try {
        entries = await node_fs_1.default.promises.readdir("/proc", { withFileTypes: true });
    }
    catch {
        return undefined;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
            continue;
        }
        const pid = Number(entry.name);
        let descriptors;
        try {
            descriptors = await node_fs_1.default.promises.readdir(`/proc/${pid}/fd`);
        }
        catch {
            continue;
        }
        for (const descriptor of descriptors) {
            try {
                const target = await node_fs_1.default.promises.readlink(`/proc/${pid}/fd/${descriptor}`);
                const match = /^socket:\[(\d+)\]$/.exec(target);
                if (match && socketInodes.has(match[1])) {
                    return getProcessInfo(pid);
                }
            }
            catch {
                // Descriptors can disappear while the process is being inspected.
            }
        }
    }
    return undefined;
}
async function getWindowsProcessInfo(pid, timeoutMs = WINDOWS_PROCESS_INFO_TIMEOUT_MS) {
    try {
        const { stdout } = await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | ConvertTo-Json -Compress`
        ], { timeout: timeoutMs, windowsHide: true });
        const trimmed = String(stdout).trim();
        if (!trimmed) {
            return undefined;
        }
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object") {
            return undefined;
        }
        const value = parsed;
        return {
            pid,
            name: typeof value.Name === "string" ? value.Name : undefined,
            commandLine: typeof value.CommandLine === "string" ? value.CommandLine : undefined,
            creationTime: typeof value.CreationDate === "string" ? value.CreationDate : undefined,
            executablePath: typeof value.ExecutablePath === "string" ? value.ExecutablePath : undefined
        };
    }
    catch {
        return undefined;
    }
}
async function classifySession(env, port, debuggingConnected, dependencies = {}) {
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
        if (processInfo && processUsesChromeProfile(processInfo, (0, config_1.getChromeProfileDir)(env))) {
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
    if (normalizePathForCompare(state.profileDir) !== normalizePathForCompare((0, config_1.getChromeProfileDir)(env))) {
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
    if (state.processCreationTime &&
        processInfo.creationTime &&
        !(await processCreationTimesMatch(state.processCreationTime, processInfo.creationTime, processInfo.pid, dependencies))) {
        return { ownership: "unknown", state, process: processInfo, reason: "Process creation time does not match ask state." };
    }
    return { ownership: "ask-managed", state, process: processInfo };
}
async function inspectPortOwnerWithinDeadline(port, dependencies, timeoutMessage) {
    throwIfDeadlineExceeded(dependencies.deadlineAt, timeoutMessage);
    return raceWithDeadline((dependencies.getPortOwnerProcessInfo || getPortOwnerProcessInfo)(port), dependencies.deadlineAt, timeoutMessage);
}
async function processCreationTimesMatch(expected, current, pid, dependencies) {
    if (expected === current) {
        return true;
    }
    // Linux ownership inspection now uses /proc start ticks, while early v1
    // state used `ps lstart`. Re-read the legacy representation only when the
    // two stored values are from those different domains.
    if (!expected.startsWith("linux-start-ticks:") && current.startsWith("linux-start-ticks:")) {
        const getLegacyCreationTime = dependencies.getLegacyProcessCreationTime ||
            (process.platform === "linux"
                ? (candidatePid) => getPosixProcessField(candidatePid, "lstart=")
                : undefined);
        if (!getLegacyCreationTime) {
            return false;
        }
        const timeoutMessage = `Timed out while verifying process ${pid} creation time.`;
        throwIfDeadlineExceeded(dependencies.deadlineAt, timeoutMessage);
        return await raceWithDeadline(getLegacyCreationTime(pid), dependencies.deadlineAt, timeoutMessage) === expected;
    }
    return false;
}
function processMatchesAskSession(processInfo, port, profileDir, generation) {
    if (!processInfo.commandLine && !processInfo.args) {
        return false;
    }
    const portMatches = processSwitchMatches(processInfo, "remote-debugging-port", String(port), false, (value) => /^\d+$/.test(value) && Number(value) === port);
    const profileMatches = processUsesChromeProfile(processInfo, profileDir);
    const generationMatches = generation === undefined || processSwitchMatches(processInfo, "ask-session-generation", generation, false, (value) => value === generation);
    return portMatches && profileMatches && generationMatches;
}
/**
 * Check only the dedicated user-data-dir claim. This is intentionally exposed
 * separately from processMatchesAskSession so a same-profile process with a
 * malformed, missing, or wrong debugging-generation flag remains unsafe to
 * adopt instead of being mistaken for an unrelated external listener.
 */
function processUsesChromeProfile(processInfo, profileDir) {
    if (!processInfo.commandLine && !processInfo.args) {
        return false;
    }
    return processSwitchMatches(processInfo, "user-data-dir", profileDir, isWindowsStylePath(profileDir), (value) => normalizePathForCompare(value) === normalizePathForCompare(profileDir), (commandLine) => commandLineContainsProfile(commandLine, profileDir));
}
function processIsChromeChild(processInfo) {
    if (processInfo.args) {
        return commandLineSwitchValues(processInfo.args, "type").length > 0;
    }
    return commandLineContainsChromeChildSwitch(processInfo.commandLine || "");
}
function commandLineContainsChromeChildSwitch(commandLine) {
    return /(?:^|\s)(?:["']?--type(?:=|\s+))/i.test(commandLine);
}
function processSwitchMatches(processInfo, name, expectedValue, caseInsensitive, valueMatches = (value) => value === expectedValue, rawFallback) {
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
function commandLineContainsProfile(commandLine, profileDir) {
    const normalized = normalizePathForCompare(profileDir);
    const candidates = isWindowsStylePath(profileDir)
        ? [profileDir, normalized, normalized.replace(/\\/g, "/")]
        : [profileDir, normalized];
    return [...new Set(candidates)].some((candidate) => commandLineContainsSwitchValue(commandLine, "user-data-dir", candidate, isWindowsStylePath(profileDir)));
}
function commandLineContainsSwitchValue(commandLine, name, expectedValue, caseInsensitive) {
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
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function tokenizeCommandLine(commandLine) {
    const args = [];
    let current = "";
    let quote;
    for (let index = 0; index < commandLine.length; index += 1) {
        const character = commandLine[index];
        if (quote) {
            if (character === quote) {
                quote = undefined;
            }
            else if (character === "\\" && commandLine[index + 1] === quote) {
                current += quote;
                index += 1;
            }
            else {
                current += character;
            }
            continue;
        }
        if (character === "\"" || character === "'") {
            quote = character;
        }
        else if (/\s/.test(character)) {
            if (current) {
                args.push(current);
                current = "";
            }
        }
        else {
            current += character;
        }
    }
    if (current) {
        args.push(current);
    }
    return args;
}
function commandLineSwitchValues(args, name) {
    const values = [];
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
function commandLineSwitchValue(args, name) {
    return commandLineSwitchValues(args, name)[0];
}
function isValidAssignedPort(port) {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}
function hasValidPersistedPortMetadata(assignedPort, portPolicy, requestedPort) {
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
function delay(timeoutMs) {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
