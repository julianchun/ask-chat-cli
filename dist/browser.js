"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChromeSessionConflictError = void 0;
exports.createChromeSessionController = createChromeSessionController;
exports.getChromeCandidates = getChromeCandidates;
exports.resolveChromePath = resolveChromePath;
exports.isRemoteDebuggingReady = isRemoteDebuggingReady;
exports.getRemoteDebuggingVersion = getRemoteDebuggingVersion;
exports.isHeadlessRemoteDebugging = isHeadlessRemoteDebugging;
exports.shouldRestartChromeForMode = shouldRestartChromeForMode;
exports.waitForRemoteDebugging = waitForRemoteDebugging;
exports.waitForRemoteDebuggingToClose = waitForRemoteDebuggingToClose;
exports.buildChromeArgs = buildChromeArgs;
exports.launchChrome = launchChrome;
exports.closeChromeOnPort = closeChromeOnPort;
exports.getChromeSessionClassification = getChromeSessionClassification;
exports.inspectChromeSession = inspectChromeSession;
exports.ensureChrome = ensureChrome;
exports.connectToChrome = connectToChrome;
const node_fs_1 = __importDefault(require("node:fs"));
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
const playwright_core_1 = require("playwright-core");
const config_1 = require("./config");
const session_1 = require("./session");
class ChromeSessionConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "ChromeSessionConflictError";
    }
}
exports.ChromeSessionConflictError = ChromeSessionConflictError;
function createChromeSessionController(env = process.env) {
    return {
        connect: (options = {}) => connectToChrome({ ...options, env }),
        inspect: (options = {}) => inspectChromeSession({ ...options, env }),
        waitUntilReady: (timeoutMs = 15_000) => waitForRemoteDebugging((0, config_1.getRemoteDebuggingPort)(env), timeoutMs)
    };
}
function getChromeCandidates(env = process.env) {
    const candidates = [
        env.ProgramFiles && node_path_1.default.win32.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
        env["ProgramFiles(x86)"] && node_path_1.default.win32.join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
        env.LocalAppData && node_path_1.default.win32.join(env.LocalAppData, "Google", "Chrome", "Application", "chrome.exe")
    ];
    return candidates.filter((candidate) => Boolean(candidate));
}
function resolveChromePath(env = process.env, exists = node_fs_1.default.existsSync) {
    if (env.ASK_CHROME_PATH) {
        if (!exists(env.ASK_CHROME_PATH)) {
            throw new Error(`ASK_CHROME_PATH does not exist: ${env.ASK_CHROME_PATH}`);
        }
        return env.ASK_CHROME_PATH;
    }
    const match = getChromeCandidates(env).find((candidate) => exists(candidate));
    if (!match) {
        throw new Error("Google Chrome was not found. Set ASK_CHROME_PATH to chrome.exe.");
    }
    return match;
}
async function isRemoteDebuggingReady(port) {
    return Boolean(await getRemoteDebuggingVersion(port));
}
async function getRemoteDebuggingVersion(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok) {
            return undefined;
        }
        const body = await response.json();
        return body && typeof body === "object" ? body : {};
    }
    catch {
        return undefined;
    }
}
function isHeadlessRemoteDebugging(version) {
    const browser = typeof version.Browser === "string" ? version.Browser : "";
    const userAgent = typeof version["User-Agent"] === "string" ? version["User-Agent"] : "";
    return browser.includes("HeadlessChrome/") || userAgent.includes("HeadlessChrome/");
}
function shouldRestartChromeForMode(version, options) {
    const currentlyHeadless = isHeadlessRemoteDebugging(version);
    return ((options.headless === true && !currentlyHeadless) ||
        (options.requireVisible === true && currentlyHeadless));
}
function formatOwnershipError(port, classification) {
    return (`Chrome remote debugging on port ${port} is not an ask-managed session (${classification.ownership}). ` +
        `${classification.reason || "The session could not be verified."} ` +
        "Run `ask status` to inspect it, or set ASK_REMOTE_DEBUGGING_PORT/ASK_HOME for a separate ask session.");
}
async function ensureManagedSession(env, port, version) {
    const classification = await (0, session_1.classifySession)(env, port, true);
    if (classification.ownership !== "ask-managed") {
        throw new ChromeSessionConflictError(formatOwnershipError(port, classification));
    }
    if (!classification.state && classification.process) {
        await (0, session_1.writeProfileMarker)(env);
        await (0, session_1.writeSessionState)(env, {
            pid: classification.process.pid,
            port,
            chromePath: classification.process.executablePath || resolveChromePath(env),
            headless: isHeadlessRemoteDebugging(version),
            processCreationTime: classification.process.creationTime
        });
    }
    return classification;
}
async function assertRemoteDebuggingCompatible(port, version, options) {
    const env = options.env || process.env;
    if (options.requireManaged) {
        await ensureManagedSession(env, port, version);
    }
    const currentlyHeadless = isHeadlessRemoteDebugging(version);
    const requestedHeadless = options.headless === true;
    const modeMismatch = shouldRestartChromeForMode(version, options);
    if (!modeMismatch) {
        return;
    }
    const classification = await (0, session_1.classifySession)(env, port, true);
    if (classification.ownership === "ask-managed") {
        await restartInMode(port, options, requestedHeadless);
        return;
    }
    const currentMode = currentlyHeadless ? "headless" : "visible";
    const requestedMode = requestedHeadless ? "headless" : "visible";
    throw new ChromeSessionConflictError(`Chrome remote debugging on port ${port} is already attached to a ${currentMode} Chrome session, ` +
        `but ${requestedMode} mode was requested and it is not safe to replace the session automatically ` +
        `(${classification.ownership}). ` +
        `${classification.reason || "The session could not be verified."} Run \`ask status\` to inspect it.`);
}
async function waitForRemoteDebugging(port, timeoutMs = 15_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await isRemoteDebuggingReady(port)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Chrome remote debugging did not become ready on port ${port}. ` +
        "Run `ask login` again to restart the dedicated ask Chrome profile.");
}
async function waitForRemoteDebuggingToClose(port, timeoutMs = 10_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (!(await isRemoteDebuggingReady(port))) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Chrome remote debugging on port ${port} did not close in time.`);
}
function buildChromeArgs(options = {}) {
    const env = options.env || process.env;
    const port = options.port || (0, config_1.getRemoteDebuggingPort)(env);
    const profileDir = (0, config_1.getChromeProfileDir)(env);
    const args = [
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check"
    ];
    if (options.headless) {
        args.push("--headless=new");
    }
    else {
        args.push("--new-window");
    }
    args.push(options.url || "about:blank");
    return args;
}
async function launchChrome(options = {}) {
    const env = options.env || process.env;
    const chromePath = resolveChromePath(env);
    const port = options.port || (0, config_1.getRemoteDebuggingPort)(env);
    node_fs_1.default.mkdirSync((0, config_1.getChromeProfileDir)(env), { recursive: true });
    await (0, session_1.writeProfileMarker)(env);
    const args = buildChromeArgs({ ...options, port });
    if (options.verbose) {
        process.stderr.write(`Launching Chrome: ${chromePath} ${args.join(" ")}\n`);
    }
    const child = (0, node_child_process_1.spawn)(chromePath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true
    });
    child.unref();
    const pid = child.pid;
    if (!pid) {
        throw new Error("Chrome launched but did not report a process id.");
    }
    const processInfo = await (0, session_1.getProcessInfo)(pid);
    await (0, session_1.writeSessionState)(env, {
        pid,
        port,
        chromePath,
        headless: Boolean(options.headless),
        processCreationTime: processInfo?.creationTime
    });
    return pid;
}
async function closeChromeOnPort(port, options = {}) {
    const browser = await playwright_core_1.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
        const session = await browser.newBrowserCDPSession();
        await session.send("Browser.close");
    }
    finally {
        await browser.close().catch(() => undefined);
    }
}
async function restartInMode(port, options, headless) {
    const env = options.env || process.env;
    await (0, session_1.withSessionLock)(env, async () => {
        const currentVersion = await getRemoteDebuggingVersion(port);
        if (currentVersion && isHeadlessRemoteDebugging(currentVersion) === headless) {
            return;
        }
        if (currentVersion) {
            await closeChromeOnPort(port, options);
            await waitForRemoteDebuggingToClose(port);
        }
        await launchChrome({ ...options, env, port, headless });
        await waitForRemoteDebugging(port);
    });
}
async function getChromeSessionClassification(options = {}) {
    const env = options.env || process.env;
    const port = options.port || (0, config_1.getRemoteDebuggingPort)(env);
    return (0, session_1.classifySession)(env, port, Boolean(await getRemoteDebuggingVersion(port)));
}
async function inspectChromeSession(options = {}) {
    const env = options.env || process.env;
    const port = options.port || (0, config_1.getRemoteDebuggingPort)(env);
    const version = await getRemoteDebuggingVersion(port);
    const classification = await (0, session_1.classifySession)(env, port, Boolean(version));
    if (!version) {
        return { port, connected: false, classification };
    }
    return {
        port,
        connected: true,
        classification,
        headless: isHeadlessRemoteDebugging(version),
        browser: typeof version.Browser === "string" ? version.Browser : undefined,
        userAgent: typeof version["User-Agent"] === "string" ? version["User-Agent"] : undefined
    };
}
async function ensureChrome(options = {}) {
    const env = options.env || process.env;
    const port = options.port || (0, config_1.getRemoteDebuggingPort)(env);
    const existingVersion = await getRemoteDebuggingVersion(port);
    if (existingVersion) {
        await assertRemoteDebuggingCompatible(port, existingVersion, { ...options, env, port });
        return port;
    }
    await (0, session_1.withSessionLock)(env, async () => {
        const racedVersion = await getRemoteDebuggingVersion(port);
        if (racedVersion) {
            await assertRemoteDebuggingCompatible(port, racedVersion, { ...options, env, port });
            return;
        }
        await launchChrome({ ...options, env, port });
        await waitForRemoteDebugging(port);
        const launchedVersion = await getRemoteDebuggingVersion(port);
        if (launchedVersion) {
            await assertRemoteDebuggingCompatible(port, launchedVersion, { ...options, env, port });
        }
    });
    return port;
}
async function connectToChrome(options = {}) {
    const env = options.env || process.env;
    const port = options.port || (0, config_1.getRemoteDebuggingPort)(env);
    if (options.launchIfNeeded === false) {
        const version = await getRemoteDebuggingVersion(port);
        if (!version) {
            throw new Error(`No Chrome debugging session is available on port ${port}. Run 'ask login' first.`);
        }
        await assertRemoteDebuggingCompatible(port, version, { ...options, env, port });
    }
    else {
        await ensureChrome({ ...options, env, port });
    }
    if (options.verbose) {
        process.stderr.write(`Connecting to Chrome CDP: http://127.0.0.1:${port}\n`);
    }
    return playwright_core_1.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}
