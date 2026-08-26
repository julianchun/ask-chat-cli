import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAskHome, joinConfiguredPath } from "./config";
import {
  delayWithinDeadline,
  DeadlineExceededError,
  raceWithDeadline,
  remainingDeadlineMs,
  resolveDeadlineAt,
  retainSessionLockUntil,
  throwIfDeadlineExceeded,
  withSessionLock,
  type DeadlineOptions
} from "./session";
import type { ProviderName } from "./providers";

/** A deliberately tiny, privacy-safe record for an ambiguous send. */
export const DELIVERY_AMBIGUITY_MARKER_VERSION = 1;

export interface DeliveryAmbiguityMarker {
  version: typeof DELIVERY_AMBIGUITY_MARKER_VERSION;
  provider: ProviderName;
  targetId: string;
  /** Only a provider conversation URL already known to Ask, never page data. */
  conversationUrl?: string;
  sessionGeneration: string;
  createdAt: string;
}

export interface StoredDeliveryAmbiguityMarker extends DeliveryAmbiguityMarker {
  /** File-system identity, never persisted in the JSON record itself. */
  fileName: string;
}

export interface RecordDeliveryAmbiguityOptions extends DeadlineOptions {
  env?: NodeJS.ProcessEnv;
  provider: ProviderName;
  knownConversationUrl?: string;
  /** Resolvers run while the Chrome lifecycle lease is held. */
  resolveTargetId: () => Promise<string>;
  resolveSessionGeneration: () => Promise<string>;
}

export class DeliveryAmbiguityPersistenceError extends Error {
  readonly code = "DELIVERY_AMBIGUITY_PERSISTENCE_FAILED";
  readonly marker?: StoredDeliveryAmbiguityMarker;

  constructor(message: string, options: { cause?: unknown; marker?: StoredDeliveryAmbiguityMarker } = {}) {
    super(message, { cause: options.cause });
    this.name = "DeliveryAmbiguityPersistenceError";
    this.marker = options.marker;
  }
}

const MARKER_FILE_PREFIX = "ambiguity-";
const MARKER_FILE_PATTERN = /^ambiguity-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const volatileMarkers = new Map<string, StoredDeliveryAmbiguityMarker>();

export function getDeliveryAmbiguityDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return joinConfiguredPath(getAskHome(env), "delivery-ambiguities");
}

/**
 * Capture a target and its verified managed-session generation, then atomically
 * publish a one-record ambiguity marker while the same lifecycle lock used by
 * Browser.close remains held. This closes the race between uncertain dispatch
 * and a concurrent setup/mode restart.
 */
export async function recordDeliveryAmbiguity(
  options: RecordDeliveryAmbiguityOptions
): Promise<StoredDeliveryAmbiguityMarker> {
  const env = options.env || process.env;
  const deadlineAt = resolveDeadlineAt(options);
  const timeoutMessage = "Timed out while safely recording the uncertain prompt delivery.";
  try {
    return await withSessionLock(env, async () => {
      throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
      const [targetId, sessionGeneration] = await raceWithDeadline(
        Promise.all([options.resolveTargetId(), options.resolveSessionGeneration()]),
        deadlineAt,
        timeoutMessage
      );
      const marker = createMarker({
        provider: options.provider,
        targetId,
        knownConversationUrl: options.knownConversationUrl,
        sessionGeneration
      });
      const stored: StoredDeliveryAmbiguityMarker = {
        ...marker,
        fileName: `${MARKER_FILE_PREFIX}${randomUUID()}.json`
      };

      // If the disk publication races its deadline or fails, retain a
      // same-process guard so no subsequent Browser.close in this process can
      // silently discard the still-open worker tab.
      volatileMarkers.set(volatileMarkerKey(env, stored.fileName), stored);
      const publication = writeDeliveryAmbiguityMarker(env, stored, { deadlineAt });
      try {
        await publication;
      } catch (error) {
        if (error instanceof DeadlineExceededError && retainSessionLockUntil(publication, env)) {
          // A late rename must settle while the lease remains published; it
          // either gives the next closer a durable marker or fails without
          // exposing a close/publish race.
        }
        throw new DeliveryAmbiguityPersistenceError(
          "Ask could not safely persist the uncertain prompt-delivery marker.",
          { cause: error, marker: stored }
        );
      }
      return stored;
    }, { deadlineAt });
  } catch (error) {
    if (error instanceof DeliveryAmbiguityPersistenceError) {
      throw error;
    }
    throw new DeliveryAmbiguityPersistenceError(
      "Ask could not safely persist the uncertain prompt-delivery marker.",
      { cause: error }
    );
  }
}

