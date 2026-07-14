"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AskApp = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const browser_1 = require("./browser");
const config_1 = require("./config");
const conversations_1 = require("./conversations");
const io_1 = require("./io");
const providers_1 = require("./providers");
const webchat_1 = require("./webchat");
const DEFAULT_STATUS_TIMEOUT_MS = 3_000;
class AskApp {
    env;
    chromeSession;
    conversations;
    constructor(options = {}) {
        this.env = options.env || process.env;
        this.chromeSession = options.chromeSession || (0, browser_1.createChromeSessionController)(this.env);
        this.conversations = options.conversationContinuity || (0, conversations_1.createConversationContinuity)(this.env);
    }
    async login(options = {}) {
        if (options.headless) {
            throw new Error("`ask login` requires a visible browser. Use `ask login --provider <provider>` without --headless.");
        }
        const provider = this.resolveProvider(options.provider);
        const browser = await this.chromeSession.connect({
            ...this.chromeOptions({ ...options, headless: false }),
            requireManaged: true,
            requireVisible: true,
            url: provider.homeUrl
        });
        try {
            await (0, webchat_1.openChatPage)(browser, provider, provider.homeUrl);
        }
        finally {
            await browser.close();
        }
    }
    async open(options) {
        const provider = this.resolveProvider(options.provider);
        await this.assertHeadlessAllowedIfNeeded(provider, options);
        const browser = await this.chromeSession.connect({
            ...this.chromeOptions(options),
            requireManaged: true,
            requireVisible: !options.headless,
            url: options.url
        });
        try {
            const session = await this.conversations.resolve(browser, provider, {
                requestedUrl: options.url,
                newSession: options.newSession,
                onContinuationUnavailable: options.onContinuationUnavailable
            });
            const page = await (0, webchat_1.openChatPage)(browser, provider, session.url, { newSession: session.newSession });
            if (options.send) {
                if (!options.prompt) {
                    throw new Error("`ask open --send` requires a prompt.");
                }
                await this.assertSignedInBeforeSend(page, provider, options);
            }
            await provider.automation.attachFiles(page, options.attachments);
            if (options.prompt) {
                const input = await provider.automation.fillPrompt(page, options.prompt, Math.min(options.timeoutMs, 30_000));
                if (options.send) {
                    await provider.automation.submitPrompt(page, input, Math.min(options.timeoutMs, 30_000));
                }
            }
            await this.conversations.remember(provider, page);
        }
        finally {
            await browser.close();
        }
    }
    async ask(options) {
        const provider = this.resolveProvider(options.provider);
        await this.assertHeadlessAllowedIfNeeded(provider, options);
        const browser = await this.chromeSession.connect({
            ...this.chromeOptions(options),
            requireManaged: true,
            requireVisible: !options.headless,
            url: provider.homeUrl
        });
        try {
            const session = await this.conversations.resolve(browser, provider, {
                requestedUrl: provider.homeUrl,
                newSession: options.newSession,
                onContinuationUnavailable: options.onContinuationUnavailable
            });
            const page = await (0, webchat_1.openWorkerPage)(browser, provider, session.url, session.preferredUrl);
            await this.assertSignedInBeforeSend(page, provider, options);
            await provider.automation.attachFiles(page, options.attachments);
            const input = await provider.automation.fillPrompt(page, options.prompt, Math.min(options.timeoutMs, 30_000));
            const baseline = await provider.automation.captureAssistantResponseBaseline(page);
            await provider.automation.submitPrompt(page, input, Math.min(options.timeoutMs, 30_000));
            const result = await provider.automation.waitForAssistantCompletion(page, { timeoutMs: options.timeoutMs, baseline });
            await this.conversations.remember(provider, page);
            const conversationUrl = page.url();
            return {
                ...result,
                ...(provider.matchesConversationUrl(conversationUrl) ? { conversationUrl } : {})
            };
        }
        finally {
            await browser.close();
        }
    }
    async get(options = {}) {
        const provider = this.resolveProvider(options.provider);
        const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false, requireManaged: true });
        try {
            const page = (0, webchat_1.selectCurrentPage)(browser, provider, await this.conversations.preferredUrl(provider));
            return await provider.automation.extractLatestAssistantText(page);
        }
        finally {
            await browser.close();
        }
    }
    async dump(options = {}) {
        const provider = this.resolveProvider(options.provider);
        const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false, requireManaged: true });
        try {
            const page = (0, webchat_1.selectCurrentPage)(browser, provider, await this.conversations.preferredUrl(provider));
            return await page.content();
        }
        finally {
            await browser.close();
        }
    }
    async screenshot(output, options = {}) {
        const provider = this.resolveProvider(options.provider);
        const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false, requireManaged: true });
        try {
            const page = (0, webchat_1.selectCurrentPage)(browser, provider, await this.conversations.preferredUrl(provider));
            const screenshotPath = output ? node_path_1.default.resolve(output) : this.defaultScreenshotPath(provider);
            await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(screenshotPath), { recursive: true });
            await page.screenshot({ path: screenshotPath, fullPage: true });
            return screenshotPath;
        }
        finally {
            await browser.close();
        }
    }
    async status(options = {}) {
        const provider = this.resolveProvider(options.provider);
        const session = await this.chromeSession.inspect(this.chromeOptions(options));
        const { port, classification } = session;
        if (!session.connected || classification.ownership === "absent") {
            return this.emptyStatus(provider, port, "absent", `No Chrome debugging session is available on port ${port}. Run \`ask login --provider ${provider.name}\` to open one.`);
        }
        const headless = Boolean(session.headless);
        if (classification.ownership !== "ask-managed") {
            return {
                ...this.emptyStatus(provider, port, classification.ownership, `Chrome debugging is present on port ${port}, but it is not an ask-managed session. ${classification.reason || "The session could not be verified."}`),
                connected: true,
                headless,
                browser: session.browser,
                userAgent: session.userAgent
            };
        }
        const browser = await this.chromeSession.connect({ ...this.chromeOptions(options), launchIfNeeded: false });
        try {
            const pages = browser.contexts().flatMap((context) => context.pages());
            const providerPages = pages.filter((page) => provider.matchesPageUrl(page.url()));
            const page = providerPages.at(-1);
            const inspection = page
                ? await provider.automation.inspectPage(page, options.timeoutMs || DEFAULT_STATUS_TIMEOUT_MS)
                : this.emptyInspection();
            return {
                provider: provider.name,
                providerDisplayName: provider.displayName,
                port,
                connected: true,
                sessionOwnership: classification.ownership,
                headless,
                browser: session.browser,
                userAgent: session.userAgent,
                pageCount: pages.length,
                providerPageCount: providerPages.length,
                currentPageUrl: page?.url(),
                promptInputVisible: inspection.promptInputVisible,
                authState: inspection.authState,
                readyToSend: inspection.readyToSend,
                readyForHeadless: inspection.readyForHeadless,
                loggedInLikely: inspection.authState === "signed-in-likely",
                note: this.statusNote(provider, headless, Boolean(page), inspection)
            };
        }
        finally {
            await browser.close();
        }
    }
    async ensureLoggedInDebugPort(options = {}) {
        await this.chromeSession.waitUntilReady(options.timeoutMs || 15_000);
    }
    async assertHeadlessAllowedIfNeeded(provider, options) {
        if (!options.headless) {
            return;
        }
        const status = await this.status({ provider: provider.name, timeoutMs: Math.min(options.timeoutMs || DEFAULT_STATUS_TIMEOUT_MS, DEFAULT_STATUS_TIMEOUT_MS) });
        if (status.sessionOwnership === "ask-managed" &&
            status.headless &&
            status.providerPageCount === 0) {
            return;
        }
        if (!status.readyForHeadless) {
            throw new Error(`${provider.displayName} is not ready for headless use (auth: ${status.authState}, prompt: ${status.promptInputVisible ? "found" : "not found"}). ` +
                `Run \`ask login --provider ${provider.name}\`, then \`ask status --provider ${provider.name}\`.`);
        }
    }
    async assertSignedInBeforeSend(page, provider, options) {
        const inspection = await provider.automation.inspectPage(page, Math.min(options.timeoutMs || DEFAULT_STATUS_TIMEOUT_MS, DEFAULT_STATUS_TIMEOUT_MS));
        if (inspection.authState === "signed-in-likely" && inspection.promptInputVisible) {
            return;
        }
        throw new Error(`${provider.displayName} is not ready to send from a signed-in session (auth: ${inspection.authState}, prompt: ${inspection.promptInputVisible ? "found" : "not found"}). ` +
            `Check the opened ask browser, sign in, then try again. ` +
            `Run \`ask login --provider ${provider.name}\`, then \`ask status --provider ${provider.name}\`.`);
    }
    emptyInspection() {
        return {
            promptInputVisible: false,
            authState: "unknown",
            readyToSend: false,
            readyForHeadless: false
        };
    }
    emptyStatus(provider, port, ownership, note) {
        return {
            provider: provider.name,
            providerDisplayName: provider.displayName,
            port,
            connected: false,
            sessionOwnership: ownership,
            pageCount: 0,
            providerPageCount: 0,
            promptInputVisible: false,
            authState: "unknown",
            readyToSend: false,
            readyForHeadless: false,
            loggedInLikely: false,
            note
        };
    }
    resolveProvider(providerName) {
        return (0, providers_1.getProvider)((0, providers_1.resolveProviderName)(providerName, this.env));
    }
    statusNote(provider, headless, hasProviderPage, inspection) {
        if (!hasProviderPage) {
            return `No ${provider.displayName} page is open in the ask-managed Chrome session.`;
        }
        if (inspection.authState === "blocked") {
            return `${provider.displayName} appears blocked by verification, limits, or an error page. Inspect the visible browser.`;
        }
        if (inspection.authState === "login-required") {
            return `${provider.displayName} requires login or verification. Run \`ask login --provider ${provider.name}\`.`;
        }
        if (inspection.authState === "guest") {
            return `${provider.displayName} is ready to send, but it appears to be a guest or signed-out session.`;
        }
        if (inspection.authState === "signed-in-likely" && headless) {
            return `${provider.displayName} appears signed in and ready, but Chrome is headless. Use \`ask login --provider ${provider.name}\` when you need to inspect it.`;
        }
        if (inspection.authState === "signed-in-likely") {
            return `${provider.displayName} appears signed in and ready in the visible ask Chrome session.`;
        }
        if (inspection.readyToSend && headless) {
            return `${provider.displayName} is ready to send, but auth is unknown and Chrome is headless. Run \`ask login --provider ${provider.name}\` to inspect it.`;
        }
        if (inspection.readyToSend) {
            return `${provider.displayName} is ready to send, but auth is unknown. Inspect the visible browser if signed-in behavior matters.`;
        }
        return `${provider.displayName} is open, but no prompt input was found. Finish login, verification, or refresh the page.`;
    }
    defaultScreenshotPath(provider) {
        return node_path_1.default.join((0, config_1.getScreenshotsDir)(this.env), `${provider.screenshotPrefix}-${(0, io_1.timestampForFile)()}.png`);
    }
    chromeOptions(options = {}) {
        return {
            headless: options.headless,
            verbose: options.verbose
        };
    }
}
exports.AskApp = AskApp;
