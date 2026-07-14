"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConversationContinuity = createConversationContinuity;
exports.readLastConversationUrl = readLastConversationUrl;
exports.writeLastConversationUrl = writeLastConversationUrl;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
function getConversationStatePath(env) {
    return node_path_1.default.join((0, config_1.getAskHome)(env), "conversations.json");
}
function getConversationLockPath(env) {
    return node_path_1.default.join((0, config_1.getAskHome)(env), "conversations.lock");
}
function createConversationContinuity(env = process.env) {
    return {
        resolve: (browser, provider, request) => resolveConversation(browser, provider, env, request),
        preferredUrl: async (provider) => {
            const savedUrl = await readLastConversationUrl(env, provider.name);
            return savedUrl && provider.matchesConversationUrl(savedUrl) ? savedUrl : undefined;
        },
        remember: async (provider, page) => {
            const url = page.url();
            if (provider.matchesConversationUrl(url)) {
                await writeLastConversationUrl(env, provider.name, url);
            }
        }
    };
}
async function resolveConversation(browser, provider, env, request) {
    const savedUrl = await readLastConversationUrl(env, provider.name);
    const preferredUrl = savedUrl && provider.matchesConversationUrl(savedUrl) ? savedUrl : undefined;
    if (request.newSession !== false) {
        return { newSession: request.newSession, url: request.requestedUrl, preferredUrl };
    }
    if (provider.matchesConversationUrl(request.requestedUrl)) {
        return { newSession: false, url: request.requestedUrl, preferredUrl };
    }
    if (preferredUrl) {
        return { newSession: false, url: preferredUrl, preferredUrl };
    }
    const conversationPages = browser.contexts().flatMap((context) => context.pages().filter((page) => provider.matchesConversationUrl(page.url())));
    for (const page of conversationPages) {
        try {
            if (await page.evaluate(() => document.visibilityState === "visible")) {
                return { newSession: false, url: page.url(), preferredUrl: page.url() };
            }
        }
        catch {
            // Try another restored conversation page.
        }
    }
    if (conversationPages.length > 0) {
        return { newSession: false, url: conversationPages[0].url(), preferredUrl: conversationPages[0].url() };
    }
    request.onContinuationUnavailable?.();
    return { newSession: true, url: provider.homeUrl };
}
async function readLastConversationUrl(env, provider) {
    try {
        const parsed = JSON.parse(await node_fs_1.default.promises.readFile(getConversationStatePath(env), "utf8"));
        const url = parsed.version === 1 ? parsed.urls?.[provider] : undefined;
        return typeof url === "string" ? url : undefined;
    }
    catch {
        return undefined;
    }
}
async function writeLastConversationUrl(env, provider, url) {
    await withConversationStateLock(env, async () => {
        const statePath = getConversationStatePath(env);
        let urls = {};
        try {
            const parsed = JSON.parse(await node_fs_1.default.promises.readFile(statePath, "utf8"));
            if (parsed.version === 1 && parsed.urls && typeof parsed.urls === "object") {
                urls = parsed.urls;
            }
        }
        catch {
            // Start a new state file.
        }
        const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
        try {
            await node_fs_1.default.promises.writeFile(temporaryPath, `${JSON.stringify({ version: 1, urls: { ...urls, [provider]: url } }, null, 2)}\n`, "utf8");
            await node_fs_1.default.promises.rename(temporaryPath, statePath);
        }
        finally {
            await node_fs_1.default.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        }
    });
}
async function withConversationStateLock(env, fn) {
    const lockPath = getConversationLockPath(env);
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + 2_000;
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
                if (Date.now() - stat.mtimeMs > 30_000) {
                    await node_fs_1.default.promises.rm(lockPath, { force: true });
                    continue;
                }
            }
            catch {
                continue;
            }
            if (Date.now() >= deadline) {
                throw new Error("Timed out waiting to update conversation state.");
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
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
