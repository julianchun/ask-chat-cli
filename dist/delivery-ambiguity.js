"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeliveryAmbiguityPersistenceError = exports.DELIVERY_AMBIGUITY_MARKER_VERSION = void 0;
exports.getDeliveryAmbiguityDirectory = getDeliveryAmbiguityDirectory;
exports.recordDeliveryAmbiguity = recordDeliveryAmbiguity;
exports.listDeliveryAmbiguityMarkers = listDeliveryAmbiguityMarkers;
exports.reclaimDeliveryAmbiguityMarker = reclaimDeliveryAmbiguityMarker;
exports.reclaimDeliveryAmbiguityMarkerUnderLock = reclaimDeliveryAmbiguityMarkerUnderLock;
exports.writeDeliveryAmbiguityMarker = writeDeliveryAmbiguityMarker;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const config_1 = require("./config");
const session_1 = require("./session");
/** A deliberately tiny, privacy-safe record for an ambiguous send. */
exports.DELIVERY_AMBIGUITY_MARKER_VERSION = 1;
class DeliveryAmbiguityPersistenceError extends Error {
    code = "DELIVERY_AMBIGUITY_PERSISTENCE_FAILED";
    marker;
    constructor(message, options = {}) {
        super(message, { cause: options.cause });
        this.name = "DeliveryAmbiguityPersistenceError";
        this.marker = options.marker;
    }
}
exports.DeliveryAmbiguityPersistenceError = DeliveryAmbiguityPersistenceError;
const MARKER_FILE_PREFIX = "ambiguity-";
const MARKER_FILE_PATTERN = /^ambiguity-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const volatileMarkers = new Map();
function getDeliveryAmbiguityDirectory(env = process.env) {
    return (0, config_1.joinConfiguredPath)((0, config_1.getAskHome)(env), "delivery-ambiguities");
}
/**
 * Capture a target and its verified managed-session generation, then atomically
 * publish a one-record ambiguity marker while the same lifecycle lock used by
 * Browser.close remains held. This closes the race between uncertain dispatch
 * and a concurrent setup/mode restart.
 */
