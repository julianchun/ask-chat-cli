"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_REMOTE_DEBUGGING_PORT = exports.DEFAULT_TIMEOUT_MS = void 0;
exports.joinConfiguredPath = joinConfiguredPath;
exports.getAskHome = getAskHome;
exports.getChromeProfileDir = getChromeProfileDir;
exports.getScreenshotsDir = getScreenshotsDir;
exports.getRemoteDebuggingPort = getRemoteDebuggingPort;
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
exports.DEFAULT_TIMEOUT_MS = 600_000;
/** @deprecated Unset ASK_REMOTE_DEBUGGING_PORT now requests an automatic port. */
exports.DEFAULT_REMOTE_DEBUGGING_PORT = 9222;
function joinConfiguredPath(root, child) {
    return /^[a-zA-Z]:[\\/]/.test(root) || root.includes("\\")
        ? node_path_1.default.win32.join(root, child)
        : node_path_1.default.join(root, child);
}
function getAskHome(env = process.env) {
    return env.ASK_HOME || node_path_1.default.join(node_os_1.default.homedir(), ".ask");
}
function getChromeProfileDir(env = process.env) {
    return joinConfiguredPath(getAskHome(env), "chrome-profile");
}
function getScreenshotsDir(env = process.env) {
    return joinConfiguredPath(getAskHome(env), "screenshots");
}
/**
 * Return the explicitly pinned remote-debugging port. An absent value is
 * intentionally left undefined so Chrome can allocate an ephemeral port.
 */
function getRemoteDebuggingPort(env = process.env) {
    const raw = env.ASK_REMOTE_DEBUGGING_PORT;
    if (raw === undefined) {
        return undefined;
    }
    const normalized = raw.trim();
    if (!/^\d+$/.test(normalized)) {
        throw new Error("ASK_REMOTE_DEBUGGING_PORT must be an integer between 1 and 65535");
    }
    const port = Number(normalized);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error("ASK_REMOTE_DEBUGGING_PORT must be an integer between 1 and 65535");
    }
    return port;
}