/**
 * Read ambiguity records without changing them. `ask status` deliberately
 * never calls this mutating/lifecycle-only API.
 */
export async function listDeliveryAmbiguityMarkers(
  env: NodeJS.ProcessEnv = process.env,
  options: DeadlineOptions = {}
): Promise<StoredDeliveryAmbiguityMarker[]> {
  const deadlineAt = resolveDeadlineAt(options);
  const timeoutMessage = "Timed out reading uncertain prompt-delivery markers.";
  const directory = getDeliveryAmbiguityDirectory(env);
  let entries: fs.Dirent[];
  try {
    entries = await raceWithDeadline(
      fs.promises.readdir(directory, { withFileTypes: true }),
      deadlineAt,
      timeoutMessage
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return mergeVolatileMarkers(env, []);
    }
    throw new DeliveryAmbiguityPersistenceError(
      "Ask could not safely inspect uncertain prompt-delivery markers.",
      { cause: error }
    );
  }

  const records: StoredDeliveryAmbiguityMarker[] = [];
  for (const entry of entries) {
    throwIfDeadlineExceeded(deadlineAt, timeoutMessage);
    if (!entry.isFile() || !MARKER_FILE_PATTERN.test(entry.name)) {
      // A partial/unknown file means a close cannot prove that every ambiguity
      // record has been considered. Fail closed rather than skipping it.
      throw new DeliveryAmbiguityPersistenceError(
        "Ask found an incomplete uncertain prompt-delivery marker and will not close Chrome automatically."
      );
    }
    const markerPath = path.join(directory, entry.name);
    let text: string;
    try {
      text = await raceWithDeadline(fs.promises.readFile(markerPath, "utf8"), deadlineAt, timeoutMessage);
    } catch (error) {
      throw new DeliveryAmbiguityPersistenceError(
        "Ask could not safely read an uncertain prompt-delivery marker.",
        { cause: error }
      );
    }
    const marker = parseMarker(text, entry.name);
    if (!marker) {
      throw new DeliveryAmbiguityPersistenceError(
        "Ask found an invalid uncertain prompt-delivery marker and will not close Chrome automatically."
      );
    }
    records.push(marker);
  }
  return mergeVolatileMarkers(env, records);
}

/** Remove exactly one already-validated record while a lifecycle lock is held. */
export async function reclaimDeliveryAmbiguityMarker(
  env: NodeJS.ProcessEnv,
  marker: StoredDeliveryAmbiguityMarker,
  options: DeadlineOptions = {}
): Promise<void> {
  const deadlineAt = resolveDeadlineAt(options);
  const timeoutMessage = "Timed out reclaiming a stale uncertain prompt-delivery marker.";
  const markerPath = path.join(getDeliveryAmbiguityDirectory(env), marker.fileName);
  try {
    await raceWithDeadline(fs.promises.unlink(markerPath), deadlineAt, timeoutMessage);
  } catch (error) {
    if (isMissingFileError(error)) {
      volatileMarkers.delete(volatileMarkerKey(env, marker.fileName));
      return;
    }
    throw new DeliveryAmbiguityPersistenceError(
      "Ask could not safely reclaim a stale uncertain prompt-delivery marker.",
      { cause: error }
    );
  }
  volatileMarkers.delete(volatileMarkerKey(env, marker.fileName));
}

/** Serialize a confirmed-delivery cleanup with Browser.close lifecycle work. */
export async function reclaimDeliveryAmbiguityMarkerUnderLock(
  env: NodeJS.ProcessEnv,
  marker: StoredDeliveryAmbiguityMarker,
  options: DeadlineOptions = {}
): Promise<void> {
  const deadlineAt = resolveDeadlineAt(options);
  await withSessionLock(
    env,
    () => reclaimDeliveryAmbiguityMarker(env, marker, { deadlineAt }),
    { deadlineAt }
  );
}