async function recordDeliveryAmbiguity(options) {
    const env = options.env || process.env;
    const deadlineAt = (0, session_1.resolveDeadlineAt)(options);
    const timeoutMessage = "Timed out while safely recording the uncertain prompt delivery.";
    try {
        return await (0, session_1.withSessionLock)(env, async () => {
            (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
            const [targetId, sessionGeneration] = await (0, session_1.raceWithDeadline)(Promise.all([options.resolveTargetId(), options.resolveSessionGeneration()]), deadlineAt, timeoutMessage);
            const marker = createMarker({
                provider: options.provider,
                targetId,
                knownConversationUrl: options.knownConversationUrl,
                sessionGeneration
            });
            const stored = {
                ...marker,
                fileName: `${MARKER_FILE_PREFIX}${(0, node_crypto_1.randomUUID)()}.json`
            };
            // If the disk publication races its deadline or fails, retain a
            // same-process guard so no subsequent Browser.close in this process can
            // silently discard the still-open worker tab.
            volatileMarkers.set(volatileMarkerKey(env, stored.fileName), stored);
            const publication = writeDeliveryAmbiguityMarker(env, stored, { deadlineAt });
            try {
                await publication;
            }
            catch (error) {
                if (error instanceof session_1.DeadlineExceededError && (0, session_1.retainSessionLockUntil)(publication, env)) {
                    // A late rename must settle while the lease remains published; it
                    // either gives the next closer a durable marker or fails without
                    // exposing a close/publish race.
                }
                throw new DeliveryAmbiguityPersistenceError("Ask could not safely persist the uncertain prompt-delivery marker.", { cause: error, marker: stored });
            }
            return stored;
        }, { deadlineAt });
    }
    catch (error) {
        if (error instanceof DeliveryAmbiguityPersistenceError) {
            throw error;
        }
        throw new DeliveryAmbiguityPersistenceError("Ask could not safely persist the uncertain prompt-delivery marker.", { cause: error });
    }
}
/**
 * Read ambiguity records without changing them. `ask status` deliberately
 * never calls this mutating/lifecycle-only API.
 */
async function listDeliveryAmbiguityMarkers(env = process.env, options = {}) {
    const deadlineAt = (0, session_1.resolveDeadlineAt)(options);
    const timeoutMessage = "Timed out reading uncertain prompt-delivery markers.";
    const directory = getDeliveryAmbiguityDirectory(env);
    let entries;
    try {
        entries = await (0, session_1.raceWithDeadline)(node_fs_1.default.promises.readdir(directory, { withFileTypes: true }), deadlineAt, timeoutMessage);
    }
    catch (error) {
        if (isMissingFileError(error)) {
            return mergeVolatileMarkers(env, []);
        }
        throw new DeliveryAmbiguityPersistenceError("Ask could not safely inspect uncertain prompt-delivery markers.", { cause: error });
    }
    const records = [];
    for (const entry of entries) {
        (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
        if (!entry.isFile() || !MARKER_FILE_PATTERN.test(entry.name)) {
            // A partial/unknown file means a close cannot prove that every ambiguity
            // record has been considered. Fail closed rather than skipping it.
            throw new DeliveryAmbiguityPersistenceError("Ask found an incomplete uncertain prompt-delivery marker and will not close Chrome automatically.");
        }
        const markerPath = node_path_1.default.join(directory, entry.name);
        let text;
        try {
            text = await (0, session_1.raceWithDeadline)(node_fs_1.default.promises.readFile(markerPath, "utf8"), deadlineAt, timeoutMessage);
        }
        catch (error) {
            throw new DeliveryAmbiguityPersistenceError("Ask could not safely read an uncertain prompt-delivery marker.", { cause: error });
        }
        const marker = parseMarker(text, entry.name);
        if (!marker) {
            throw new DeliveryAmbiguityPersistenceError("Ask found an invalid uncertain prompt-delivery marker and will not close Chrome automatically.");
        }
        records.push(marker);
    }
    return mergeVolatileMarkers(env, records);
}
/** Remove exactly one already-validated record while a lifecycle lock is held. */
async function reclaimDeliveryAmbiguityMarker(env, marker, options = {}) {
    const deadlineAt = (0, session_1.resolveDeadlineAt)(options);
    const timeoutMessage = "Timed out reclaiming a stale uncertain prompt-delivery marker.";
    const markerPath = node_path_1.default.join(getDeliveryAmbiguityDirectory(env), marker.fileName);
    try {
        await (0, session_1.raceWithDeadline)(node_fs_1.default.promises.unlink(markerPath), deadlineAt, timeoutMessage);
    }
    catch (error) {
        if (isMissingFileError(error)) {
            volatileMarkers.delete(volatileMarkerKey(env, marker.fileName));
            return;
        }
        throw new DeliveryAmbiguityPersistenceError("Ask could not safely reclaim a stale uncertain prompt-delivery marker.", { cause: error });
    }
    volatileMarkers.delete(volatileMarkerKey(env, marker.fileName));
}
/** Serialize a confirmed-delivery cleanup with Browser.close lifecycle work. */
async function reclaimDeliveryAmbiguityMarkerUnderLock(env, marker, options = {}) {
    const deadlineAt = (0, session_1.resolveDeadlineAt)(options);
    await (0, session_1.withSessionLock)(env, () => reclaimDeliveryAmbiguityMarker(env, marker, { deadlineAt }), { deadlineAt });
}
/** Exposed for focused persistence tests; regular callers use recordDeliveryAmbiguity. */
async function writeDeliveryAmbiguityMarker(env, marker, options = {}) {
    const deadlineAt = (0, session_1.resolveDeadlineAt)(options);
    const timeoutMessage = "Timed out writing the uncertain prompt-delivery marker.";
    if (!isStoredMarker(marker)) {
        throw new DeliveryAmbiguityPersistenceError("Ask refused to write an invalid uncertain prompt-delivery marker.");
    }
    const directory = getDeliveryAmbiguityDirectory(env);
    const finalPath = node_path_1.default.join(directory, marker.fileName);
    const tempPath = node_path_1.default.join(directory, `.${marker.fileName}.${process.pid}.${(0, node_crypto_1.randomUUID)()}.tmp`);
    await (0, session_1.raceWithDeadline)(node_fs_1.default.promises.mkdir(directory, { recursive: true }), deadlineAt, timeoutMessage);
    let handle;
    try {
        handle = await (0, session_1.raceWithDeadline)(node_fs_1.default.promises.open(tempPath, "wx", 0o600), deadlineAt, timeoutMessage);
        await (0, session_1.raceWithDeadline)(handle.writeFile(`${JSON.stringify(serializableMarker(marker))}\n`, "utf8"), deadlineAt, timeoutMessage);
        await (0, session_1.raceWithDeadline)(handle.sync(), deadlineAt, timeoutMessage);
        await (0, session_1.raceWithDeadline)(handle.close(), deadlineAt, timeoutMessage);
        handle = undefined;
        // The destination filename is random and has never existed before, so a
        // per-record rename cannot merge-race or overwrite another ambiguity.
        await (0, session_1.raceWithDeadline)(node_fs_1.default.promises.rename(tempPath, finalPath), deadlineAt, timeoutMessage);
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        // Never remove finalPath here: a rename that crosses the deadline may
        // complete after the caller has returned, and retaining its protection is
        // safer than treating a durable ambiguity as absent.
        await node_fs_1.default.promises.unlink(tempPath).catch(() => undefined);
        throw error;
    }
}
function createMarker(input) {
    const conversationUrl = input.knownConversationUrl
        ? sanitizeKnownConversationUrl(input.provider, input.knownConversationUrl)
        : undefined;
    const marker = {
        version: exports.DELIVERY_AMBIGUITY_MARKER_VERSION,
        provider: input.provider,
        targetId: input.targetId,
        sessionGeneration: input.sessionGeneration,
        createdAt: new Date().toISOString(),
        ...(conversationUrl ? { conversationUrl } : {})
    };
    if (!isMarker(marker)) {
        throw new DeliveryAmbiguityPersistenceError("Ask refused to record an invalid uncertain prompt-delivery marker.");
    }
    return marker;
}
function serializableMarker(marker) {
    return {
        version: marker.version,
        provider: marker.provider,
        targetId: marker.targetId,
        ...(marker.conversationUrl ? { conversationUrl: marker.conversationUrl } : {}),
        sessionGeneration: marker.sessionGeneration,
        createdAt: marker.createdAt
    };
}
function parseMarker(text, fileName) {
    try {
        const parsed = JSON.parse(text);
        if (!isMarker(parsed)) {
            return undefined;
        }
        return { ...parsed, fileName };
    }
    catch {
        return undefined;
    }
}
function isStoredMarker(value) {
    return Boolean(value &&
        typeof value === "object" &&
        "fileName" in value &&
        typeof value.fileName === "string" &&
        MARKER_FILE_PATTERN.test(value.fileName) &&
        isMarker(value));
}
function isMarker(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value;
    if (candidate.version !== exports.DELIVERY_AMBIGUITY_MARKER_VERSION ||
        (candidate.provider !== "chatgpt" && candidate.provider !== "gemini") ||
        !isBoundedString(candidate.targetId, 512) ||
        !isBoundedString(candidate.sessionGeneration, 512) ||
        !isIsoTimestamp(candidate.createdAt)) {
        return false;
    }
    if (candidate.conversationUrl === undefined) {
        return true;
    }
    return typeof candidate.conversationUrl === "string" &&
        isSafeConversationUrl(candidate.provider, candidate.conversationUrl);
}
function isBoundedString(value, maxLength) {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
function isIsoTimestamp(value) {
    return typeof value === "string" &&
        value.length <= 64 &&
        Number.isFinite(Date.parse(value));
}
function sanitizeKnownConversationUrl(provider, value) {
    if (!isSafeConversationUrl(provider, value)) {
        return undefined;
    }
    const url = new URL(value);
    // Query/hash values are not needed to identify a saved provider
    // conversation and can accidentally carry account/session information.
    return `${url.origin}${url.pathname}`;
}
function isSafeConversationUrl(provider, value) {
    if (value.length === 0 || value.length > 4_096) {
        return false;
    }
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) {
            return false;
        }
        return provider === "chatgpt"
            ? (url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com")) && /^\/c\/[^/]+/.test(url.pathname)
            : url.hostname === "gemini.google.com" && /^\/app\/[^/]+/.test(url.pathname);
    }
    catch {
        return false;
    }
}
function mergeVolatileMarkers(env, persistent) {
    const byName = new Map(persistent.map((marker) => [marker.fileName, marker]));
    const prefix = `${volatileMarkerScope(env)}:`;
    for (const [key, marker] of volatileMarkers) {
        if (key.startsWith(prefix)) {
            byName.set(marker.fileName, marker);
        }
    }
    return [...byName.values()].sort((left, right) => left.fileName.localeCompare(right.fileName));
}
function volatileMarkerKey(env, fileName) {
    return `${volatileMarkerScope(env)}:${fileName}`;
}
function volatileMarkerScope(env) {
    return getDeliveryAmbiguityDirectory(env);
}
function isMissingFileError(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
