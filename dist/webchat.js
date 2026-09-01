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
const node_crypto_1 = require("node:crypto");
const errors_1 = require("./errors");
const session_1 = require("./session");
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
    const deadlineAt = (0, session_1.resolveDeadlineAt)(options);
    const timeoutMessage = `Timed out opening the ${provider.displayName} chat page.`;
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
    const context = getDefaultContext(browser);
    let page = options.newSession ? undefined : selectReusableChatPage(context, provider, url);
    const created = page === undefined;
    if (!page) {
        page = await newPageWithinDeadline(context, deadlineAt, timeoutMessage);
    }
    try {
        await (0, session_1.raceWithDeadline)(page.bringToFront(), deadlineAt, timeoutMessage);
        const reusingProviderConversation = sameUrl(url, provider.homeUrl) && provider.matchesConversationUrl(page.url());
        if (!sameUrl(page.url(), url) && !reusingProviderConversation) {
            await gotoWithinDeadline(page, url, deadlineAt, timeoutMessage);
        }
        await (0, session_1.raceWithDeadline)(page.bringToFront(), deadlineAt, timeoutMessage);
        return page;
    }
    catch (error) {
        if (created) {
            void page.close().catch(() => undefined);
        }
        throw error;
    }
}
async function openWorkerPage(browser, provider, url = provider.homeUrl, options = {}) {
    const deadlineAt = (0, session_1.resolveDeadlineAt)(options);
    const timeoutMessage = `Timed out opening the ${provider.displayName} worker page.`;
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
    const context = getDefaultContext(browser);
    const page = options.background
        ? await newBackgroundPageWithinDeadline(browser, context, deadlineAt, timeoutMessage)
        : await newPageWithinDeadline(context, deadlineAt, timeoutMessage);
    try {
        if (options.onPageCreated) {
            await (0, session_1.raceWithDeadline)(Promise.resolve().then(() => options.onPageCreated(page)), deadlineAt, timeoutMessage);
        }
        if (!sameUrl(page.url(), url)) {
            await gotoWithinDeadline(page, url, deadlineAt, timeoutMessage);
        }
        return page;
    }
    catch (error) {
        void page.close().catch(() => undefined);
        throw error;
    }
}
async function newBackgroundPageWithinDeadline(browser, context, deadlineAt, timeoutMessage) {
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
    const markerUrl = `about:blank#ask-worker-${(0, node_crypto_1.randomUUID)()}`;
    const browserSession = await (0, session_1.raceWithDeadline)(browser.newBrowserCDPSession(), deadlineAt, timeoutMessage, (lateSession) => lateSession.detach().catch(() => undefined));
    let targetId;
    try {
        const createTarget = browserSession.send("Target.createTarget", {
            url: markerUrl,
            background: true
        });
        const created = await (0, session_1.raceWithDeadline)(createTarget, deadlineAt, timeoutMessage, async (lateTarget) => {
            if (typeof lateTarget.targetId === "string" && lateTarget.targetId) {
                await closeBrowserTarget(browser, lateTarget.targetId);
            }
        });
        if (typeof created.targetId !== "string" || !created.targetId) {
            throw new Error("Chrome did not return a target id for the background worker page.");
        }
        targetId = created.targetId;
        while (true) {
            const page = context.pages().find((candidate) => candidate.url() === markerUrl);
            if (page) {
                return page;
            }
            (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
            await (0, session_1.delayWithinDeadline)(10, deadlineAt, timeoutMessage);
        }
    }
    catch (error) {
        if (targetId) {
            void closeBrowserTarget(browser, targetId);
        }
        throw error;
    }
    finally {
        await browserSession.detach().catch(() => undefined);
    }
}
async function closeBrowserTarget(browser, targetId) {
    let session;
    try {
        session = await browser.newBrowserCDPSession();
        await session.send("Target.closeTarget", { targetId });
    }
    catch {
        // A failed or timed-out worker creation is already returning its primary
        // error. Best-effort target cleanup must not replace that result.
    }
    finally {
        await session?.detach().catch(() => undefined);
    }
}
async function newPageWithinDeadline(context, deadlineAt, timeoutMessage) {
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
    return (0, session_1.raceWithDeadline)(context.newPage(), deadlineAt, timeoutMessage, (latePage) => latePage.close().catch(() => undefined));
}
async function gotoWithinDeadline(page, url, deadlineAt, timeoutMessage) {
    (0, session_1.throwIfDeadlineExceeded)(deadlineAt, timeoutMessage);
    const remainingMs = (0, session_1.remainingDeadlineMs)(deadlineAt);
    await (0, session_1.raceWithDeadline)(page.goto(url, {
        waitUntil: "domcontentloaded",
        ...(remainingMs === undefined ? {} : { timeout: Math.max(1, remainingMs) })
    }), deadlineAt, timeoutMessage);
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
    throw providerFailure(provider, "PROMPT_INPUT_NOT_FOUND", "prompt.find", `Could not find a visible ${provider.displayName} message box within ${timeoutMs}ms.`, `Run \`ask status --provider ${provider.name} --verbose\`.`, true);
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
    const boundedTimeoutMs = Math.max(0, timeoutMs);
    const deadlineAt = Date.now() + boundedTimeoutMs;
    const reserveMs = Math.min(50, Math.max(1, Math.floor(boundedTimeoutMs / 10)));
    const signalTimeoutMs = Math.max(1, boundedTimeoutMs - reserveMs);
    const [promptInputVisible, pageTitle, blockedMarker, signIn, account] = await (0, session_1.raceWithDeadline)(Promise.all([
        hasPromptInput(page, provider, signalTimeoutMs),
        page.title().catch(() => ""),
        hasAnyVisible(page, provider.blockedSelectors, signalTimeoutMs),
        hasAnyVisible(page, provider.signInSelectors, signalTimeoutMs),
        hasAnyAttached(page, provider.accountSelectors)
    ]), deadlineAt, `Timed out inspecting ${provider.displayName} readiness.`);
    const blocked = /just a moment/i.test(pageTitle) || blockedMarker;
    let authState = "unknown";
    if (blocked) {
        authState = "blocked";
    }
    else if (account && signIn) {
        // Mixed signed-in and signed-out markers are common during SPA transitions.
        // Treat the conflict as unknown instead of guessing from locale-dependent copy.
        authState = "unknown";
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
            throw providerFailure(provider, "ATTACHMENT_INVALID", "attachment.upload", `Attachment file does not exist: ${filePath}`, "Check the attachment path, then try again.", false);
        }
        if (!node_fs_1.default.statSync(filePath).isFile()) {
            throw providerFailure(provider, "ATTACHMENT_INVALID", "attachment.upload", `Attachment path is not a regular file: ${filePath}`, "Choose a regular file instead of a directory, then try again.", false);
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
        throw providerFailure(provider, "ATTACHMENT_UPLOAD_FAILED", "attachment.upload", `Could not find a compatible file input or attach button for ${provider.displayName} attachment upload.`, `Run \`ask status --provider ${provider.name} --verbose\`.`, true);
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
    if (error instanceof errors_1.AskFailure) {
        return error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return providerFailure(provider, "ATTACHMENT_UPLOAD_FAILED", "attachment.upload", `${provider.displayName} could not attach the requested file${detail ? `: ${detail}` : "."}`, "Check that the file type is supported and try again.", true, error);
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
        throw providerFailure(provider, "PROMPT_SUBMIT_FAILED", "prompt.submit", `${provider.displayName} send button remained disabled while attachments were processing.`, "Wait for attachments to finish processing, then try again.", true);
    }
    if (input) {
        await input.press("Enter");
        return;
    }
    await page.keyboard.press("Enter");
}
function providerFailure(provider, code, stage, message, hint, retryable, cause) {
    return new errors_1.AskFailure({
        code,
        stage,
        provider: provider.name,
        providerDisplayName: provider.displayName,
        message,
        retryable,
        hint,
        cause
    });
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