/** Exposed for focused persistence tests; regular callers use recordDeliveryAmbiguity. */
export async function writeDeliveryAmbiguityMarker(
  env: NodeJS.ProcessEnv,
  marker: StoredDeliveryAmbiguityMarker,
  options: DeadlineOptions = {}
): Promise<void> {
  const deadlineAt = resolveDeadlineAt(options);
  const timeoutMessage = "Timed out writing the uncertain prompt-delivery marker.";
  if (!isStoredMarker(marker)) {
    throw new DeliveryAmbiguityPersistenceError("Ask refused to write an invalid uncertain prompt-delivery marker.");
  }
  const directory = getDeliveryAmbiguityDirectory(env);
  const finalPath = path.join(directory, marker.fileName);
  const tempPath = path.join(directory, `.${marker.fileName}.${process.pid}.${randomUUID()}.tmp`);
  await raceWithDeadline(fs.promises.mkdir(directory, { recursive: true }), deadlineAt, timeoutMessage);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await raceWithDeadline(fs.promises.open(tempPath, "wx", 0o600), deadlineAt, timeoutMessage);
    await raceWithDeadline(
      handle.writeFile(`${JSON.stringify(serializableMarker(marker))}\n`, "utf8"),
      deadlineAt,
      timeoutMessage
    );
    await raceWithDeadline(handle.sync(), deadlineAt, timeoutMessage);
    await raceWithDeadline(handle.close(), deadlineAt, timeoutMessage);
    handle = undefined;
    // The destination filename is random and has never existed before, so a
    // per-record rename cannot merge-race or overwrite another ambiguity.
    await raceWithDeadline(fs.promises.rename(tempPath, finalPath), deadlineAt, timeoutMessage);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    // Never remove finalPath here: a rename that crosses the deadline may
    // complete after the caller has returned, and retaining its protection is
    // safer than treating a durable ambiguity as absent.
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function createMarker(input: {
  provider: ProviderName;
  targetId: string;
  knownConversationUrl?: string;
  sessionGeneration: string;
}): DeliveryAmbiguityMarker {
  const conversationUrl = input.knownConversationUrl
    ? sanitizeKnownConversationUrl(input.provider, input.knownConversationUrl)
    : undefined;
  const marker: DeliveryAmbiguityMarker = {
    version: DELIVERY_AMBIGUITY_MARKER_VERSION,
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

function serializableMarker(marker: DeliveryAmbiguityMarker): DeliveryAmbiguityMarker {
  return {
    version: marker.version,
    provider: marker.provider,
    targetId: marker.targetId,
    ...(marker.conversationUrl ? { conversationUrl: marker.conversationUrl } : {}),
    sessionGeneration: marker.sessionGeneration,
    createdAt: marker.createdAt
  };
}

function parseMarker(text: string, fileName: string): StoredDeliveryAmbiguityMarker | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isMarker(parsed)) {
      return undefined;
    }
    return { ...parsed, fileName };
  } catch {
    return undefined;
  }
}

function isStoredMarker(value: unknown): value is StoredDeliveryAmbiguityMarker {
  return Boolean(
    value &&
    typeof value === "object" &&
    "fileName" in value &&
    typeof (value as { fileName?: unknown }).fileName === "string" &&
    MARKER_FILE_PATTERN.test((value as { fileName: string }).fileName) &&
    isMarker(value)
  );
}

function isMarker(value: unknown): value is DeliveryAmbiguityMarker {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== DELIVERY_AMBIGUITY_MARKER_VERSION ||
    (candidate.provider !== "chatgpt" && candidate.provider !== "gemini") ||
    !isBoundedString(candidate.targetId, 512) ||
    !isBoundedString(candidate.sessionGeneration, 512) ||
    !isIsoTimestamp(candidate.createdAt)
  ) {
    return false;
  }
  if (candidate.conversationUrl === undefined) {
    return true;
  }
  return typeof candidate.conversationUrl === "string" &&
    isSafeConversationUrl(candidate.provider as ProviderName, candidate.conversationUrl);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value));
}

function sanitizeKnownConversationUrl(provider: ProviderName, value: string): string | undefined {
  if (!isSafeConversationUrl(provider, value)) {
    return undefined;
  }
  const url = new URL(value);
  // Query/hash values are not needed to identify a saved provider
  // conversation and can accidentally carry account/session information.
  return `${url.origin}${url.pathname}`;
}

function isSafeConversationUrl(provider: ProviderName, value: string): boolean {
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
  } catch {
    return false;
  }
}

function mergeVolatileMarkers(
  env: NodeJS.ProcessEnv,
  persistent: StoredDeliveryAmbiguityMarker[]
): StoredDeliveryAmbiguityMarker[] {
  const byName = new Map(persistent.map((marker) => [marker.fileName, marker]));
  const prefix = `${volatileMarkerScope(env)}:`;
  for (const [key, marker] of volatileMarkers) {
    if (key.startsWith(prefix)) {
      byName.set(marker.fileName, marker);
    }
  }
  return [...byName.values()].sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function volatileMarkerKey(env: NodeJS.ProcessEnv, fileName: string): string {
  return `${volatileMarkerScope(env)}:${fileName}`;
}

function volatileMarkerScope(env: NodeJS.ProcessEnv): string {
  return getDeliveryAmbiguityDirectory(env);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
