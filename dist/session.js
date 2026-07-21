"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_STATE_VERSION = void 0;
exports.getSessionStatePath = getSessionStatePath;
exports.getProfileMarkerPath = getProfileMarkerPath;
exports.getSessionLockPath = getSessionLockPath;
exports.withSessionLock = withSessionLock;
exports.normalizePathForCompare = normalizePathForCompare;
exports.writeProfileMarker = writeProfileMarker;
exports.hasProfileMarker = hasProfileMarker;
exports.readSessionState = readSessionState;
exports.writeSessionState = writeSessionState;
exports.getProcessInfo = getProcessInfo;
exports.getPortOwnerProcessInfo = getPortOwnerProcessInfo;
exports.classifySession = classifySession;
exports.processMatchesAskSession = processMatchesAskSession;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const config_1 = require("./config");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
exports.SESSION_STATE_VERSION = 1;
function getSessionStatePath(env = process.env) {
    return node_path_1.default.join((0, config_1.getAskHome)(env), "session.json");
}
function getProfileMarkerPath(env = process.env) {
    return node_path_1.default.join((0, config_1.getChromeProfileDir)(env), ".ask-profile.json");
}
function getSessionLockPath(env = process.env) {
    return node_path_1.default.join((0, config_1.getAskHome)(env), "chrome-manager.lock");
}
const SESSION_LOCK_WAIT_MS = 35_000;
const SESSION_LOCK_STALE_MS = 60_000;
async function withSessionLock(env, fn) {
    await node_fs_1.default.promises.mkdir((0, config_1.getAskHome)(env), { recursive: true });
    const lockPath = getSessionLockPath(env);
    const deadline = Date.now() + SESSION_LOCK_WAIT_MS;
    let handle;
    while (!handle) {
        try {
            handle = await node_fs_1.default.promises.open(lockPath, "wx");
            await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
        }
        catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
                throw error;
            }
            try {
                const stat = await node_fs_1.default.promises.stat(lockPath);
                if (Date.now() - stat.mtimeMs > SESSION_LOCK_STALE_MS) {
                    await node_fs_1.default.promises.rm(lockPath, { force: true });
                    continue;
                }
            }
            catch {
                continue;
            }
            if (Date.now() >= deadline) {
                throw new Error("Timed out waiting for another ask Chrome session operation to finish.");
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
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
function normalizePathForCompare(value) {
    const pathApi = /^[a-zA-Z]:[\\/]/.test(value) || value.includes("\\") ? node_path_1.default.win32 : node_path_1.default;
    return pathApi.resolve(value).toLowerCase();
}
async function writeProfileMarker(env = process.env) {
    const markerPath = getProfileMarkerPath(env);
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(markerPath), { recursive: true });
    const marker = {
        manager: "ask",
        version: exports.SESSION_STATE_VERSION,
        profileDir: (0, config_1.getChromeProfileDir)(env)
    };
    await node_fs_1.default.promises.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}
async function hasProfileMarker(env = process.env) {
    try {
        await node_fs_1.default.promises.access(getProfileMarkerPath(env), node_fs_1.default.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function readSessionState(env = process.env) {
    try {
        const text = await node_fs_1.default.promises.readFile(getSessionStatePath(env), "utf8");
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") {
            return undefined;
        }
        const state = parsed;
        if (state.version !== exports.SESSION_STATE_VERSION ||
            typeof state.pid !== "number" ||
            typeof state.port !== "number" ||
            typeof state.profileDir !== "string" ||
            typeof state.chromePath !== "string" ||
            typeof state.headless !== "boolean" ||
            typeof state.nonce !== "string") {
            return undefined;
        }
        return state;
    }
    catch {
        return undefined;
    }
}
async function writeSessionState(env, input) {
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
        nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`
    };
    await node_fs_1.default.promises.mkdir((0, config_1.getAskHome)(env), { recursive: true });
    await node_fs_1.default.promises.writeFile(getSessionStatePath(env), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return state;
}
async function getProcessInfo(pid) {
    if (process.platform === "win32") {
        return getWindowsProcessInfo(pid);
    }
    try {
        process.kill(pid, 0);
        try {
            const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
            const creationTime = stdout.trim();
            return { pid, creationTime: creationTime || undefined };
        }
        catch {
            return { pid };
        }
    }
    catch {
        return undefined;
    }
}
async function getPortOwnerProcessInfo(port) {
    if (process.platform !== "win32") {
        return undefined;
    }
    try {
        const { stdout } = await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`
        ]);
        const pid = Number(stdout.trim());
        if (!Number.isInteger(pid) || pid <= 0) {
            return undefined;
        }
        return getProcessInfo(pid);
    }
    catch {
        return undefined;
    }
}
async function getWindowsProcessInfo(pid) {
    try {
        const { stdout } = await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | ConvertTo-Json -Compress`
        ]);
        const trimmed = stdout.trim();
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
async function classifySession(env, port, debuggingConnected) {
    if (!debuggingConnected) {
        return { ownership: "absent", reason: "No Chrome debugging endpoint is available." };
    }
    const state = await readSessionState(env);
    if (!state) {
        const processInfo = await getPortOwnerProcessInfo(port);
        if (processInfo && processMatchesAskSession(processInfo, port, (0, config_1.getChromeProfileDir)(env))) {
            return {
                ownership: "ask-managed",
                process: processInfo,
                reason: "Chrome debugging matches the ask profile and port but has no session state yet."
            };
        }
        return { ownership: "external", process: processInfo, reason: "Chrome debugging is available, but no ask session state was found." };
    }
    if (state.port !== port) {
        return { ownership: "external", state, reason: "Chrome debugging port does not match ask session state." };
    }
    if (normalizePathForCompare(state.profileDir) !== normalizePathForCompare((0, config_1.getChromeProfileDir)(env))) {
        return { ownership: "unknown", state, reason: "Ask session state points to a different profile directory." };
    }
    if (!(await hasProfileMarker(env))) {
        return { ownership: "unknown", state, reason: "Ask profile marker is missing." };
    }
    const processInfo = await getProcessInfo(state.pid);
    if (!processInfo) {
        const portOwner = await getPortOwnerProcessInfo(port);
        if (portOwner && processMatchesAskSession(portOwner, port, state.profileDir)) {
            return { ownership: "ask-managed", state, process: portOwner, reason: "Ask state PID is stale, but the port owner matches the ask profile." };
        }
        return { ownership: "unknown", state, reason: "Ask session process is not running." };
    }
    if (processInfo.commandLine && !processMatchesAskSession(processInfo, port, state.profileDir)) {
        return { ownership: "unknown", state, process: processInfo, reason: "Process command line does not match ask port/profile." };
    }
    if (state.processCreationTime && processInfo.creationTime && state.processCreationTime !== processInfo.creationTime) {
        return { ownership: "unknown", state, process: processInfo, reason: "Process creation time does not match ask state." };
    }
    return { ownership: "ask-managed", state, process: processInfo };
}
function processMatchesAskSession(processInfo, port, profileDir) {
    const commandLine = (processInfo.commandLine || "").toLowerCase();
    if (!commandLine) {
        return false;
    }
    const expectedProfile = normalizePathForCompare(profileDir);
    const expectedProfileAlt = expectedProfile.replace(/\\/g, "/");
    return (commandLine.includes(`--remote-debugging-port=${port}`.toLowerCase()) &&
        (commandLine.includes(`--user-data-dir=${expectedProfile}`) ||
            commandLine.includes(`--user-data-dir="${expectedProfile}"`) ||
            commandLine.includes(`--user-data-dir=${expectedProfileAlt}`) ||
            commandLine.includes(`--user-data-dir="${expectedProfileAlt}"`)));
}
