"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.providerRegistry = exports.DEFAULT_PROVIDER_NAME = exports.PROVIDER_NAMES = void 0;
exports.isProviderName = isProviderName;
exports.parseProviderName = parseProviderName;
exports.resolveProviderName = resolveProviderName;
exports.getProvider = getProvider;
const webchat_1 = require("./webchat");
exports.PROVIDER_NAMES = ["chatgpt", "gemini"];
exports.DEFAULT_PROVIDER_NAME = "chatgpt";
function isUrlOnHost(value, predicate) {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        return predicate(url.hostname.toLowerCase()) ? url : undefined;
    }
    catch {
        return undefined;
    }
}
function isChatGptHost(hostname) {
    return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
}
function isGeminiHost(hostname) {
    return hostname === "gemini.google.com";
}
exports.providerRegistry = {
    chatgpt: {
        name: "chatgpt",
        displayName: "ChatGPT",
        homeUrl: "https://chatgpt.com/",
        screenshotPrefix: "chatgpt",
        automation: (0, webchat_1.createProviderAutomation)({
            name: "chatgpt",
            displayName: "ChatGPT",
            promptInputSelectors: [
                "#prompt-textarea",
                "textarea",
                '[contenteditable="true"]'
            ],
            sendButtonSelectors: [
                'button[data-testid="send-button"]',
                'button[aria-label="Send prompt"]',
                'button[aria-label*="Send"]',
                'button:has-text("Send")'
            ],
            stopButtonSelectors: [
                'button[data-testid="stop-button"]',
                'button[aria-label*="Stop"]',
                'button:has-text("Stop generating")'
            ],
            assistantResponseSelectors: [
                '[data-message-author-role="assistant"]',
                "main article",
                "article",
                ".markdown"
            ],
            assistantContentSelectors: [
                ".markdown",
                "[data-message-content]",
                ".prose"
            ],
            assistantCompletionSelectors: ['[data-testid="copy-turn-action-button"]'],
            assistantBusySelectors: ["[data-writing-block]"],
            fileInputSelectors: ['input[type="file"]'],
            attachButtonSelectors: [
                'button[aria-label*="Attach"]',
                'button[aria-label*="Upload"]',
                'button:has-text("Attach")'
            ],
            signInSelectors: [
                'a[href*="/auth/login"]',
                'button:has-text("Log in")',
                'a:has-text("Log in")',
                'button:has-text("Sign up")',
                'a:has-text("Sign up")'
            ],
            accountSelectors: [
                '[data-testid="profile-button"]',
                '[data-testid="accounts-profile-button"]',
                '[role="button"][aria-label*="profile menu"]',
                '[aria-label*="open profile menu"]',
                '[aria-label*="Open profile menu"]',
                '[aria-label*="Profile"]',
                '[aria-label*="Account"]',
                'img[alt*="User"]'
            ],
            blockedSelectors: [
                'text=/verify you are human/i',
                'text=/unusual activity/i',
                'text=/try again later/i',
                'text=/rate limit/i'
            ]
        }),
        matchesPageUrl(value) {
            return Boolean(isUrlOnHost(value, isChatGptHost));
        },
        matchesConversationUrl(value) {
            const url = isUrlOnHost(value, isChatGptHost);
            return Boolean(url && /^\/c\/[^/]+/.test(url.pathname));
        }
    },
    gemini: {
        name: "gemini",
        displayName: "Gemini",
        homeUrl: "https://gemini.google.com/app",
        screenshotPrefix: "gemini",
        automation: (0, webchat_1.createProviderAutomation)({
            name: "gemini",
            displayName: "Gemini",
            promptInputSelectors: [
                'rich-textarea [contenteditable="true"]',
                '[contenteditable="true"][aria-label*="Enter"]',
                '[contenteditable="true"][aria-label*="prompt"]',
                '[contenteditable="true"][aria-label*="Prompt"]',
                'textarea[aria-label*="prompt"]',
                'textarea[aria-label*="Prompt"]',
                "textarea",
                '[contenteditable="true"]'
            ],
            sendButtonSelectors: [
                'button[aria-label="Send message"]',
                'button[aria-label*="Send message"]',
                'button[aria-label*="Send"]',
                'button:has-text("Send")'
            ],
            stopButtonSelectors: [
                'button[aria-label*="Stop"]',
                'button[aria-label*="Cancel"]',
                'button:has-text("Stop")'
            ],
            assistantResponseSelectors: [
                "message-content",
                ".model-response-text",
                "[data-response-index]",
                "response-container",
                "main article",
                "article",
                ".markdown"
            ],
            assistantContentSelectors: [
                "message-content",
                ".markdown",
                ".model-response-text",
                "[data-message-content]",
                ".prose",
                "p"
            ],
            assistantCompletionSelectors: ['button[aria-label="Copy"]'],
            assistantBusySelectors: [],
            fileInputSelectors: ['input[type="file"]'],
            attachButtonSelectors: [
                'button[aria-label*="Attach"]',
                'button[aria-label*="Upload"]',
                'button:has-text("Attach")',
                'button:has-text("Upload")'
            ],
            signInSelectors: [
                'a[aria-label*="Sign in"]',
                'button[aria-label*="Sign in"]',
                'a:has-text("Sign in")',
                'button:has-text("Sign in")',
                'a[href*="accounts.google.com"]:has-text("Sign in")'
            ],
            accountSelectors: [
                'a[aria-label*="Google Account"]',
                'button[aria-label*="Google Account"]',
                'a[href*="SignOutOptions"]',
                'img[alt*="Profile"]',
                'img[alt*="Google Account"]'
            ],
            blockedSelectors: [
                'text=/verify/i',
                'text=/unusual traffic/i',
                'text=/try again later/i'
            ]
        }),
        matchesPageUrl(value) {
            return Boolean(isUrlOnHost(value, isGeminiHost));
        },
        matchesConversationUrl(value) {
            const url = isUrlOnHost(value, isGeminiHost);
            return Boolean(url && /^\/app\/[^/]+/.test(url.pathname));
        }
    }
};
function isProviderName(value) {
    return Boolean(value && exports.PROVIDER_NAMES.includes(value));
}
function parseProviderName(value) {
    const normalized = (value || exports.DEFAULT_PROVIDER_NAME).trim().toLowerCase();
    if (isProviderName(normalized)) {
        return normalized;
    }
    throw new Error(`Unsupported provider "${value}". Supported providers: ${exports.PROVIDER_NAMES.join(", ")}.`);
}
function resolveProviderName(explicitProvider, env = process.env) {
    return parseProviderName(explicitProvider || env.ASK_PROVIDER || exports.DEFAULT_PROVIDER_NAME);
}
function getProvider(providerName) {
    return exports.providerRegistry[providerName];
}
