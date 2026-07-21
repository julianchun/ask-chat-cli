"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeConversationName = normalizeConversationName;
exports.createConversationContinuity = createConversationContinuity;
exports.readLastConversationUrl = readLastConversationUrl;
exports.readNamedConversationUrl = readNamedConversationUrl;
exports.writeLastConversationUrl = writeLastConversationUrl;
exports.listNamedConversations = listNamedConversations;
exports.forgetNamedConversation = forgetNamedConversation;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
function emptyState() {
    return { version: 2, lastUrls: {}, named: {} };
}
function getConversationStatePath(env) {
    return node_path_1.default.join((0, config_1.getAskHome)(env), "conversations.json");
}
function getConversationLockPath(env) {
    return node_path_1.default.join((0, config_1.getAskHome)(env), "conversations.lock");
}
function normalizeConversationName(value) {
    const name = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
        throw new Error("Conversation names must be 1-64 characters and contain only lowercase letters, numbers, dots, underscores, or hyphens.");
    }
    return name;
}
function createConversationContinuity(env = process.env) {
    return {
        resolve: (browser, provider, request) => resolveConversation(browser, provider, env, request),
        preferredUrl: async (provider) => {
            const savedUrl = await readLastConversationUrl(env, provider.name);
            return savedUrl && provider.matchesConversationUrl(savedUrl) ? savedUrl : undefined;
        },
        remember: async (provider, page, conversationName) => {
            const url = page.url();
            if (provider.matchesConversationUrl(url)) {
                await rememberConversationUrl(env, provider.name, url, conversationName);
            }
        },
        list: (provider) => listNamedConversations(env, provider),
        forget: (provider, name) => forgetNamedConversation(env, provider, name)
    };
}
async function resolveConversation(browser, provider, env, request) {
    const savedUrl = await readLastConversationUrl(env, provider.name);
    const preferredUrl = savedUrl && provider.matchesConversationUrl(savedUrl) ? savedUrl : undefined;
    const conversationName = request.conversationName
        ? normalizeConversationName(request.conversationName)
        : undefined;
    if (conversationName) {
        if (request.newSession !== true && provider.matchesConversationUrl(request.requestedUrl)) {
            return { newSession: false, url: request.requestedUrl, preferredUrl, conversationName };
        }
        if (request.newSession !== true) {
            const namedUrl = await readNamedConversationUrl(env, provider.name, conversationName);
            if (namedUrl && provider.matchesConversationUrl(namedUrl)) {
                return { newSession: false, url: namedUrl, preferredUrl: namedUrl, conversationName };
            }
        }
        return {
            newSession: true,
            url: provider.matchesConversationUrl(request.requestedUrl) ? provider.homeUrl : request.requestedUrl,
            preferredUrl,
            conversationName
        };
    }
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
async function readConversationState(env) {
    try {
        const parsed = JSON.parse(await node_fs_1.default.promises.readFile(getConversationStatePath(env), "utf8"));
        if (parsed.version === 2) {
            const state = parsed;
            return {
                version: 2,
                lastUrls: state.lastUrls && typeof state.lastUrls === "object" ? state.lastUrls : {},
                named: state.named && typeof state.named === "object" ? state.named : {}
            };
        }
        if (parsed.version === 1) {
            const state = parsed;
            return {
                version: 2,
                lastUrls: state.urls && typeof state.urls === "object" ? state.urls : {},
                named: {}
            };
        }
    }
    catch {
        // Missing or invalid state starts empty.
    }
    return emptyState();
}
async function readLastConversationUrl(env, provider) {
    return (await readConversationState(env)).lastUrls[provider];
}
async function readNamedConversationUrl(env, provider, name) {
    const entry = (await readConversationState(env)).named[provider]?.[normalizeConversationName(name)];
    return entry && typeof entry.url === "string" ? entry.url : undefined;
}
async function writeLastConversationUrl(env, provider, url) {
    await updateConversationState(env, (state) => {
        state.lastUrls[provider] = url;
    });
}
async function rememberConversationUrl(env, provider, url, conversationName) {
    await updateConversationState(env, (state) => {
        state.lastUrls[provider] = url;
        if (conversationName) {
            const name = normalizeConversationName(conversationName);
            const entries = state.named[provider] || {};
            const existingAlias = Object.entries(entries).find(([entryName, entry]) => entryName !== name && entry.url === url);
            if (existingAlias) {
                throw new Error(`Conversation URL is already named "${existingAlias[0]}" for ${provider}; one URL cannot have multiple names.`);
            }
            entries[name] = { url, updatedAt: new Date().toISOString() };
            state.named[provider] = entries;
        }
    });
}
async function listNamedConversations(env, provider) {
    const state = await readConversationState(env);
    const providers = provider ? [provider] : ["chatgpt", "gemini"];
    return providers
        .flatMap((providerName) => Object.entries(state.named[providerName] || {}).map(([name, entry]) => ({
        name,
        provider: providerName,
        url: entry.url,
        updatedAt: entry.updatedAt
    })))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
async function forgetNamedConversation(env, provider, name) {
    let removed = false;
    await updateConversationState(env, (state) => {
        const entries = state.named[provider];
        const normalizedName = normalizeConversationName(name);
        if (entries && Object.prototype.hasOwnProperty.call(entries, normalizedName)) {
            delete entries[normalizedName];
            removed = true;
        }
    });
    return removed;
}
async function updateConversationState(env, update) {
    await withConversationStateLock(env, async () => {
        const statePath = getConversationStatePath(env);
        const state = await readConversationState(env);
        update(state);
        const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
        try {
            await node_fs_1.default.promises.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
