"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProviderAutomation = createProviderAutomation;
exports.getDefaultContext = getDefaultContext;
exports.openChatPage = openChatPage;
exports.openWorkerPage = openWorkerPage;
exports.selectCurrentPage = selectCurrentPage;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
function createProviderAutomation(config) {
    return {
        inspectPage: (page, timeoutMs) => inspectProviderPage(page, config, timeoutMs),
        attachFiles: (page, filePaths) => attachFiles(page, config, filePaths),
        fillPrompt: (page, prompt, timeoutMs) => fillPrompt(page, config, prompt, timeoutMs),
        submitPrompt: (page, input, timeoutMs) => submitPrompt(page, config, input, timeoutMs),
        extractLatestAssistantText: (page) => extractLatestAssistantText(page, config),
        captureAssistantResponseBaseline: (page) => captureAssistantResponseBaseline(page, config),
        waitForAssistantCompletion: (page, options) => waitForAssistantCompletion(page, config, options),
        stopAssistantGeneration: (page) => stopAssistantGeneration(page, config)
    };
}
function getDefaultContext(browser) {
    const existing = browser.contexts()[0];
    if (!existing) {
        throw new Error("No Chrome browser context was available over CDP.");
    }
    return existing;
}
async function openChatPage(browser, provider, url = provider.homeUrl, options = {}) {
    const context = getDefaultContext(browser);
    const page = options.newSession ? await context.newPage() : selectReusableChatPage(context, provider, url) || (await context.newPage());
    await page.bringToFront();
    const reusingProviderConversation = sameUrl(url, provider.homeUrl) && provider.matchesConversationUrl(page.url());
    if (!sameUrl(page.url(), url) && !reusingProviderConversation) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    await page.bringToFront();
    return page;
}
async function openWorkerPage(browser, provider, url = provider.homeUrl) {
    const context = getDefaultContext(browser);
    const page = await context.newPage();
    if (!sameUrl(page.url(), url)) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    return page;
}
function selectReusableChatPage(context, provider, url, preferredUrl) {
    const pages = context.pages();
    const preferredPage = preferredUrl && pages.find((page) => sameUrl(page.url(), preferredUrl));
    if (preferredPage) {
        return preferredPage;
    }
    if (sameUrl(url, provider.homeUrl)) {
        return (pages.find((page) => provider.matchesConversationUrl(page.url())) ||
            pages.find((page) => sameUrl(page.url(), url)) ||
            pages.find((page) => provider.matchesPageUrl(page.url())) ||
            pages.find(isBlankPage));
    }
    return pages.find((page) => sameUrl(page.url(), url)) || pages.find((page) => provider.matchesPageUrl(page.url())) || pages.find(isBlankPage);
}
function sameUrl(current, target) {
    try {
        const currentUrl = new URL(current);
        const targetUrl = new URL(target);
        currentUrl.hash = "";
        targetUrl.hash = "";
        return currentUrl.href === targetUrl.href;
    }
    catch {
        return current === target;
    }
}
function isBlankPage(page) {
    return page.url() === "about:blank" || page.url() === "chrome://newtab/";
}
function selectCurrentPage(browser, provider, preferredUrl) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const providerPages = pages.filter((page) => provider.matchesPageUrl(page.url()));
    const page = (preferredUrl && providerPages.find((candidate) => sameUrl(candidate.url(), preferredUrl))) ||
        providerPages.find((candidate) => provider.matchesConversationUrl(candidate.url())) ||
        providerPages.at(0);
    if (!page) {
        throw new Error(`No open ${provider.displayName} page was found. Run \`ask login --provider ${provider.name}\` first.`);
    }
    return page;
}
async function findPromptInput(page, provider, timeoutMs = 30_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        for (const selector of provider.promptInputSelectors) {
            const locator = page.locator(selector).last();
            try {
                if ((await locator.count()) > 0 && await locator.isVisible()) {
                    return locator;
                }
            }
            catch {
                // The provider may be replacing the input while the page initializes.
            }
        }
        const textbox = page.getByRole("textbox").last();
        try {
            if ((await textbox.count()) > 0 && await textbox.isVisible()) {
                return textbox;
            }
        }
        catch {
            // Keep polling until the shared deadline.
        }
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs > 0) {
            await page.waitForTimeout(Math.min(100, remainingMs));
        }
    }
    throw new Error(`Could not find a visible ${provider.displayName} prompt input within ${timeoutMs}ms.`);
}
async function hasPromptInput(page, provider, timeoutMs = 3_000) {
    const startedAt = Date.now();
    for (const selector of provider.promptInputSelectors) {
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = timeoutMs - elapsedMs;
        if (remainingMs <= 0) {
            return false;
        }
        const locator = page.locator(selector).last();
        try {
            await locator.waitFor({ state: "visible", timeout: Math.min(remainingMs, 750) });
            return true;
        }
        catch {
            // Keep status checks quick and conservative.
        }
    }
    return false;
}
async function hasAnyVisible(page, selectors, timeoutMs = 1_000) {
    const startedAt = Date.now();
    for (const selector of selectors) {
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
            return false;
        }
        const locator = page.locator(selector).last();
        try {
            await locator.waitFor({ state: "visible", timeout: Math.min(remainingMs, 500) });
            return true;
        }
        catch {
            // Try the next provider-specific signal.
        }
    }
    return false;
}
async function hasAnyAttached(page, selectors) {
    for (const selector of selectors) {
        try {
            if ((await page.locator(selector).count()) > 0) {
                return true;
            }
        }
        catch {
            // Try the next provider-specific signal.
        }
    }
    return false;
}
async function inspectProviderPage(page, provider, timeoutMs = 3_000) {
    const promptInputVisible = await hasPromptInput(page, provider, timeoutMs);
    let pageTitle = "";
    try {
        pageTitle = await page.title();
    }
    catch {
        // Some test and transitional pages do not expose a title yet.
    }
    const blocked = /just a moment/i.test(pageTitle) ||
        await hasAnyVisible(page, provider.blockedSelectors, 1_000);
    const signIn = await hasAnyVisible(page, provider.signInSelectors, 1_000);
    const account = await hasAnyAttached(page, provider.accountSelectors);
    let authState = "unknown";
    if (blocked) {
        authState = "blocked";
    }
    else if (account && !signIn) {
        authState = "signed-in-likely";
    }
    else if (signIn && promptInputVisible) {
        authState = "guest";
    }
    else if (signIn) {
        authState = "login-required";
    }
    return {
        promptInputVisible,
        authState,
        readyToSend: promptInputVisible,
        readyForHeadless: promptInputVisible && authState === "signed-in-likely"
    };
}
const IMAGE_EXTENSIONS = new Set([
    ".avif", ".bmp", ".gif", ".heic", ".heif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"
]);
const MIME_TYPES_BY_EXTENSION = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".svg": "image/svg+xml",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};
async function attachFiles(page, provider, filePaths) {
    if (filePaths.length === 0) {
        return;
    }
    const resolvedPaths = filePaths.map((filePath) => node_path_1.default.resolve(filePath));
    for (const filePath of resolvedPaths) {
        if (!node_fs_1.default.existsSync(filePath)) {
            throw new Error(`Attachment file does not exist: ${filePath}`);
        }
        if (!node_fs_1.default.statSync(filePath).isFile()) {
            throw new Error(`Attachment path is not a regular file: ${filePath}`);
        }
    }
    const fileInputs = page.locator(provider.fileInputSelectors.join(", "));
    const compatibleInput = await selectCompatibleFileInput(fileInputs, resolvedPaths);
    if (compatibleInput) {
        try {
            if (compatibleInput.multiple || resolvedPaths.length === 1) {
                await compatibleInput.locator.setInputFiles(resolvedPaths);
                await page.waitForTimeout(750);
            }
            else {
                for (const filePath of resolvedPaths) {
                    await compatibleInput.locator.setInputFiles(filePath);
                    await page.waitForTimeout(750);
                }
            }
        }
        catch (error) {
            throw attachmentUploadError(provider, error);
        }
        return;
    }
    const attachButton = page.locator(provider.attachButtonSelectors.join(", ")).last();
    if ((await attachButton.count()) === 0) {
        throw new Error(`Could not find a compatible file input or attach button for ${provider.displayName} attachment upload.`);
    }
    try {
        const fileChooser = await openFileChooser(page, attachButton);
        if (fileChooser.isMultiple() || resolvedPaths.length === 1) {
            await fileChooser.setFiles(resolvedPaths);
            await page.waitForTimeout(750);
        }
        else {
            await fileChooser.setFiles(resolvedPaths[0]);
            await page.waitForTimeout(750);
            for (const filePath of resolvedPaths.slice(1)) {
                const nextChooser = await openFileChooser(page, attachButton);
                await nextChooser.setFiles(filePath);
                await page.waitForTimeout(750);
            }
        }
    }
    catch (error) {
        throw attachmentUploadError(provider, error);
    }
}
async function selectCompatibleFileInput(inputs, filePaths) {
    const candidates = [];
    const count = await inputs.count();
    for (let index = 0; index < count; index += 1) {
        const locator = inputs.nth(index);
        const accept = (await locator.getAttribute("accept"))?.trim() || "";
        if (!acceptsAllFiles(accept, filePaths)) {
            continue;
        }
        candidates.push({
            locator,
            multiple: (await locator.getAttribute("multiple")) !== null,
            unrestricted: isUnrestrictedAccept(accept)
        });
    }
    candidates.sort((left, right) => Number(right.unrestricted) - Number(left.unrestricted));
    return candidates[0];
}
function acceptsAllFiles(accept, filePaths) {
    if (isUnrestrictedAccept(accept)) {
        return true;
    }
    const acceptedTypes = accept.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    return filePaths.every((filePath) => acceptedTypes.some((acceptedType) => matchesAcceptedType(filePath, acceptedType)));
}
function isUnrestrictedAccept(accept) {
    const normalized = accept.trim();
    return normalized === "" || normalized.split(",").some((value) => value.trim() === "*/*");
}
function matchesAcceptedType(filePath, acceptedType) {
    const extension = node_path_1.default.extname(filePath).toLowerCase();
    if (acceptedType.startsWith(".")) {
        return extension === acceptedType;
    }
    if (acceptedType === "image/*") {
        return IMAGE_EXTENSIONS.has(extension);
    }
    const mimeType = MIME_TYPES_BY_EXTENSION[extension];
    if (!mimeType) {
        return false;
    }
    if (acceptedType.endsWith("/*")) {
        return mimeType.startsWith(acceptedType.slice(0, -1));
    }
    return mimeType === acceptedType;
}
async function openFileChooser(page, attachButton) {
    const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        attachButton.click()
    ]);
    return fileChooser;
}
function attachmentUploadError(provider, error) {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(`${provider.displayName} could not attach the requested file${detail ? `: ${detail}` : "."}`);
}
async function fillPrompt(page, provider, prompt, timeoutMs = 30_000) {
    const input = await findPromptInput(page, provider, timeoutMs);
    await input.click();
    try {
        await input.fill(prompt);
    }
    catch {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await page.keyboard.insertText(prompt);
    }
    return input;
}
async function submitPrompt(page, provider, input, timeoutMs = 30_000) {
    const startedAt = Date.now();
    do {
        let visibleSendButtonFound = false;
        for (const selector of provider.sendButtonSelectors) {
            const button = page.locator(selector).last();
            try {
                if ((await button.count()) > 0 && (await button.isVisible())) {
                    visibleSendButtonFound = true;
                    if (await button.isEnabled()) {
                        await button.click();
                        return;
                    }
                }
            }
            catch {
                // Try the next send affordance.
            }
        }
        if (!visibleSendButtonFound) {
            break;
        }
        await page.waitForTimeout(250);
    } while (Date.now() - startedAt < timeoutMs);
    if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`${provider.displayName} send button remained disabled while attachments were processing.`);
    }
    if (input) {
        await input.press("Enter");
        return;
    }
    await page.keyboard.press("Enter");
}
async function extractLatestAssistantText(page, provider) {
    return page.evaluate(({ responseSelectors, contentSelectors }) => {
        const normalize = (value) => (value || "")
            .replace(/\r\n/g, "\n")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        const candidates = responseSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
        for (const node of candidates.reverse()) {
            const nodeText = normalize(node.innerText || node.textContent);
            if (nodeText) {
                return nodeText;
            }
            const content = contentSelectors
                .map((selector) => node.querySelector(selector))
                .find((element) => Boolean(element));
            const text = normalize(content?.innerText || content?.textContent);
            if (text) {
                return text;
            }
        }
        return "";
    }, {
        responseSelectors: [...provider.assistantResponseSelectors],
        contentSelectors: [...provider.assistantContentSelectors]
    });
}
async function inspectLatestAssistantResponse(page, provider) {
    return page.evaluate(({ responseSelectors, contentSelectors, completionSelectors, busySelectors }) => {
        const normalize = (value) => (value || "")
            .replace(/\r\n/g, "\n")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        const visible = (element) => {
            const htmlElement = element;
            return Boolean(htmlElement.offsetWidth || htmlElement.offsetHeight || htmlElement.getClientRects().length);
        };
        const allCandidates = Array.from(document.querySelectorAll(responseSelectors.join(", ")));
        const candidates = allCandidates.filter((node) => !allCandidates.some((other) => other !== node && other.contains(node)));
        const node = candidates.at(-1);
        if (!node) {
            return { text: "", count: 0, completionActionReady: false, busy: false };
        }
        const turn = node.closest("section[data-turn-id]") || node;
        const indexedResponse = node.matches("[data-response-index]")
            ? node
            : node.querySelector("[data-response-index]");
        const key = node.getAttribute("data-message-id") ||
            turn.getAttribute("data-turn-id") ||
            indexedResponse?.getAttribute("data-response-index") ||
            `${node.tagName.toLowerCase()}:${candidates.length - 1}`;
        const content = contentSelectors
            .map((selector) => node.matches(selector) ? node : node.querySelector(selector))
            .find((element) => Boolean(element));
        const completionActionReady = completionSelectors.some((selector) => Array.from(turn.querySelectorAll(selector)).some((element) => visible(element) && !element.disabled));
        const busy = busySelectors.some((selector) => Array.from(turn.querySelectorAll(selector)).some(visible));
        return {
            key,
            text: normalize(content?.innerText || content?.textContent || node.innerText || node.textContent),
            count: candidates.length,
            completionActionReady,
            busy
        };
    }, {
        responseSelectors: [...provider.assistantResponseSelectors],
        contentSelectors: [...provider.assistantContentSelectors],
        completionSelectors: [...provider.assistantCompletionSelectors],
        busySelectors: [...provider.assistantBusySelectors]
    });
}
async function captureAssistantResponseBaseline(page, provider) {
    const observation = await inspectLatestAssistantResponse(page, provider);
    return { key: observation.key, text: observation.text, count: observation.count };
}
async function isStreaming(page, provider) {
    for (const selector of provider.stopButtonSelectors) {
        try {
            const locator = page.locator(selector).last();
            if ((await locator.count()) > 0 && (await locator.isVisible())) {
                return true;
            }
        }
        catch {
            // Try the next stop affordance.
        }
    }
    return false;
}
async function stopAssistantGeneration(page, provider) {
    for (const selector of provider.stopButtonSelectors) {
        try {
            const button = page.locator(selector).last();
            if ((await button.count()) > 0 && (await button.isVisible()) && (await button.isEnabled())) {
                await button.click();
                return;
            }
        }
        catch {
            // Stopping is best effort; closing the execution tab is the final cleanup.
        }
    }
}
async function waitForAssistantCompletion(page, provider, options) {
    const stableMs = options.stableMs ?? 4_000;
    const pollMs = options.pollMs ?? 500;
    const settleMs = provider.assistantCompletionSelectors.length > 0 ? Math.min(stableMs, 1_000) : stableMs;
    const startedAt = Date.now();
    let latestText = "";
    let lastChangeAt = Date.now();
    let sawNewResponse = !options.baseline;
    while (Date.now() - startedAt < options.timeoutMs) {
        const observation = await inspectLatestAssistantResponse(page, provider);
        const baseline = options.baseline;
        if (!sawNewResponse &&
            observation.text &&
            baseline &&
            (observation.count > baseline.count ||
                observation.key !== baseline.key ||
                observation.text !== baseline.text)) {
            sawNewResponse = true;
            lastChangeAt = Date.now();
        }
        const text = sawNewResponse ? observation.text : "";
        const streaming = await isStreaming(page, provider) || observation.busy;
        if (text && text !== latestText) {
            latestText = text;
            lastChangeAt = Date.now();
        }
        const stableForMs = Date.now() - lastChangeAt;
        const hasCompletionContract = provider.assistantCompletionSelectors.length > 0;
        const providerReportsComplete = !hasCompletionContract || observation.completionActionReady;
        if (latestText &&
            !isTransientAssistantText(latestText) &&
            providerReportsComplete &&
            stableForMs >= settleMs &&
            !streaming) {
            return { text: latestText, timedOut: false };
        }
        await page.waitForTimeout(pollMs);
    }
    return { text: latestText, timedOut: true };
}
function isTransientAssistantText(text) {
    return /^(thinking|thinking\.{1,3}|思考中|正在思考)[…\.]*$/iu.test(text.trim());
}
