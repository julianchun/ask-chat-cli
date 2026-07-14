"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHATGPT_HOME_URL = void 0;
exports.isChatGptConversationUrl = isChatGptConversationUrl;
exports.isProviderConversationUrl = isProviderConversationUrl;
exports.resolveOpenTarget = resolveOpenTarget;
exports.combinePromptAndStdin = combinePromptAndStdin;
exports.parseTimeout = parseTimeout;
const providers_1 = require("./providers");
exports.CHATGPT_HOME_URL = providers_1.providerRegistry.chatgpt.homeUrl;
function isChatGptConversationUrl(value) {
    return providers_1.providerRegistry.chatgpt.matchesConversationUrl(value);
}
function isProviderConversationUrl(providerName, value) {
    return (0, providers_1.getProvider)(providerName).matchesConversationUrl(value);
}
function resolveOpenTarget(first, rest = [], providerName = providers_1.DEFAULT_PROVIDER_NAME) {
    const provider = (0, providers_1.getProvider)(providerName);
    if (provider.matchesConversationUrl(first)) {
        return {
            url: first,
            prompt: rest.join(" ").trim(),
            openedConversation: true
        };
    }
    const prompt = [first, ...rest].filter((part) => Boolean(part)).join(" ").trim();
    return {
        url: provider.homeUrl,
        prompt,
        openedConversation: false
    };
}
function combinePromptAndStdin(prompt, stdin) {
    const trimmedPrompt = prompt.trim();
    const trimmedStdin = stdin.trim();
    if (trimmedPrompt && trimmedStdin) {
        return `${trimmedPrompt}\n\n${trimmedStdin}`;
    }
    return trimmedPrompt || trimmedStdin;
}
function parseTimeout(value) {
    const timeout = Number(value);
    if (!Number.isInteger(timeout) || timeout <= 0) {
        throw new Error("--timeout must be a positive integer number of milliseconds");
    }
    return timeout;
}
