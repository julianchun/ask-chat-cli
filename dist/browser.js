"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BACKGROUND_CAPABILITY_FLAGS = exports.ChromeSessionConfigMismatchError = exports.ChromeSessionConflictError = void 0;
exports.createChromeSessionController = createChromeSessionController;
exports.getChromeCandidates = getChromeCandidates;
exports.resolveChromePath = resolveChromePath;
exports.resolveChromePortSelection = resolveChromePortSelection;
exports.isRemoteDebuggingReady = isRemoteDebuggingReady;
exports.getRemoteDebuggingVersion = getRemoteDebuggingVersion;
exports.isHeadlessRemoteDebugging = isHeadlessRemoteDebugging;
exports.resolveChromeMode = resolveChromeMode;
exports.shouldRestartChromeForMode = shouldRestartChromeForMode;
exports.hasBackgroundExecutionCapability = hasBackgroundExecutionCapability;
exports.shouldRestartManagedChromeForRequest = shouldRestartManagedChromeForRequest;
exports.waitForRemoteDebugging = waitForRemoteDebugging;
exports.waitForRemoteDebuggingToClose = waitForRemoteDebuggingToClose;
exports.getDevToolsActivePortPath = getDevToolsActivePortPath;
exports.readDevToolsActivePort = readDevToolsActivePort;
exports.waitForDevToolsActivePort = waitForDevToolsActivePort;
exports.reconcileAutomaticChromeSession = reconcileAutomaticChromeSession;
exports.buildChromeArgs = buildChromeArgs;
exports.buildChromeAuthenticationArgs = buildChromeAuthenticationArgs;
exports.authenticateChromeProfile = authenticateChromeProfile;
exports.waitForAuthenticationChromeToExit = waitForAuthenticationChromeToExit;
exports.launchChrome = launchChrome;
exports.minimizeConnectedChromeWindows = minimizeConnectedChromeWindows;
exports.closeChromeOnPort = closeChromeOnPort;
exports.assertNoLiveDeliveryAmbiguityBeforeClose = assertNoLiveDeliveryAmbiguityBeforeClose;
exports.getChromeSessionClassification = getChromeSessionClassification;
exports.inspectChromeSession = inspectChromeSession;
exports.ensureManagedChrome = ensureManagedChrome;
exports.ensureChrome = ensureChrome;
exports.getChromeConnectionDescriptor = getChromeConnectionDescriptor;
exports.connectToChrome = connectToChrome;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_net_1 = __importDefault(require("node:net"));
const node_crypto_1 = require("node:crypto");
const playwright_core_1 = require("playwright-core");
const config_1 = require("./config");
const session_1 = require("./session");
const delivery_ambiguity_1 = require("./delivery-ambiguity");
/** Maximum bounded retry window when a caller did not already provide one. */
const AUTOMATIC_DRIFT_RECOVERY_TIMEOUT_MS = 15_000;
class ChromeSessionConflictError extends Error {
    code = "SESSION_CONFLICT";
    constructor(message) {
        super(message);
        this.name = "ChromeSessionConflictError";
    }
}
exports.ChromeSessionConflictError = ChromeSessionConflictError;
class ChromeSessionConfigMismatchError extends Error {
    code = "SESSION_CONFIG_MISMATCH";
    constructor(message) {
        super(message);
        this.name = "ChromeSessionConfigMismatchError";
    }
}
exports.ChromeSessionConfigMismatchError = ChromeSessionConfigMismatchError;
function createChromeSessionController(env = process.env) {
    return {
        connect: (options = {}) => connectToChrome({ ...options, env }),
        inspect: (options = {}) => inspectChromeSession({ ...options, env }),
        close: async (options = {}) => {
            const inspection = await inspectChromeSession({ ...options, env });
            if (!inspection.connected || inspection.port === undefined) {
                return;
            }
            await closeChromeOnPort(inspection.port, { ...options, env });
        },
        waitUntilReady: async (timeoutMs = 15_000) => {
            const deadlineAt = (0, session_1.resolveDeadlineAt)({ timeoutMs });
            while ((0, session_1.remainingDeadlineMs)(deadlineAt) > 0) {
                const inspection = await inspectChromeSession({ env, deadlineAt });
                if (inspection.port !== undefined &&
                    inspection.connected &&
                    inspection.classification.ownership === "ask-managed") {
                    return;
                }
                await (0, session_1.delayWithinDeadline)(100, deadlineAt, "The ask Chrome session did not publish a ready remote debugging endpoint in time.");
            }
            throw new session_1.DeadlineExceededError("The ask Chrome session did not publish a ready remote debugging endpoint in time.");
        }
    };
}
function withLifecycleDeadline(options) {
    const deadlineAt = (0, session_1.resolveDeadlineAt)(options);
    const { timeoutMs: _timeoutMs, ...rest } = options;
    return deadlineAt === undefined ? rest : { ...rest, deadlineAt };
}
function resolveWaitDeadline(timeoutOrOptions, defaultTimeoutMs) {
    return typeof timeoutOrOptions === "number"
        ? (0, session_1.resolveDeadlineAt)({ timeoutMs: timeoutOrOptions })
        : (0, session_1.resolveDeadlineAt)(timeoutOrOptions, defaultTimeoutMs);
}
function getChromeCandidates(env = process.env, platform) {
    const inferredPlatform = platform || inferChromePlatform(env);
    const pathValue = env.PATH || env.Path || env.path;
    const pathDirectories = pathValue
        ? pathValue.split(inferredPlatform === "win32" ? node_path_1.default.win32.delimiter : node_path_1.default.posix.delimiter)
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];
    const fromPath = (names) => pathDirectories.flatMap((directory) => names.map((name) => inferredPlatform === "win32"
        ? node_path_1.default.win32.join(directory, name)
        : node_path_1.default.posix.join(directory, name)));
    let candidates;
    if (inferredPlatform === "win32") {
        candidates = [
            env.ProgramFiles && node_path_1.default.win32.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
            env["ProgramFiles(x86)"] && node_path_1.default.win32.join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
            env.LocalAppData && node_path_1.default.win32.join(env.LocalAppData, "Google", "Chrome", "Application", "chrome.exe"),
            env.PROGRAMFILES && node_path_1.default.win32.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
            env["PROGRAMFILES(X86)"] && node_path_1.default.win32.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
            env.LOCALAPPDATA && node_path_1.default.win32.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
            ...fromPath(["chrome.exe"])
        ];
    }
    else if (inferredPlatform === "darwin") {
        const home = env.HOME || node_os_1.default.homedir();
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            node_path_1.default.posix.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
            ...fromPath(["google-chrome", "Google Chrome"])
        ];
    }
    else {
        candidates = [
            ...fromPath(["google-chrome-stable", "google-chrome"]),
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/opt/google/chrome/google-chrome",
            "/opt/google/chrome/chrome"
        ];
    }
    return [...new Set(candidates.filter((candidate) => Boolean(candidate)))];
}
function inferChromePlatform(env) {
    return env.ProgramFiles || env["ProgramFiles(x86)"] || env.LocalAppData ||
        env.PROGRAMFILES || env["PROGRAMFILES(X86)"] || env.LOCALAPPDATA
        ? "win32"
        : process.platform;
}
function resolveChromePath(env = process.env, exists = node_fs_1.default.existsSync, platform) {
    const resolvedPlatform = platform || inferChromePlatform(env);
    if (env.ASK_CHROME_PATH !== undefined) {
        const configuredPath = env.ASK_CHROME_PATH;
        if (!configuredPath.trim()) {
            throw new Error("ASK_CHROME_PATH is set but empty. Point it to the Google Chrome executable.");
        }
        if (!isChromeExecutablePath(configuredPath, exists, resolvedPlatform)) {
            throw new Error(`ASK_CHROME_PATH does not point to a file: ${configuredPath}`);
        }
        return configuredPath;
    }
    const match = getChromeCandidates(env, resolvedPlatform)
        .find((candidate) => isChromeExecutablePath(candidate, exists, resolvedPlatform));
    if (!match) {
        throw new Error("Google Chrome was not found. Set ASK_CHROME_PATH to the Google Chrome executable.");
    }
    return match;
}
function isChromeExecutablePath(filePath, exists, platform = process.platform) {
    if (!exists(filePath)) {
        return false;
    }
    if (exists !== node_fs_1.default.existsSync) {
        return true;
    }
    try {
        if (!node_fs_1.default.statSync(filePath).isFile()) {
            return false;
        }
        // Windows does not implement POSIX execute bits: X_OK succeeds for any
        // regular file. Chrome's native executable is an .exe, so reject an
        // arbitrary text/script file before attempting to spawn it.
        if (platform === "win32" && node_path_1.default.win32.extname(filePath).toLowerCase() !== ".exe") {
            return false;
        }
        node_fs_1.default.accessSync(filePath, node_fs_1.default.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function resolveChromePortSelection(options = {}) {
    const env = options.env || process.env;
    const configuredPort = (0, config_1.getRemoteDebuggingPort)(env);
    const requestedPort = options.port;
    if (requestedPort !== undefined &&
        (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)) {
        throw new Error("Chrome remote debugging port must be an integer between 0 and 65535.");
    }
    if (configuredPort !== undefined && requestedPort !== undefined && requestedPort !== configuredPort) {
        throw new ChromeSessionConfigMismatchError(`Requested Chrome debugging port ${requestedPort}, but ASK_REMOTE_DEBUGGING_PORT pins port ${configuredPort}.`);
    }
    const port = requestedPort === 0 ? undefined : requestedPort ?? configuredPort;
    return port === undefined
        ? { portPolicy: "automatic", launchPort: 0 }
        : { portPolicy: "pinned", port, launchPort: port };
}
async function isRemoteDebuggingReady(port, options = {}) {
    return Boolean(await getRemoteDebuggingVersion(port, options));
}
async function getRemoteDebuggingVersion(port, options = {}) {
    const lifecycleDeadlineAt = (0, session_1.resolveDeadlineAt)(options);
    (0, session_1.throwIfDeadlineExceeded)(lifecycleDeadlineAt, `Timed out probing Chrome remote debugging on port ${port}.`);
    const requestDeadlineAt = Math.min(lifecycleDeadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + 1_000);
    const requestTimeoutMs = Math.max(1, (0, session_1.remainingDeadlineMs)(requestDeadlineAt));
    try {
        const response = await (0, session_1.raceWithDeadline)(fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(requestTimeoutMs) }), requestDeadlineAt, `Timed out probing Chrome remote debugging on port ${port}.`);
        if (!response.ok) {
            return undefined;
        }
        const body = await (0, session_1.raceWithDeadline)(response.json(), requestDeadlineAt, `Timed out reading Chrome remote debugging metadata on port ${port}.`);
        return body && typeof body === "object" ? body : {};
    }
    catch (error) {
        if (lifecycleDeadlineAt !== undefined &&
            requestDeadlineAt === lifecycleDeadlineAt &&
            (error instanceof session_1.DeadlineExceededError || (0, session_1.remainingDeadlineMs)(lifecycleDeadlineAt) === 0)) {
            throw new session_1.DeadlineExceededError(`Timed out probing Chrome remote debugging on port ${port}.`);
        }
        return undefined;
    }
}
function isHeadlessRemoteDebugging(version) {
    const browser = typeof version.Browser === "string" ? version.Browser : "";
    const userAgent = typeof version["User-Agent"] === "string" ? version["User-Agent"] : "";
    return browser.includes("HeadlessChrome/") || userAgent.includes("HeadlessChrome/");
}
function resolveChromeMode(options = {}) {
    if (options.desiredMode) {
        if (!["visible", "headless", "preserve"].includes(options.desiredMode)) {
            throw new Error(`Unsupported Chrome mode: ${String(options.desiredMode)}`);
        }
        if (options.requireVisible && options.desiredMode !== "visible") {
            throw new Error(`Chrome mode ${options.desiredMode} conflicts with requireVisible.`);
        }
        if (options.headless !== undefined) {
            const legacyMode = options.headless ? "headless" : "visible";
            if (options.desiredMode !== legacyMode) {
                throw new Error(`Chrome mode ${options.desiredMode} conflicts with headless=${options.headless}.`);
            }
        }
        return options.desiredMode;
    }
    if (options.headless === true && options.requireVisible) {
        throw new Error("Headless Chrome conflicts with requireVisible.");
    }
    if (options.headless === true) {
        return "headless";
    }
    if (options.requireVisible || options.headless === false) {
        return "visible";
    }
    return "preserve";
}
function shouldRestartChromeForMode(version, options) {
    const desiredMode = resolveChromeMode(options);
    return desiredMode !== "preserve" && modeFromVersion(version) !== desiredMode;
}
/**
 * A minimized headed Chrome throttles renderer/timer work unless these launch
 * flags are present. They are part of Ask's managed-session capability, not a
 * cosmetic preference: provider acknowledgement must keep running while the
 * window is parked.
 */
exports.BACKGROUND_CAPABILITY_FLAGS = [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding"
];
function hasBackgroundExecutionCapability(processInfo) {
    if (!processInfo) {
        return false;
    }
    return exports.BACKGROUND_CAPABILITY_FLAGS.every((flag) => processHasEnabledBooleanFlag(processInfo, flag));
}
function processHasEnabledBooleanFlag(processInfo, flag) {
    const normalizedFlag = flag.toLowerCase();
    if (processInfo.args) {
        return processInfo.args.some((argument) => {
            const normalized = argument.toLowerCase();
            return normalized === normalizedFlag || normalized === `${normalizedFlag}=true` || normalized === `${normalizedFlag}=1`;
        });
    }
    const escaped = escapeRegExpForBrowser(flag);
    return new RegExp(`(?:^|\\s)(?:["']?${escaped}(?:=(?:true|1))?["']?)(?=\\s|$)`, "i").test(processInfo.commandLine || "");
}
function escapeRegExpForBrowser(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function requiresBackgroundCapabilityRestart(processInfo, options) {
    return options.background === true && !hasBackgroundExecutionCapability(processInfo);
}
/**
 * Keep the mode and minimized-background requirements in one testable policy.
 * Callers invoke this only after ownership has been verified, so a positive
 * result means an ask-owned session may be restarted under the lifecycle lock.
 */
function shouldRestartManagedChromeForRequest(version, processInfo, options) {
    return shouldRestartChromeForMode(version, options) ||
        requiresBackgroundCapabilityRestart(processInfo, options);
}
function formatBackgroundCapabilityConflict(port) {
    return (`The ask-managed Chrome session on port ${port} was started without the background execution flags ` +
        "needed for a minimized provider send. Ask could not safely restart it while this session is protected. " +
        "Close the preserved worker tab after inspection, then retry the command.");
}
function modeFromVersion(version) {
    return isHeadlessRemoteDebugging(version) ? "headless" : "visible";
}
function formatOwnershipError(port, classification) {
    return (`Chrome remote debugging on port ${port} is not an ask-managed session (${classification.ownership}). ` +
        `${classification.reason || "The session could not be verified."} ` +
        "Ask will not attach to or close that Chrome process. Run `ask status` to inspect it.");
}
function formatModeConflict(port, version, desiredMode, classification) {
    const currentMode = modeFromVersion(version);
    return (`Chrome remote debugging on port ${port} is already attached to a ${currentMode} Chrome session, ` +
        `but ${desiredMode} mode was requested and it is not safe to replace the session automatically ` +
        `(${classification.ownership}). ${classification.reason || "The session could not be verified."} ` +
        "Run `ask status` to inspect it.");
}
async function waitForRemoteDebugging(port, timeoutOrOptions = 15_000) {
    const deadlineAt = resolveWaitDeadline(timeoutOrOptions, 15_000);
    const timeoutMessage = `Chrome remote debugging did not become ready on port ${port}. ` +
        "Run `ask login` again to restart the dedicated ask Chrome profile.";
    try {
        while ((0, session_1.remainingDeadlineMs)(deadlineAt) > 0) {
            if (await isRemoteDebuggingReady(port, { deadlineAt })) {
                return;
            }
            await (0, session_1.delayWithinDeadline)(250, deadlineAt, timeoutMessage);
        }
    }
    catch (error) {
        if (!(error instanceof session_1.DeadlineExceededError)) {
            throw error;
        }
    }
    throw new session_1.DeadlineExceededError(timeoutMessage);
}
async function waitForRemoteDebuggingToClose(port, timeoutOrOptions = 10_000) {
    const deadlineAt = resolveWaitDeadline(timeoutOrOptions, 10_000);
    const timeoutMessage = `Chrome remote debugging on port ${port} did not close in time.`;
    try {
        while ((0, session_1.remainingDeadlineMs)(deadlineAt) > 0) {
            if (!(await isRemoteDebuggingReady(port, { deadlineAt }))) {
                return;
            }
            await (0, session_1.delayWithinDeadline)(250, deadlineAt, timeoutMessage);
        }
    }
    catch (error) {
        if (!(error instanceof session_1.DeadlineExceededError)) {
            throw error;
        }
    }
    throw new session_1.DeadlineExceededError(timeoutMessage);
}
function getDevToolsActivePortPath(env = process.env) {
    return (0, config_1.joinConfiguredPath)((0, config_1.getChromeProfileDir)(env), "DevToolsActivePort");
}
async function readDevToolsActivePort(env = process.env, options = {}) {
    const deadlineAt = (0, session_1.resolveDeadlineAt)(options);
    const timeoutMessage = "Timed out reading Chrome's DevToolsActivePort file.";
    try {
        (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
        const contents = await (0, session_1.raceWithDeadline)(node_fs_1.default.promises.readFile(getDevToolsActivePortPath(env), "utf8"), deadlineAt, timeoutMessage);
        const firstLine = contents.split(/\r?\n/, 1)[0]?.trim() || "";
        if (!/^\d+$/.test(firstLine)) {
            return undefined;
        }
        const port = Number(firstLine);
        return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
    }
    catch (error) {
        if (error instanceof session_1.DeadlineExceededError) {
            throw error;
        }
        return undefined;
    }
}
async function waitForDevToolsActivePort(env = process.env, timeoutOrOptions = 15_000) {
    const deadlineAt = resolveWaitDeadline(timeoutOrOptions, 15_000);
    const timeoutMessage = "Chrome did not write a fresh DevToolsActivePort file in time.";
    while ((0, session_1.remainingDeadlineMs)(deadlineAt) > 0) {
        const port = await readDevToolsActivePort(env, { deadlineAt });
        if (port !== undefined) {
            return port;
        }
        await (0, session_1.delayWithinDeadline)(100, deadlineAt, timeoutMessage);
    }
    throw new session_1.DeadlineExceededError(timeoutMessage);
}
function automaticRecoveryDeadline(deadlineAt) {
    return Math.min(deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + AUTOMATIC_DRIFT_RECOVERY_TIMEOUT_MS);
}
/**
 * Safely refresh automatic session state after Chrome itself restarts and
 * chooses a new port. This is deliberately a narrow ownership transfer: a
 * persisted automatic state must name the exact generation now listening from
 * our marked profile, and the operating system must corroborate a single
 * browser-root process twice before anything is written.
 *
 * The exported wrapper takes the ordinary lifecycle lease so test callers and
 * future call sites cannot accidentally perform the repair outside it.
 */
async function reconcileAutomaticChromeSession(env = process.env, options = {}, dependencies = {}) {
    const deadlineAt = automaticRecoveryDeadline((0, session_1.resolveDeadlineAt)(options));
    return (0, session_1.withSessionLock)(env, () => reconcileAutomaticChromeSessionUnlocked(env, deadlineAt, dependencies), { deadlineAt });
}
async function reconcileAutomaticChromeSessionUnlocked(env, deadlineAt, dependencies = {}) {
    const timeoutMessage = "Timed out while reconciling the automatic ask Chrome session.";
    let repairAttempted = false;
    while (true) {
        (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
        const first = await captureAutomaticDriftSnapshot(env, deadlineAt, dependencies);
        // No persisted automatic state can be repaired. A live same-profile
        // endpoint is nevertheless unsafe to overwrite or attach to.
        if (!first.state || !isPersistedAutomaticSession(first.state)) {
            throwIfUnsafeAutomaticEndpoint(first, env);
            return { state: first.state, activePort: first.activePort, repaired: false };
        }
        if (first.activePort === undefined) {
            return { state: first.state, activePort: first.activePort, repaired: false };
        }
        if (first.activePort === first.state.port) {
            if (!repairAttempted || isVerifiedAutomaticRepair(first, first.state, env)) {
                return { state: first.state, activePort: first.activePort, repaired: repairAttempted };
            }
            throwIfUnsafeAutomaticEndpoint(first, env);
            throw new ChromeSessionConflictError("Chrome changed while Ask was repairing automatic session state; Ask will not attach until ownership is stable.");
        }
        // A dead DevToolsActivePort file is common after a failed/manual browser
        // exit. It is not proof of a new session; leave the known state intact.
        if (!first.version) {
            if (hasSameProfileBrowserRoot(first)) {
                throw new ChromeSessionConflictError("The Ask Chrome profile is in use by an unverified browser process; Ask will not adopt or replace it.");
            }
            return { state: first.state, activePort: first.activePort, repaired: false };
        }
        const second = await captureAutomaticDriftSnapshot(env, deadlineAt, dependencies);
        if (automaticDriftSnapshotKey(first) !== automaticDriftSnapshotKey(second)) {
            await (0, session_1.delayWithinDeadline)(25, deadlineAt, timeoutMessage);
            continue;
        }
        if (!isExactAutomaticDriftCandidate(second, env)) {
            throwIfUnsafeAutomaticEndpoint(second, env);
            return { state: second.state, activePort: second.activePort, repaired: false };
        }
        const state = second.state;
        const owner = second.owner;
        const port = second.activePort;
        const version = second.version;
        const persisted = await (0, session_1.writeSessionState)(env, {
            pid: owner.pid,
            port,
            chromePath: state.chromePath,
            headless: isHeadlessRemoteDebugging(version),
            processCreationTime: owner.creationTime,
            generation: state.generation,
            portPolicy: state.portPolicy,
            requestedPort: state.requestedPort
        }, { deadlineAt });
        repairAttempted = true;
        const verified = await captureAutomaticDriftSnapshot(env, deadlineAt, dependencies);
        if (isVerifiedAutomaticRepair(verified, persisted, env)) {
            launchedSessions.delete(state.port);
            launchedSessions.set(port, { env, generation: persisted.generation });
            return { state: persisted, activePort: port, repaired: true };
        }
        // A Chrome restart or ActivePort rewrite raced the atomic publication.
        // The state is never trusted until a fresh stable pair confirms it.
        await (0, session_1.delayWithinDeadline)(25, deadlineAt, timeoutMessage);
    }
}
async function captureAutomaticDriftSnapshot(env, deadlineAt, dependencies) {
    const options = { deadlineAt };
    const state = await (dependencies.readState || session_1.readSessionState)(env, options);
    const activePort = await (dependencies.readActivePort || readDevToolsActivePort)(env, options);
    const markerValid = state
        ? await (dependencies.hasProfileMarker || session_1.hasProfileMarker)(env, options)
        : false;
    let version;
    let owner;
    if (activePort !== undefined) {
        version = await (dependencies.getVersion || getRemoteDebuggingVersion)(activePort, options);
        if (version) {
            owner = await (dependencies.getPortOwner || session_1.getPortOwnerProcessInfo)(activePort);
        }
    }
    const profileProcesses = state
        ? await (dependencies.getProfileProcesses || session_1.getChromeBrowserProcessesUsingProfile)(state.profileDir, options)
        : undefined;
    return {
        state,
        activePort,
        markerValid,
        version,
        endpointValid: Boolean(version && isValidBrowserEndpoint(version, activePort)),
        owner,
        profileProcesses
    };
}
function isPersistedAutomaticSession(state) {
    return state.portPolicy === "automatic" && state.requestedPort === 0;
}
function automaticDriftSnapshotKey(snapshot) {
    const processKey = (processInfo) => processInfo ? {
        pid: processInfo.pid,
        creationTime: processInfo.creationTime,
        executablePath: processInfo.executablePath,
        args: processInfo.args,
        commandLine: processInfo.commandLine
    } : undefined;
    return JSON.stringify({
        state: snapshot.state ? {
            nonce: snapshot.state.nonce,
            generation: snapshot.state.generation,
            portPolicy: snapshot.state.portPolicy,
            requestedPort: snapshot.state.requestedPort,
            pid: snapshot.state.pid,
            port: snapshot.state.port,
            processCreationTime: snapshot.state.processCreationTime,
            chromePath: snapshot.state.chromePath,
            profileDir: snapshot.state.profileDir,
            headless: snapshot.state.headless
        } : undefined,
        activePort: snapshot.activePort,
        markerValid: snapshot.markerValid,
        endpointValid: snapshot.endpointValid,
        version: snapshot.version,
        owner: processKey(snapshot.owner),
        profileProcesses: snapshot.profileProcesses
            ?.map(processKey)
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    });
}
function isExactAutomaticDriftCandidate(snapshot, env) {
    const state = snapshot.state;
    const owner = snapshot.owner;
    if (!state ||
        !isPersistedAutomaticSession(state) ||
        !state.nonce ||
        !state.generation ||
        state.port === snapshot.activePort ||
        !snapshot.markerValid ||
        !snapshot.version ||
        !snapshot.endpointValid ||
        !owner ||
        !owner.creationTime ||
        (0, session_1.normalizePathForCompare)(state.profileDir) !== (0, session_1.normalizePathForCompare)((0, config_1.getChromeProfileDir)(env)) ||
        !(0, session_1.processMatchesAskSession)(owner, 0, state.profileDir, state.generation) ||
        !chromeExecutableMatchesState(owner, state) ||
        !Array.isArray(snapshot.profileProcesses) ||
        snapshot.profileProcesses.length !== 1) {
        return false;
    }
    const root = snapshot.profileProcesses[0];
    return (root.pid === owner.pid &&
        root.creationTime === owner.creationTime &&
        (0, session_1.processMatchesAskSession)(root, 0, state.profileDir, state.generation) &&
        chromeExecutableMatchesState(root, state));
}
function isVerifiedAutomaticRepair(snapshot, persisted, env) {
    const state = snapshot.state;
    const owner = snapshot.owner;
    if (!state ||
        state.nonce !== persisted.nonce ||
        state.pid !== persisted.pid ||
        state.port !== persisted.port ||
        state.processCreationTime !== persisted.processCreationTime ||
        state.generation !== persisted.generation ||
        state.chromePath !== persisted.chromePath ||
        state.portPolicy !== "automatic" ||
        state.requestedPort !== 0 ||
        snapshot.activePort !== persisted.port ||
        !snapshot.markerValid ||
        !snapshot.version ||
        !snapshot.endpointValid ||
        !owner ||
        !owner.creationTime ||
        (0, session_1.normalizePathForCompare)(state.profileDir) !== (0, session_1.normalizePathForCompare)((0, config_1.getChromeProfileDir)(env)) ||
        !(0, session_1.processMatchesAskSession)(owner, 0, state.profileDir, persisted.generation) ||
        !chromeExecutableMatchesState(owner, state) ||
        !Array.isArray(snapshot.profileProcesses) ||
        snapshot.profileProcesses.length !== 1) {
        return false;
    }
    const root = snapshot.profileProcesses[0];
    return root.pid === owner.pid &&
        root.creationTime === owner.creationTime &&
        (0, session_1.processMatchesAskSession)(root, 0, state.profileDir, persisted.generation) &&
        chromeExecutableMatchesState(root, state);
}
function chromeExecutableMatchesState(owner, state) {
    return !owner.executablePath ||
        (0, session_1.normalizePathForCompare)(owner.executablePath) === (0, session_1.normalizePathForCompare)(state.chromePath);
}
function hasSameProfileBrowserRoot(snapshot) {
    return Boolean(snapshot.profileProcesses && snapshot.profileProcesses.length > 0);
}
function throwIfUnsafeAutomaticEndpoint(snapshot, env) {
    const state = snapshot.state;
    const profileDir = state?.profileDir || (0, config_1.getChromeProfileDir)(env);
    const ownerUsesProfile = Boolean(snapshot.owner && (0, session_1.processUsesChromeProfile)(snapshot.owner, profileDir));
    if (snapshot.version && (ownerUsesProfile || hasSameProfileBrowserRoot(snapshot))) {
        throw new ChromeSessionConflictError("Chrome's DevToolsActivePort points to an unverified process using the Ask profile; Ask will not adopt, attach to, or close it.");
    }
    if (snapshot.version && state && snapshot.activePort !== state.port && !snapshot.owner) {
        // A live endpoint disagreeing with persisted state is unsafe even when
        // OS ownership lookup failed: treating it as stale could overwrite a
        // browser whose profile relation we were unable to prove.
        throw new ChromeSessionConflictError("Chrome's live automatic debugging endpoint does not match verified ask session state; Ask will not adopt or replace it.");
    }
}
function isValidBrowserEndpoint(version, port) {
    if (port === undefined) {
        return false;
    }
    try {
        browserWebSocketEndpoint(version, port);
        return true;
    }
    catch {
        return false;
    }
}
function buildChromeArgs(options = {}) {
    const env = options.env || process.env;
    const selection = resolveChromePortSelection(options);
    const profileDir = (0, config_1.getChromeProfileDir)(env);
    const args = [
        `--remote-debugging-port=${selection.launchPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        // Ask intentionally automates a minimized dedicated window. Keep provider
        // acknowledgement timers and renderer work running while it is hidden.
        ...exports.BACKGROUND_CAPABILITY_FLAGS
    ];
    if (options.sessionGeneration) {
        args.push(`--ask-session-generation=${options.sessionGeneration}`);
    }
    if (resolveChromeMode(options) === "headless") {
        args.push("--headless=new");
    }
    else {
        if (options.background) {
            // Minimize first so multi-monitor window managers cannot clamp the
            // off-screen fallback onto a visible display.
            args.push("--start-minimized", "--window-position=-10000,-10000", "--window-size=800,600");
        }
        args.push("--new-window");
    }
    args.push(options.url || "about:blank");
    return args;
}
/**
 * Builds the one-time non-automated authentication launch without exposing a DevTools
 * endpoint. Google and other identity providers may reject sign-in while a
 * browser is actively controlled, so setup deliberately uses ordinary Chrome
 * and hands the persistent profile back only after Chrome fully exits.
 */
function buildChromeAuthenticationArgs(options) {
    const env = options.env || process.env;
    return [
        `--user-data-dir=${(0, config_1.getChromeProfileDir)(env)}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--window-position=80,80",
        "--window-size=1200,800",
        "--new-window",
        options.url
    ];
}
async function authenticateChromeProfile(options) {
    const env = options.env || process.env;
    const deadlineAt = (0, session_1.resolveDeadlineAt)(options);
    const lifecycleDependencies = options.lifecycleDependencies;
    const profileDir = (0, config_1.getChromeProfileDir)(env);
    const timeoutMessage = "Timed out waiting for the ordinary sign-in Chrome to close. Finish sign-in, then fully quit that Chrome instance and retry `ask setup`.";
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
    validateStrictChromePath(env);
    const inspection = await inspectChromeSession({ env, deadlineAt });
    if (inspection.connected && inspection.port !== undefined) {
        if (inspection.classification.ownership !== "ask-managed") {
            if (isEndpointUsingAskProfile(inspection.classification, inspection.port, profileDir)) {
                throw new ChromeSessionConflictError("The Ask Chrome profile is already open in an unverified Chrome process. Fully quit that Ask Chrome window, then retry `ask setup`.");
            }
        }
        else {
            await closeChromeOnPort(inspection.port, { env, deadlineAt });
            await waitForRemoteDebuggingToClose(inspection.port, { deadlineAt });
        }
    }
    await waitForProfileToBecomeAvailable(profileDir, deadlineAt, lifecycleDependencies);
    await (0, session_1.raceWithDeadline)(node_fs_1.default.promises.mkdir(profileDir, { recursive: true }), deadlineAt, "Timed out creating the Ask Chrome profile for ordinary sign-in.");
    await (0, session_1.writeProfileMarker)(env, { deadlineAt });
    const chromePath = resolveChromePath(env);
    const args = buildChromeAuthenticationArgs({ ...options, env, deadlineAt });
    if (options.verbose) {
        process.stderr.write(`Launching ordinary sign-in Chrome (automation off): ${chromePath} ${args.join(" ")}\n`);
    }
    const child = await (0, session_1.raceWithDeadline)(spawnChromeProcess(chromePath, args), deadlineAt, "Timed out launching ordinary Chrome for sign-in.");
    await waitForAuthenticationChromeToExit(child, profileDir, deadlineAt, timeoutMessage, lifecycleDependencies);
}
async function waitForProfileToBecomeAvailable(profileDir, deadlineAt, dependencies = {}) {
    const timeoutMessage = "The Ask Chrome profile is still open. Fully quit its Chrome process, then retry `ask setup`.";
    if (authenticationPlatform(dependencies) === "win32") {
        while (true) {
            (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
            const profileProcesses = await getAuthenticationProfileProcesses(profileDir, deadlineAt, dependencies);
            if (profileProcesses === undefined) {
                throw new ChromeSessionConflictError("Ask could not verify whether the dedicated Chrome profile is open on Windows. " +
                    "Close the Ask Chrome window and retry `ask setup`; Ask will not risk sharing that profile.");
            }
            if (profileProcesses.length === 0) {
                return;
            }
            await (0, session_1.delayWithinDeadline)(authenticationPollInterval(dependencies), deadlineAt, timeoutMessage);
        }
    }
    while (profileLockIsLive(profileDir)) {
        (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
        await (0, session_1.delayWithinDeadline)(authenticationPollInterval(dependencies), deadlineAt, timeoutMessage);
    }
}
function profileLockIsLive(profileDir) {
    const lockPath = node_path_1.default.join(profileDir, "SingletonLock");
    try {
        const target = node_fs_1.default.readlinkSync(lockPath);
        const match = /-(\d+)$/.exec(target);
        return match ? (0, session_1.isProcessAlive)(Number(match[1])) : true;
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return false;
        }
        try {
            return node_fs_1.default.existsSync(lockPath);
        }
        catch {
            return true;
        }
    }
}
async function waitForAuthenticationChromeToExit(child, profileDir, deadlineAt, timeoutMessage, dependencies = {}) {
    if (authenticationPlatform(dependencies) === "win32") {
        await waitForWindowsAuthenticationChromeToExit(child, profileDir, deadlineAt, timeoutMessage, dependencies);
        return;
    }
    let sawLiveProfile = false;
    const startedAt = Date.now();
    while (true) {
        (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
        const profileIsLive = profileLockIsLive(profileDir);
        sawLiveProfile ||= profileIsLive;
        if (sawLiveProfile && !profileIsLive) {
            return;
        }
        if (!sawLiveProfile &&
            (child.exitCode !== null || child.signalCode !== null) &&
            Date.now() - startedAt >= 2_000) {
            throw new Error("Chrome exited before opening the Ask sign-in profile. Fully quit any Chrome already using that profile, then retry `ask setup`.");
        }
        await (0, session_1.delayWithinDeadline)(authenticationPollInterval(dependencies), deadlineAt, timeoutMessage);
    }
}
/**
 * On Windows Chromium's profile ownership is represented by its lockfile and
 * message-window protocol, not the POSIX SingletonLock symlink. The only
 * portable evidence available to Ask is a browser-root process that explicitly
 * claims this user-data-dir. Require that evidence after spawning, then wait
 * for every matching root to disappear before handing the profile back to CDP.
 */
async function waitForWindowsAuthenticationChromeToExit(child, profileDir, deadlineAt, timeoutMessage, dependencies) {
    let sawLiveProfile = false;
    const startedAt = Date.now();
    while (true) {
        (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
        const profileProcesses = await getAuthenticationProfileProcesses(profileDir, deadlineAt, dependencies);
        if (profileProcesses === undefined) {
            throw new ChromeSessionConflictError("Ask could not verify the ordinary Chrome sign-in profile lifecycle on Windows. " +
                "Keep the tab open, fully quit the Ask Chrome window, then retry `ask setup`.");
        }
        const profileIsLive = profileProcesses.length > 0;
        sawLiveProfile ||= profileIsLive;
        if (sawLiveProfile && !profileIsLive) {
            return;
        }
        if (!sawLiveProfile &&
            (child.exitCode !== null || child.signalCode !== null) &&
            Date.now() - startedAt >= 2_000) {
            throw new Error("Chrome exited before opening the Ask sign-in profile. Fully quit any Chrome already using that profile, then retry `ask setup`.");
        }
        await (0, session_1.delayWithinDeadline)(authenticationPollInterval(dependencies), deadlineAt, timeoutMessage);
    }
}
function authenticationPlatform(dependencies) {
    return dependencies.platform || process.platform;
}
function authenticationPollInterval(dependencies) {
    const requested = dependencies.pollIntervalMs;
    return typeof requested === "number" && Number.isFinite(requested) && requested >= 0
        ? requested
        : 100;
}
async function getAuthenticationProfileProcesses(profileDir, deadlineAt, dependencies) {
    return (dependencies.getProfileProcesses || session_1.getChromeBrowserProcessesUsingProfile)(profileDir, { deadlineAt });
}
const launchedSessions = new Map();
/** Compatibility wrapper. Prefer ensureManagedChrome for the resolved endpoint. */
async function launchChrome(options = {}) {
    return (await ensureManagedChrome(options)).pid;
}
async function launchChromeUnlocked(options, disposition) {
    options = withLifecycleDeadline(options);
    const env = options.env || process.env;
    const deadlineAt = options.deadlineAt;
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, "Timed out before Google Chrome could be launched.");
    const chromePath = resolveChromePath(env);
    const selection = resolveChromePortSelection(options);
    const profileDir = (0, config_1.getChromeProfileDir)(env);
    const generation = (0, node_crypto_1.randomUUID)();
    const activePortBaseline = selection.portPolicy === "automatic"
        ? await captureDevToolsActivePortBaseline(env, deadlineAt)
        : undefined;
    if (selection.portPolicy === "automatic") {
        const activePort = await readDevToolsActivePort(env, { deadlineAt });
        if (activePort !== undefined) {
            const activeVersion = await getRemoteDebuggingVersion(activePort, { deadlineAt });
            if (activeVersion) {
                const classification = await classifySessionWithinDeadline(env, activePort, true, deadlineAt);
                if (classification.ownership === "ask-managed" ||
                    isEndpointUsingAskProfile(classification, activePort, profileDir)) {
                    throw new ChromeSessionConflictError(formatOwnershipError(activePort, classification));
                }
            }
        }
    }
    await (0, session_1.raceWithDeadline)(node_fs_1.default.promises.mkdir(profileDir, { recursive: true }), deadlineAt, "Timed out creating the ask Chrome profile directory.");
    await (0, session_1.writeProfileMarker)(env, { deadlineAt });
    const args = buildChromeArgs({
        ...options,
        env,
        port: selection.launchPort,
        desiredMode: launchMode(options),
        sessionGeneration: generation
    });
    if (options.verbose) {
        process.stderr.write(`Launching Chrome: ${chromePath} ${args.join(" ")}\n`);
    }
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, "Timed out before Google Chrome could be spawned.");
    const spawnOperation = spawnChromeProcess(chromePath, args);
    let launchedProcess;
    try {
        launchedProcess = await (0, session_1.raceWithDeadline)(spawnOperation, deadlineAt, "Timed out while launching Google Chrome.");
    }
    catch (error) {
        if (error instanceof session_1.DeadlineExceededError) {
            const lateSpawnCleanup = spawnOperation.then((child) => terminateSpawnedProcessAndWait(child), () => undefined);
            if (!(0, session_1.retainSessionLockUntil)(lateSpawnCleanup, env)) {
                await lateSpawnCleanup;
            }
        }
        throw error;
    }
    try {
        const launchedEndpoint = selection.portPolicy === "automatic"
            ? await waitForNewAutomaticLaunchEndpoint(env, profileDir, generation, activePortBaseline, deadlineAt)
            : undefined;
        const port = launchedEndpoint?.port ?? selection.port;
        await waitForRemoteDebugging(port, { deadlineAt });
        const version = launchedEndpoint?.version ?? await getRemoteDebuggingVersion(port, { deadlineAt });
        if (!version) {
            throw new Error(`Chrome assigned port ${port}, but its debugging endpoint is unavailable.`);
        }
        // Reject malformed or cross-port metadata before publishing session.json.
        const endpoint = browserWebSocketEndpoint(version, port);
        const processInfo = launchedEndpoint?.owner ?? await (0, session_1.raceWithDeadline)(resolveLaunchedProcessInfo(port, profileDir, selection.launchPort, generation), deadlineAt, `Timed out while verifying the Chrome process on port ${port}.`);
        const state = await (0, session_1.writeSessionState)(env, {
            pid: processInfo.pid,
            port,
            chromePath,
            headless: isHeadlessRemoteDebugging(version),
            processCreationTime: processInfo.creationTime,
            generation,
            portPolicy: selection.portPolicy,
            requestedPort: selection.launchPort
        }, { deadlineAt });
        const managedSession = managedSessionFromState(state, version, selection.portPolicy, disposition, processInfo.pid, endpoint);
        if (options.background && !isHeadlessRemoteDebugging(version)) {
            // Chrome's --start-minimized is only a hint and is ignored on some
            // platforms (notably macOS). Make background launch a verified CDP
            // postcondition before exposing the managed session to the caller.
            await minimizeManagedChromeEndpoint(port, version, deadlineAt);
        }
        launchedSessions.set(port, { env, generation });
        return managedSession;
    }
    catch (error) {
        const childExit = terminateSpawnedProcessAndWait(launchedProcess);
        if (!(0, session_1.retainSessionLockUntil)(childExit, env)) {
            await childExit;
        }
        // Do not clear session.json or DevToolsActivePort here. Atomic state
        // publication owns its own late cleanup while the lifecycle lease remains
        // held, and the next automatic launch safely clears any stale endpoint
        // before spawning. A detached failed-launch unlink could delete B's file.
        throw error;
    }
}
async function minimizeManagedChromeEndpoint(port, version, deadlineAt) {
    const browser = await connectOverCDPWithinDeadline(browserWebSocketEndpoint(version, port), deadlineAt, `Timed out connecting to background Chrome on port ${port}.`);
    try {
        await minimizeConnectedChromeWindows(browser, deadlineAt);
    }
    finally {
        await (0, session_1.raceWithDeadline)(browser.close(), deadlineAt, `Timed out detaching from background Chrome on port ${port}.`).catch(() => undefined);
    }
}
/** Enforces minimized placement for every headed window in a connected session. */
async function minimizeConnectedChromeWindows(browser, deadlineAt) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const windowIds = new Set();
    for (const page of pages) {
        const session = await (0, session_1.raceWithDeadline)(page.context().newCDPSession(page), deadlineAt, "Timed out opening a Chrome window-placement session.");
        try {
            const target = await (0, session_1.raceWithDeadline)(session.send("Browser.getWindowForTarget"), deadlineAt, "Timed out locating a managed Chrome window.");
            if (typeof target.windowId === "number" && !windowIds.has(target.windowId)) {
                windowIds.add(target.windowId);
                await (0, session_1.raceWithDeadline)(session.send("Browser.setWindowBounds", {
                    windowId: target.windowId,
                    bounds: { windowState: "minimized" }
                }), deadlineAt, "Timed out minimizing a managed Chrome window.");
            }
        }
        finally {
            await session.detach().catch(() => undefined);
        }
    }
    if (windowIds.size === 0) {
        throw new Error("Chrome launched for background execution without an inspectable window.");
    }
}
async function captureDevToolsActivePortBaseline(env, deadlineAt) {
    const port = await readDevToolsActivePort(env, { deadlineAt });
    return {
        port,
        owner: port === undefined ? undefined : await (0, session_1.getPortOwnerProcessInfo)(port)
    };
}
async function waitForNewAutomaticLaunchEndpoint(env, profileDir, generation, baseline, deadlineAt) {
    const timeoutMessage = "Chrome did not publish a verifiable fresh automatic debugging endpoint in time.";
    const effectiveDeadlineAt = automaticRecoveryDeadline(deadlineAt);
    while ((0, session_1.remainingDeadlineMs)(effectiveDeadlineAt) > 0) {
        const port = await readDevToolsActivePort(env, { deadlineAt: effectiveDeadlineAt });
        if (port !== undefined) {
            const version = await getRemoteDebuggingVersion(port, { deadlineAt: effectiveDeadlineAt });
            const owner = version ? await (0, session_1.getPortOwnerProcessInfo)(port) : undefined;
            if (version &&
                isValidBrowserEndpoint(version, port) &&
                owner &&
                owner.creationTime &&
                (0, session_1.processMatchesAskSession)(owner, 0, profileDir, generation) &&
                !isBaselineEndpointOwner(owner, port, baseline)) {
                return { port, version, owner };
            }
        }
        await (0, session_1.delayWithinDeadline)(50, effectiveDeadlineAt, timeoutMessage);
    }
    throw new session_1.DeadlineExceededError(timeoutMessage);
}
function isBaselineEndpointOwner(owner, port, baseline) {
    // A prior endpoint can remain in DevToolsActivePort after a crashed launch.
    // Never treat that baseline owner as fresh; a new launch must additionally
    // carry the newly minted generation above.
    return Boolean(baseline &&
        baseline.port === port &&
        baseline.owner &&
        baseline.owner.pid === owner.pid &&
        baseline.owner.creationTime === owner.creationTime);
}
async function spawnChromeProcess(chromePath, args) {
    const child = (0, node_child_process_1.spawn)(chromePath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true
    });
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            reject(new Error(`Could not launch Google Chrome: ${error.message}`, { cause: error }));
        };
        child.once("error", onError);
        child.once("spawn", () => {
            child.off("error", onError);
            // Avoid an uncaught process-level error if the detached child reports a
            // later failure after the successful spawn event.
            child.on("error", () => undefined);
            if (!child.pid) {
                reject(new Error("Chrome launched but did not report a process id."));
                return;
            }
            child.unref();
            resolve(child);
        });
    });
}
async function terminateSpawnedProcessAndWait(child) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const exited = new Promise((resolve) => {
        child.once("exit", () => resolve());
    });
    if (!child.killed) {
        try {
            child.kill("SIGTERM");
        }
        catch {
            // The exact spawned child may have exited between the status check and
            // signal. Its exit event/status remains the ownership boundary.
        }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await exited;
}
function launchMode(options) {
    const desiredMode = resolveChromeMode(options);
    return desiredMode === "headless" ? "headless" : "visible";
}
async function resolveLaunchedProcessInfo(port, profileDir, launchPort, generation) {
    const portOwner = await (0, session_1.getPortOwnerProcessInfo)(port);
    if (portOwner && (0, session_1.processMatchesAskSession)(portOwner, launchPort, profileDir, generation)) {
        return portOwner;
    }
    throw new ChromeSessionConflictError(`Chrome debugging on port ${port} became ready, but its listening process could not be verified as this ask launch.`);
}
async function closeChromeOnPort(port, options = {}) {
    options = withLifecycleDeadline(options);
    const launched = launchedSessions.get(port);
    const env = options.env || launched?.env || process.env;
    const deadlineAt = options.deadlineAt;
    await (0, session_1.withSessionLock)(env, async () => {
        const version = await getRemoteDebuggingVersion(port, { deadlineAt });
        if (!version) {
            await reclaimDeliveryAmbiguitiesForStoppedProfile(env, deadlineAt);
            launchedSessions.delete(port);
            return;
        }
        const classification = await classifySessionWithinDeadline(env, port, true, deadlineAt);
        if (classification.ownership !== "ask-managed") {
            throw new ChromeSessionConflictError(formatOwnershipError(port, classification));
        }
        await closeManagedChromeEndpoint(port, version, env, deadlineAt, classification.state?.generation);
        await waitForRemoteDebuggingToClose(port, { deadlineAt });
        launchedSessions.delete(port);
    }, { deadlineAt });
}
async function closeManagedChromeEndpoint(port, version, env, deadlineAt, sessionGeneration) {
    const browser = await connectOverCDPWithinDeadline(browserWebSocketEndpoint(version, port), deadlineAt, `Timed out connecting to the managed Chrome session on port ${port}.`);
    try {
        const session = await (0, session_1.raceWithDeadline)(browser.newBrowserCDPSession(), deadlineAt, `Timed out opening a Chrome DevTools session on port ${port}.`);
        await assertNoLiveDeliveryAmbiguityBeforeClose(session, env, sessionGeneration, deadlineAt);
        const closeOperation = session.send("Browser.close");
        try {
            await (0, session_1.raceWithDeadline)(closeOperation, deadlineAt, `Timed out closing the managed Chrome session on port ${port}.`);
        }
        catch (error) {
            if (error instanceof session_1.DeadlineExceededError) {
                // The CDP command has already crossed the irreversible boundary. Keep
                // the lifecycle lease published until it settles so a late close cannot
                // terminate a successor that reused or restarted this session.
                if (!(0, session_1.retainSessionLockUntil)(closeOperation, env)) {
                    await closeOperation.catch(() => undefined);
                }
            }
            throw error;
        }
    }
    finally {
        await (0, session_1.raceWithDeadline)(browser.close(), deadlineAt, `Timed out detaching from the managed Chrome session on port ${port}.`).catch(() => undefined);
    }
}
/**
 * Browser.close is the only irreversible browser lifecycle action. Resolve
 * every durable (and same-process fallback) ambiguity marker while the caller
 * holds the lifecycle lock, reclaim only entries proven stale, and reject the
 * close when a target from the current generation still exists.
 */
async function assertNoLiveDeliveryAmbiguityBeforeClose(session, env, sessionGeneration, deadlineAt) {
    let markers;
    try {
        markers = await (0, delivery_ambiguity_1.listDeliveryAmbiguityMarkers)(env, { deadlineAt });
    }
    catch (error) {
        const detail = error instanceof delivery_ambiguity_1.DeliveryAmbiguityPersistenceError
            ? error.message
            : "Ask could not inspect uncertain prompt-delivery markers.";
        throw new ChromeSessionConflictError(`${detail} Chrome will remain open so an uncertain prompt cannot be lost.`);
    }
    if (markers.length === 0) {
        return;
    }
    if (!sessionGeneration) {
        throw new ChromeSessionConflictError("Ask cannot verify the live Chrome session generation against a preserved uncertain prompt tab, so it will not close Chrome automatically.");
    }
    const staleGeneration = markers.filter((marker) => marker.sessionGeneration !== sessionGeneration);
    await reclaimDeliveryAmbiguityMarkersOrFailClosed(env, staleGeneration, deadlineAt);
    const currentGeneration = markers.filter((marker) => marker.sessionGeneration === sessionGeneration);
    if (currentGeneration.length === 0) {
        return;
    }
    let targets;
    try {
        const response = await (0, session_1.raceWithDeadline)(session.send("Target.getTargets"), deadlineAt, "Timed out checking preserved uncertain prompt tabs before closing Chrome.");
        if (!Array.isArray(response.targetInfos)) {
            throw new Error("Chrome did not return target metadata.");
        }
        targets = new Set(response.targetInfos
            .map((target) => target.targetId)
            .filter((targetId) => typeof targetId === "string" && targetId.length > 0));
    }
    catch (error) {
        throw new ChromeSessionConflictError("Ask could not verify whether a preserved uncertain prompt tab is still open, so it will not close Chrome automatically.");
    }
    const live = currentGeneration.filter((marker) => targets.has(marker.targetId));
    const closed = currentGeneration.filter((marker) => !targets.has(marker.targetId));
    // Multiple uncertain sends can coexist. Reclaim independently proven stale
    // tabs even when another marker must still block this close.
    await reclaimDeliveryAmbiguityMarkersOrFailClosed(env, closed, deadlineAt);
    if (live.length > 0) {
        throw new ChromeSessionConflictError("A preserved tab has an uncertain prompt delivery in this Ask Chrome session. " +
            "Inspect that tab, close the tab yourself when resolved, then retry the requested Chrome mode or setup operation.");
    }
}
async function reclaimDeliveryAmbiguityMarkersOrFailClosed(env, markers, deadlineAt) {
    try {
        for (const marker of markers) {
            await (0, delivery_ambiguity_1.reclaimDeliveryAmbiguityMarker)(env, marker, { deadlineAt });
        }
    }
    catch {
        throw new ChromeSessionConflictError("Ask could not safely reclaim a stale uncertain prompt-delivery marker, so it will not close Chrome automatically.");
    }
}
async function reclaimDeliveryAmbiguitiesForStoppedProfile(env, deadlineAt) {
    const state = await (0, session_1.readSessionState)(env, { deadlineAt });
    const profileDir = state?.profileDir || (0, config_1.getChromeProfileDir)(env);
    const roots = await (0, session_1.getChromeBrowserProcessesUsingProfile)(profileDir, { deadlineAt });
    // An unavailable process table or even one remaining profile root is not
    // enough proof that the session is gone. Leave markers untouched; this path
    // has no Browser.close to perform.
    if (roots === undefined || roots.length > 0) {
        return;
    }
    const markers = await (0, delivery_ambiguity_1.listDeliveryAmbiguityMarkers)(env, { deadlineAt });
    for (const marker of markers) {
        await (0, delivery_ambiguity_1.reclaimDeliveryAmbiguityMarker)(env, marker, { deadlineAt });
    }
}
async function getChromeSessionClassification(options = {}) {
    return (await inspectChromeSession(options)).classification;
}
async function inspectChromeSession(options = {}) {
    options = withLifecycleDeadline(options);
    const env = options.env || process.env;
    const deadlineAt = options.deadlineAt;
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, "Timed out before the Chrome session could be inspected.");
    validateStrictChromePath(env);
    const selection = resolveChromePortSelection(options);
    await assertNoPinnedSessionMismatch(env, selection, deadlineAt);
    // Status uses this inspection path and must remain read-only. Observe both
    // persisted state and DevToolsActivePort, but leave automatic drift repair
    // to mutating/recovery-capable command paths such as ensureManagedChrome.
    const state = await (0, session_1.readSessionState)(env, { deadlineAt });
    const activePort = selection.portPolicy === "automatic"
        ? await readDevToolsActivePort(env, { deadlineAt })
        : undefined;
    let prefetchedVersion;
    if (activePort !== undefined && activePort !== state?.port) {
        prefetchedVersion = await getRemoteDebuggingVersion(activePort, { deadlineAt });
    }
    const candidatePort = selection.portPolicy === "pinned"
        ? selection.port
        // A stale DevToolsActivePort file is not an assigned managed endpoint on
        // its own. Only expose a fresh reachable endpoint or a port persisted in
        // session.json; otherwise status should continue to report "port auto".
        : prefetchedVersion ? activePort : state?.port;
    if (candidatePort === undefined) {
        return {
            portPolicy: selection.portPolicy,
            connected: false,
            classification: { ownership: "absent", reason: "No automatic Chrome debugging endpoint has been assigned." }
        };
    }
    const version = candidatePort === activePort && prefetchedVersion
        ? prefetchedVersion
        : await getRemoteDebuggingVersion(candidatePort, { deadlineAt });
    const classification = await classifySessionWithinDeadline(env, candidatePort, Boolean(version), deadlineAt);
    if (!version) {
        return {
            port: candidatePort,
            portPolicy: selection.portPolicy,
            connected: false,
            classification
        };
    }
    const mode = modeFromVersion(version);
    const managedSession = classification.ownership === "ask-managed" && classification.state
        ? managedSessionFromVerifiedState(env, classification.state, version, selection.portPolicy, "reused", classification.process?.pid)
        : undefined;
    return {
        port: candidatePort,
        portPolicy: selection.portPolicy,
        connected: true,
        classification,
        mode,
        headless: mode === "headless",
        browser: typeof version.Browser === "string" ? version.Browser : undefined,
        userAgent: typeof version["User-Agent"] === "string" ? version["User-Agent"] : undefined,
        managedSession
    };
}
async function ensureManagedChrome(options = {}) {
    options = withLifecycleDeadline(options);
    const env = options.env || process.env;
    const deadlineAt = options.deadlineAt;
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, "Timed out before the Chrome session could be prepared.");
    validateStrictChromePath(env);
    const selection = resolveChromePortSelection(options);
    await assertNoPinnedSessionMismatch(env, selection, deadlineAt);
    // A known external endpoint requires no lifecycle mutation. Reject it before
    // touching the lock (and, importantly, before ever considering Browser.close).
    await rejectConnectedExternalEndpoint(env, selection, options);
    return (0, session_1.withSessionLock)(env, async () => {
        await assertNoPinnedSessionMismatch(env, selection, deadlineAt);
        const reconciliation = selection.portPolicy === "automatic"
            ? await reconcileAutomaticChromeSessionUnlocked(env, automaticRecoveryDeadline(deadlineAt))
            : undefined;
        const state = reconciliation?.state ?? await (0, session_1.readSessionState)(env, { deadlineAt });
        const candidatePort = selection.portPolicy === "pinned"
            ? selection.port
            : state?.port ?? reconciliation?.activePort;
        if (candidatePort !== undefined) {
            const version = await getRemoteDebuggingVersion(candidatePort, { deadlineAt });
            if (version) {
                const classification = await classifySessionWithinDeadline(env, candidatePort, true, deadlineAt);
                if (classification.ownership !== "ask-managed" || !classification.state) {
                    if (selection.portPolicy === "pinned" ||
                        isEndpointUsingAskProfile(classification, candidatePort, (0, config_1.getChromeProfileDir)(env))) {
                        const desiredMode = resolveChromeMode(options);
                        if (desiredMode !== "preserve" && shouldRestartChromeForMode(version, options)) {
                            throw new ChromeSessionConflictError(formatModeConflict(candidatePort, version, desiredMode, classification));
                        }
                        throw new ChromeSessionConflictError(formatOwnershipError(candidatePort, classification));
                    }
                }
                else {
                    const restartRequired = shouldRestartManagedChromeForRequest(version, classification.process, options);
                    if (!restartRequired) {
                        return managedSessionFromVerifiedState(env, classification.state, version, selection.portPolicy, "reused", classification.process?.pid);
                    }
                    // Validate strict path configuration before closing the verified
                    // managed process for a mode or background-capability restart. The
                    // ownership classification above is deliberately required before
                    // this Browser.close path; external Chrome is never adopted.
                    managedSessionFromVerifiedState(env, classification.state, version, selection.portPolicy, "reused", classification.process?.pid);
                    await closeManagedChromeEndpoint(candidatePort, version, env, deadlineAt, classification.state.generation);
                    await waitForRemoteDebuggingToClose(candidatePort, { deadlineAt });
                    launchedSessions.delete(candidatePort);
                    return launchChromeUnlocked({ ...options, env, port: selection.launchPort }, "restarted");
                }
            }
            else {
                await rejectPinnedNonCdpListener(selection, deadlineAt);
            }
        }
        return launchChromeUnlocked({ ...options, env, port: selection.launchPort }, "launched");
    }, { deadlineAt });
}
async function rejectConnectedExternalEndpoint(env, selection, options) {
    const reconciliation = selection.portPolicy === "automatic"
        ? await reconcileAutomaticChromeSession(env, { deadlineAt: options.deadlineAt })
        : undefined;
    const state = reconciliation?.state ?? await (0, session_1.readSessionState)(env, { deadlineAt: options.deadlineAt });
    const candidatePort = selection.portPolicy === "pinned"
        ? selection.port
        : state?.port ?? reconciliation?.activePort;
    if (candidatePort === undefined) {
        return;
    }
    const version = await getRemoteDebuggingVersion(candidatePort, { deadlineAt: options.deadlineAt });
    if (!version) {
        await rejectPinnedNonCdpListener(selection, options.deadlineAt);
        return;
    }
    const classification = await classifySessionWithinDeadline(env, candidatePort, true, options.deadlineAt);
    if (classification.ownership === "ask-managed") {
        return;
    }
    if (selection.portPolicy === "automatic" &&
        !isEndpointUsingAskProfile(classification, candidatePort, (0, config_1.getChromeProfileDir)(env))) {
        return;
    }
    const desiredMode = resolveChromeMode(options);
    if (desiredMode !== "preserve" && shouldRestartChromeForMode(version, options)) {
        throw new ChromeSessionConflictError(formatModeConflict(candidatePort, version, desiredMode, classification));
    }
    throw new ChromeSessionConflictError(formatOwnershipError(candidatePort, classification));
}
async function rejectPinnedNonCdpListener(selection, deadlineAt) {
    if (selection.portPolicy === "pinned" &&
        selection.port !== undefined &&
        await isTcpPortListening(selection.port, deadlineAt)) {
        throw new ChromeSessionConflictError(`Chrome debugging port ${selection.port} is already occupied by a service that does not expose ` +
            "Chrome remote debugging metadata at /json/version.");
    }
}
async function isTcpPortListening(port, deadlineAt) {
    const timeoutMessage = `Timed out checking whether Chrome debugging port ${port} is occupied.`;
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
    const probeDeadlineAt = Math.min(deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + 250);
    let socket;
    const connection = new Promise((resolve) => {
        socket = node_net_1.default.createConnection({ host: "127.0.0.1", port });
        socket.unref();
        socket.once("connect", () => resolve(true));
        socket.once("error", () => resolve(false));
    });
    try {
        return await (0, session_1.raceWithDeadline)(connection, probeDeadlineAt, timeoutMessage);
    }
    catch (error) {
        if (error instanceof session_1.DeadlineExceededError) {
            if (deadlineAt !== undefined && (0, session_1.remainingDeadlineMs)(deadlineAt) === 0) {
                throw new session_1.DeadlineExceededError(timeoutMessage);
            }
            return false;
        }
        throw error;
    }
    finally {
        socket?.destroy();
    }
}
function isEndpointUsingAskProfile(classification, port, profileDir) {
    const owner = classification.process;
    return Boolean(owner &&
        ((0, session_1.processMatchesAskSession)(owner, port, profileDir) || (0, session_1.processMatchesAskSession)(owner, 0, profileDir)));
}
async function ensureChrome(options = {}) {
    return (await ensureManagedChrome(options)).port;
}
async function getChromeConnectionDescriptor(options = {}) {
    options = withLifecycleDeadline(options);
    const session = options.launchIfNeeded === false
        ? await getExistingManagedChrome(options)
        : await ensureManagedChrome(options);
    return { endpoint: session.endpoint, session };
}
async function getExistingManagedChrome(options) {
    const inspection = await inspectChromeSession(options);
    if (!inspection.connected || inspection.port === undefined) {
        const portDescription = inspection.port === undefined ? "an automatic port" : `port ${inspection.port}`;
        throw new Error(`No ask-managed Chrome debugging session is available on ${portDescription}. Run 'ask login' first.`);
    }
    if (inspection.classification.ownership !== "ask-managed" || !inspection.managedSession) {
        throw new ChromeSessionConflictError(formatOwnershipError(inspection.port, inspection.classification));
    }
    if (shouldRestartChromeForMode({ Browser: inspection.browser, "User-Agent": inspection.userAgent }, options)) {
        const desiredMode = resolveChromeMode(options);
        throw new ChromeSessionConflictError(`The ask-managed Chrome session on port ${inspection.port} is ${inspection.mode}, ` +
            `but ${desiredMode} mode was requested and launchIfNeeded is false.`);
    }
    if (options.background === true && !hasBackgroundExecutionCapability(inspection.classification.process)) {
        throw new ChromeSessionConflictError(`${formatBackgroundCapabilityConflict(inspection.port)} ` +
            "Run the command without launchIfNeeded=false so Ask can restart this verified session, or close it explicitly first.");
    }
    return inspection.managedSession;
}
async function connectToChrome(options = {}) {
    options = withLifecycleDeadline(options);
    const env = options.env || process.env;
    const deadlineAt = options.deadlineAt;
    const descriptor = await getChromeConnectionDescriptor({ ...options, env });
    // Close the inspection/connection TOCTOU window as far as a port-based API
    // permits: ownership must still match immediately before CDP attachment.
    const version = await getRemoteDebuggingVersion(descriptor.session.port, { deadlineAt });
    const classification = await classifySessionWithinDeadline(env, descriptor.session.port, Boolean(version), deadlineAt);
    if (!version || classification.ownership !== "ask-managed") {
        throw new ChromeSessionConflictError(formatOwnershipError(descriptor.session.port, classification));
    }
    if (options.verbose) {
        process.stderr.write(`Connecting to Chrome CDP: ${descriptor.endpoint}\n`);
    }
    return connectOverCDPWithinDeadline(browserWebSocketEndpoint(version, descriptor.session.port), deadlineAt, `Timed out connecting to Chrome CDP on port ${descriptor.session.port}.`);
}
async function assertNoPinnedSessionMismatch(env, selection, deadlineAt) {
    if (selection.portPolicy !== "pinned" || selection.port === undefined) {
        return;
    }
    const state = await (0, session_1.readSessionState)(env, { deadlineAt });
    if (!state || state.port === selection.port) {
        return;
    }
    // A persisted automatic session may have restarted onto the profile's fresh
    // DevToolsActivePort. A pinned request must never migrate that state, but it
    // also must not launch another Chrome against the same profile just because
    // session.json still names the former port.
    if (isPersistedAutomaticSession(state)) {
        const activePort = await readDevToolsActivePort(env, { deadlineAt });
        if (activePort !== undefined && activePort !== selection.port && activePort !== state.port) {
            const activeVersion = await getRemoteDebuggingVersion(activePort, { deadlineAt });
            const activeOwner = activeVersion ? await (0, session_1.getPortOwnerProcessInfo)(activePort) : undefined;
            if (activeOwner && (0, session_1.processUsesChromeProfile)(activeOwner, state.profileDir)) {
                if (state.generation &&
                    activeOwner.creationTime &&
                    (0, session_1.processMatchesAskSession)(activeOwner, 0, state.profileDir, state.generation) &&
                    await (0, session_1.hasProfileMarker)(env, { deadlineAt })) {
                    throw new ChromeSessionConfigMismatchError(`ASK_REMOTE_DEBUGGING_PORT pins port ${selection.port}, but the live ask-managed Chrome session uses port ${activePort}. ` +
                        "Close that ask session or unset ASK_REMOTE_DEBUGGING_PORT before retrying.");
                }
                throw new ChromeSessionConflictError("The Ask Chrome profile is in use by an unverified automatic debugging session; Ask will not migrate or replace it for a pinned port.");
            }
        }
    }
    const version = await getRemoteDebuggingVersion(state.port, { deadlineAt });
    if (!version) {
        return;
    }
    const classification = await classifySessionWithinDeadline(env, state.port, true, deadlineAt);
    if (classification.ownership === "ask-managed") {
        throw new ChromeSessionConfigMismatchError(`ASK_REMOTE_DEBUGGING_PORT pins port ${selection.port}, but the live ask-managed Chrome session uses port ${state.port}. ` +
            "Close that ask session or unset ASK_REMOTE_DEBUGGING_PORT before retrying.");
    }
}
async function classifySessionWithinDeadline(env, port, debuggingConnected, deadlineAt) {
    return (0, session_1.raceWithDeadline)((0, session_1.classifySession)(env, port, debuggingConnected, { deadlineAt }), deadlineAt, `Timed out while verifying ownership of Chrome debugging on port ${port}.`);
}
async function connectOverCDPWithinDeadline(endpoint, deadlineAt, timeoutMessage) {
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
    const remainingMs = (0, session_1.remainingDeadlineMs)(deadlineAt);
    // Chrome can keep the debugging endpoint alive after its last window is
    // closed. In that state Playwright's default download initialization sends
    // Browser.setDownloadBehavior with a context id that Chrome rejects, even
    // though the endpoint can still create a new page. Playwright forwards this
    // internal CDP option to preserve the browser's download defaults and avoid
    // that context-management command. Keep the cast local so an upstream API
    // change is caught by the real contextless-session regression test.
    const connectOverCDP = playwright_core_1.chromium.connectOverCDP.bind(playwright_core_1.chromium);
    const connection = connectOverCDP(endpoint, {
        noDefaults: true,
        ...(remainingMs === undefined ? {} : { timeout: Math.max(1, remainingMs) })
    });
    return (0, session_1.raceWithDeadline)(connection, deadlineAt, timeoutMessage, (lateBrowser) => lateBrowser.close().catch(() => undefined));
}
function managedSessionFromState(state, version, portPolicy, disposition, verifiedPid, validatedEndpoint) {
    return {
        port: state.port,
        endpoint: validatedEndpoint || browserWebSocketEndpoint(version, state.port),
        pid: verifiedPid || state.pid,
        chromePath: state.chromePath,
        profileDir: state.profileDir,
        mode: modeFromVersion(version),
        portPolicy,
        disposition,
        generation: state.generation
    };
}
function managedSessionFromVerifiedState(env, state, version, portPolicy, disposition, verifiedPid) {
    const configuredPath = validateStrictChromePath(env);
    if (configuredPath !== undefined &&
        (0, session_1.normalizePathForCompare)(configuredPath) !== (0, session_1.normalizePathForCompare)(state.chromePath)) {
        throw new ChromeSessionConfigMismatchError(`ASK_CHROME_PATH points to ${configuredPath}, but the live ask-managed session uses ${state.chromePath}.`);
    }
    return managedSessionFromState(state, version, portPolicy, disposition, verifiedPid);
}
function validateStrictChromePath(env) {
    return env.ASK_CHROME_PATH !== undefined ? resolveChromePath(env) : undefined;
}
function endpointForPort(port) {
    return `http://127.0.0.1:${port}`;
}
function browserWebSocketEndpoint(version, port) {
    if (typeof version.webSocketDebuggerUrl !== "string") {
        throw new ChromeSessionConflictError(`Chrome debugging on port ${port} did not provide a browser WebSocket endpoint for a verified connection.`);
    }
    try {
        const endpoint = new URL(version.webSocketDebuggerUrl);
        const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
        if (endpoint.protocol !== "ws:" ||
            !loopbackHosts.has(endpoint.hostname) ||
            Number(endpoint.port) !== port ||
            !endpoint.pathname.startsWith("/devtools/browser/")) {
            throw new Error("unexpected endpoint");
        }
        return endpoint.toString();
    }
    catch {
        throw new ChromeSessionConflictError(`Chrome debugging on port ${port} returned an invalid browser WebSocket endpoint.`);
    }
}
function delay(timeoutMs) {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
