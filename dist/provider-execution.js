"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptDispatchPermit = void 0;
exports.executeProviderPrompt = executeProviderPrompt;
exports.isSubmissionConfirmed = isSubmissionConfirmed;
exports.createChatGptExecutionAdapter = createChatGptExecutionAdapter;
exports.createGeminiExecutionAdapter = createGeminiExecutionAdapter;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const errors_1 = require("./errors");
/**
 * The permit is deliberately stateful and consumed before the selected action runs.
 * An action that throws may already have reached the page, so it can never be retried.
 */
class PromptDispatchPermit {
    consumedBy;
    get consumed() {
        return this.consumedBy !== undefined;
    }
    get strategy() {
        return this.consumedBy;
    }
    consume(strategy) {
        if (this.consumedBy !== undefined) {
            throw new Error(`Prompt dispatch permit was already consumed by "${this.consumedBy}" and cannot be reused by "${strategy}".`);
        }
        this.consumedBy = strategy;
    }
}
exports.PromptDispatchPermit = PromptDispatchPermit;
const DEFAULT_AUTH_POLL_MS = 250;
const DEFAULT_SUBMISSION_POLL_MS = 100;
const DEFAULT_SUBMISSION_CONFIRMATION_MS = 4_000;
async function executeProviderPrompt(page, adapter, options) {
    const deadline = createDeadline(options.timeoutMs, options.onDeadline);
    const authPollMs = Math.max(0, options.authPollMs ?? DEFAULT_AUTH_POLL_MS);
    const submissionPollMs = Math.max(0, options.submissionPollMs ?? DEFAULT_SUBMISSION_POLL_MS);
    let capabilities = await discoverCapabilitiesOrFailure(page, adapter, "readiness.discover", deadline);
    capabilities = await ensureAuthenticatedCapabilities(page, adapter, options, deadline, authPollMs, capabilities, "readiness.discover", (nextCapabilities) => {
        capabilities = nextCapabilities;
    });
    let prepared;
    try {
        prepared = await prepareWithOneRecovery(page, adapter, options, deadline, capabilities, authPollMs, (nextCapabilities) => {
            capabilities = nextCapabilities;
        });
    }
    catch (error) {
        const context = {
            authState: capabilities.auth.state,
            promptInputVisible: capabilities.prompt.available,
            deliveryState: "not-attempted"
        };
        if (error instanceof errors_1.AskFailure) {
            throw mergeFailureContext(error, context);
        }
        throw failure(adapter, "BROWSER_UNAVAILABLE", "readiness.recover", `Could not prepare ${adapter.displayName} before dispatch.`, `Run \`ask status --provider ${adapter.provider} --verbose\`.`, true, context, error);
    }
    ensureTimeRemaining(adapter, deadline, "prompt.submit", "PROMPT_SUBMIT_FAILED");
    // Persist any delivery-ambiguity protection *before* the single permit is
    // consumed. This callback is intentionally awaited: if protection cannot be
    // armed, no click/Enter action is allowed to cross the irreversible boundary.
    await runPreDispatchBeforeDeadline(adapter, deadline, "prompt.submit", "PROMPT_SUBMIT_FAILED", () => Promise.resolve(options.onBeforeDispatch?.({
        dispatchStrategy: prepared.dispatch.name,
        deadlineAt: deadline.deadlineAt,
        remainingMs: deadline.remainingMs()
    })), { preserveUnexpectedError: true });
    const permit = new PromptDispatchPermit();
    permit.consume(prepared.dispatch.name);
    let dispatchError;
    try {
        await withAbsoluteDeadline(() => prepared.dispatch.dispatch(), deadline.deadlineAt);
    }
    catch (error) {
        dispatchError = error;
    }
    // From this point on all code is observation-only. A thrown click/press can still
    // mean the browser received the event, so falling back would risk a duplicate turn.
    const evidenceByName = new Map();
    if (dispatchError) {
        evidenceByName.set("dispatch-action-threw", {
            name: "dispatch-action-threw",
            claim: "dispatch-error",
            strength: "weak",
            detail: errorMessage(dispatchError)
        });
    }
    const confirmationWindowMs = dispatchError
        ? 0
        : Math.min(Math.max(0, options.submissionConfirmationMs ?? DEFAULT_SUBMISSION_CONFIRMATION_MS), deadline.remainingMs());
    const uncertaintyAt = Date.now() + confirmationWindowMs;
    let uncertaintyNotified = false;
    let confirmed = false;
    if (dispatchError) {
        uncertaintyNotified = true;
        notifySubmissionUncertain(options.onSubmissionUncertain, {
            dispatchStrategy: prepared.dispatch.name,
            deadlineAt: deadline.deadlineAt,
            remainingMs: deadline.remainingMs(),
            evidence: [...evidenceByName.values()],
            dispatchError: errorMessage(dispatchError)
        });
    }
    while (deadline.remainingMs() > 0) {
        try {
            const observation = await withAbsoluteDeadline(() => adapter.observeSubmission(page, prepared.baseline, options.prompt), deadline.deadlineAt);
            for (const item of observation.evidence) {
                evidenceByName.set(item.name, item);
            }
        }
        catch (error) {
            if (error instanceof DeadlineExceededError) {
                break;
            }
            evidenceByName.set("submission-observation-failed", {
                name: "submission-observation-failed",
                claim: "dispatch-error",
                strength: "weak",
                detail: errorMessage(error)
            });
        }
        confirmed = isSubmissionConfirmed([...evidenceByName.values()]);
        if (confirmed) {
            break;
        }
        if (!uncertaintyNotified && Date.now() >= uncertaintyAt) {
            uncertaintyNotified = true;
            notifySubmissionUncertain(options.onSubmissionUncertain, {
                dispatchStrategy: prepared.dispatch.name,
                deadlineAt: deadline.deadlineAt,
                remainingMs: deadline.remainingMs(),
                evidence: [...evidenceByName.values()],
                ...(dispatchError ? { dispatchError: errorMessage(dispatchError) } : {})
            });
        }
        const remainingObservationMs = deadline.remainingMs();
        if (remainingObservationMs <= 0) {
            break;
        }
        await waitForObservationUntil(page, submissionPollMs, deadline.deadlineAt);
    }
    const conversationUrl = safePageUrl(page);
    const evidence = [...evidenceByName.values()];
    if (!confirmed) {
        if (deadline.remainingMs() <= 0) {
            await deadline.notify("prompt.confirm");
        }
        return {
            deliveryState: "unknown",
            conversationUrl,
            dispatchStrategy: prepared.dispatch.name,
            evidence,
            ...(dispatchError ? { dispatchError: errorMessage(dispatchError) } : {})
        };
    }
    // From here delivery is proven. A failed cleanup/reporting hook must not
    // turn a confirmed send into a retryable path or permit another dispatch.
    await notifyDeliveryConfirmed(options.onDeliveryConfirmed, {
        dispatchStrategy: prepared.dispatch.name,
        deadlineAt: deadline.deadlineAt,
        remainingMs: deadline.remainingMs(),
        conversationUrl,
        evidence
    });
    const persistedConversationUrls = new Map();
    const persistConfirmedConversationUrl = async (candidate) => {
        if (!options.onSubmissionConfirmed ||
            !adapter.matchesConversationUrl(candidate) ||
            deadline.remainingMs() <= 0) {
            return;
        }
        const existingPersistence = persistedConversationUrls.get(candidate);
        if (existingPersistence) {
            await existingPersistence;
            return;
        }
        const persistence = (async () => {
            try {
                await withAbsoluteDeadline(() => Promise.resolve(options.onSubmissionConfirmed(candidate)), deadline.deadlineAt);
            }
            catch {
                // Persistence is best effort here. Delivery is already confirmed and must never replay;
                // normal post-response conversation persistence gets another opportunity.
            }
        })();
        persistedConversationUrls.set(candidate, persistence);
        await persistence;
    };
    await persistConfirmedConversationUrl(conversationUrl);
    let watchForConversationUrl = true;
    if (options.onSubmissionConfirmed) {
        void (async () => {
            while (watchForConversationUrl && deadline.remainingMs() > 0) {
                await persistConfirmedConversationUrl(safePageUrl(page));
                if (!watchForConversationUrl || deadline.remainingMs() <= 0) {
                    return;
                }
                await waitForTimerUntil(25, deadline.deadlineAt);
            }
        })().catch(() => undefined);
    }
    let watchForPartialResponse = true;
    let latestSafePartial = "";
    if (adapter.capturePartialResponse) {
        void (async () => {
            while (watchForPartialResponse && deadline.remainingMs() > 0) {
                try {
                    const partial = await withAbsoluteDeadline(() => adapter.capturePartialResponse(page, prepared.baseline), deadline.deadlineAt);
                    if (partial) {
                        latestSafePartial = partial;
                    }
                }
                catch (error) {
                    if (error instanceof DeadlineExceededError) {
                        return;
                    }
                }
                if (!watchForPartialResponse || deadline.remainingMs() <= 0) {
                    return;
                }
                await waitForTimerUntil(100, deadline.deadlineAt);
            }
        })().catch(() => undefined);
    }
    const responseTimeoutMs = deadline.remainingMs();
    if (responseTimeoutMs <= 0) {
        await deadline.notify("response.wait");
    }
    let response;
    try {
        response = await withAbsoluteDeadline(() => adapter.waitForResponse(page, {
            timeoutMs: responseTimeoutMs,
            baseline: prepared.baseline
        }), deadline.deadlineAt);
    }
    catch (error) {
        watchForConversationUrl = false;
        watchForPartialResponse = false;
        const latestConversationUrl = safePageUrl(page);
        await persistConfirmedConversationUrl(latestConversationUrl);
        const knownConversationUrl = adapter.matchesConversationUrl(latestConversationUrl)
            ? latestConversationUrl
            : adapter.matchesConversationUrl(conversationUrl)
                ? conversationUrl
                : undefined;
        if (error instanceof DeadlineExceededError) {
            response = {
                text: latestSafePartial,
                timedOut: true,
                ...(knownConversationUrl ? { conversationUrl: knownConversationUrl } : {})
            };
        }
        else if (error instanceof errors_1.AskFailure) {
            throw mergeFailureContext(error, {
                deliveryState: "confirmed",
                ...(knownConversationUrl ? { conversationUrl: knownConversationUrl } : {})
            }, false);
        }
        else {
            throw failure(adapter, "RESPONSE_NOT_DETECTED", "response.wait", `Prompt delivery was confirmed, but the ${adapter.displayName} response could not be observed.`, "Do not resend the prompt. Reopen or continue the provider conversation.", false, {
                deliveryState: "confirmed",
                ...(knownConversationUrl ? { conversationUrl: knownConversationUrl } : {})
            }, error);
        }
    }
    watchForConversationUrl = false;
    watchForPartialResponse = false;
    await persistConfirmedConversationUrl(safePageUrl(page));
    if (response.timedOut && deadline.remainingMs() <= 0) {
        await deadline.notify("response.wait");
    }
    return {
        deliveryState: "confirmed",
        conversationUrl: safePageUrl(page),
        dispatchStrategy: prepared.dispatch.name,
        evidence,
        response: {
            ...response,
            conversationUrl: response.conversationUrl || safePageUrl(page)
        }
    };
}
function isSubmissionConfirmed(evidence) {
    const submissionEvidence = evidence.filter((item) => item.claim === "submission");
    if (submissionEvidence.some((item) => item.strength === "strong")) {
        return true;
    }
    const independentWeakSignals = new Set(submissionEvidence
        .filter((item) => item.strength === "weak")
        .map((item) => item.independenceKey || item.name));
    return independentWeakSignals.size >= 2;
}
async function ensureAuthenticatedCapabilities(page, adapter, options, deadline, authPollMs, initialCapabilities, initialStage, onCapabilities) {
    let capabilities = initialCapabilities;
    onCapabilities?.(capabilities);
    if (hasStrongAuth(capabilities)) {
        return capabilities;
    }
    if (!options.onAuthHandoff) {
        assertNotBlocked(adapter, capabilities, initialStage);
        throw authFailure(adapter, capabilities);
    }
    ensureTimeRemaining(adapter, deadline, "auth.handoff", "AUTH_HANDOFF_TIMEOUT");
    const waitForReady = async () => {
        while (deadline.remainingMs() > 0) {
            try {
                const current = await withAbsoluteDeadline(() => adapter.discoverCapabilities(page), deadline.deadlineAt);
                capabilities = current;
                onCapabilities?.(capabilities);
                if (hasStrongAuth(current)) {
                    return current;
                }
            }
            catch (error) {
                if (error instanceof DeadlineExceededError) {
                    break;
                }
                // Provider SPAs can replace the document while auth completes. Keep polling
                // until the shared deadline instead of turning a transient read into a rerun.
            }
            await waitOnPageUntil(page, authPollMs, deadline.deadlineAt);
        }
        await deadline.notify("auth.handoff");
        throw failure(adapter, "AUTH_HANDOFF_TIMEOUT", "auth.handoff", `${adapter.displayName} did not become signed in before the command deadline.`, `Finish signing in, then retry with \`ask --provider ${adapter.provider}\`.`, true, { authState: capabilities.auth.state, deliveryState: "not-attempted" });
    };
    try {
        await withAbsoluteDeadline(() => options.onAuthHandoff(waitForReady, {
            deadlineAt: deadline.deadlineAt,
            remainingMs: deadline.remainingMs()
        }), deadline.deadlineAt);
    }
    catch (error) {
        if (!(error instanceof DeadlineExceededError)) {
            throw error;
        }
        await deadline.notify("auth.handoff");
        throw failure(adapter, "AUTH_HANDOFF_TIMEOUT", "auth.handoff", `${adapter.displayName} did not become signed in before the command deadline.`, `Finish signing in, then retry with \`ask --provider ${adapter.provider}\`.`, true, { authState: capabilities.auth.state, deliveryState: "not-attempted" }, error);
    }
    capabilities = await discoverCapabilitiesOrFailure(page, adapter, "auth.handoff", deadline);
    onCapabilities?.(capabilities);
    assertNotBlocked(adapter, capabilities, "auth.handoff");
    if (!hasStrongAuth(capabilities)) {
        throw authFailure(adapter, capabilities);
    }
    return capabilities;
}
async function prepareWithOneRecovery(page, adapter, options, deadline, initialCapabilities, authPollMs, onCapabilities) {
    let capabilities = initialCapabilities;
    let recoveryAttempts = 0;
    while (true) {
        try {
            await runPreDispatchBeforeDeadline(adapter, deadline, "attachment.upload", "ATTACHMENT_UPLOAD_FAILED", () => adapter.attachAndVerify(page, options.attachments, deadline.deadlineAt));
            await runPreDispatchBeforeDeadline(adapter, deadline, "prompt.verify", "PROMPT_FILL_UNCONFIRMED", () => adapter.fillAndVerifyDraft(page, options.prompt, deadline.deadlineAt));
            const dispatch = await runPreDispatchBeforeDeadline(adapter, deadline, "prompt.submit", "PROMPT_SUBMIT_FAILED", () => adapter.preselectDispatch(page, deadline.deadlineAt));
            const baseline = await runPreDispatchBeforeDeadline(adapter, deadline, "response.baseline", "PROMPT_SUBMIT_FAILED", () => adapter.captureBaseline(page));
            return { baseline, dispatch };
        }
        catch (error) {
            if (isCommandDeadlineFailure(error) ||
                recoveryAttempts >= 1 ||
                !isRecoverablePreSubmitFailure(error) ||
                deadline.remainingMs() <= 0) {
                if (deadline.remainingMs() <= 0) {
                    await deadline.notify("readiness.recover");
                }
                throw error;
            }
            recoveryAttempts += 1;
            try {
                const callbackResult = options.onPreSubmitRecovery?.({
                    attempt: 1,
                    cause: error,
                    deadlineAt: deadline.deadlineAt,
                    remainingMs: deadline.remainingMs()
                });
                void Promise.resolve(callbackResult).catch(() => undefined);
            }
            catch {
                // A progress callback is not part of provider readiness.
            }
            if (adapter.recoverBeforeSubmit) {
                try {
                    await runPreDispatchBeforeDeadline(adapter, deadline, "readiness.recover", "BROWSER_UNAVAILABLE", () => adapter.recoverBeforeSubmit(page, error, deadline.deadlineAt));
                }
                catch (recoveryError) {
                    // A recovery reload can itself fail during an SPA transition. When
                    // the original preparation failure was already structured, keep its
                    // precise stage/code instead of hiding it behind a generic browser
                    // failure.
                    if (error instanceof errors_1.AskFailure) {
                        throw error;
                    }
                    throw recoveryError;
                }
            }
            else {
                await waitOnPageUntil(page, 100, deadline.deadlineAt);
            }
            capabilities = await discoverCapabilitiesOrFailure(page, adapter, "readiness.recover", deadline);
            onCapabilities(capabilities);
            capabilities = await ensureAuthenticatedCapabilities(page, adapter, options, deadline, authPollMs, capabilities, "readiness.recover", onCapabilities);
            onCapabilities(capabilities);
        }
    }
}
function isCommandDeadlineFailure(error) {
    return error instanceof errors_1.AskFailure && error.cause instanceof DeadlineExceededError;
}
function isRecoverablePreSubmitFailure(error) {
    return !(error instanceof errors_1.AskFailure) || error.retryable;
}
function createDeadline(timeoutMs, onDeadline) {
    const startedAt = Date.now();
    const deadlineAt = startedAt + Math.max(0, timeoutMs);
    let notified = false;
    return {
        startedAt,
        deadlineAt,
        remainingMs: () => Math.max(0, deadlineAt - Date.now()),
        notify: async (phase) => {
            if (notified) {
                return;
            }
            notified = true;
            try {
                const callbackResult = onDeadline?.({
                    phase,
                    deadlineAt,
                    elapsedMs: Date.now() - startedAt
                });
                void Promise.resolve(callbackResult).catch(() => undefined);
            }
            catch {
                // Deadline reporting cannot change delivery semantics.
            }
        }
    };
}
async function discoverCapabilitiesOrFailure(page, adapter, stage, deadline) {
    try {
        return await runPreDispatchBeforeDeadline(adapter, deadline, stage, stage === "auth.handoff" ? "AUTH_HANDOFF_TIMEOUT" : "BROWSER_UNAVAILABLE", () => adapter.discoverCapabilities(page));
    }
    catch (error) {
        if (error instanceof errors_1.AskFailure) {
            throw mergeFailureContext(error, { deliveryState: "not-attempted" });
        }
        throw failure(adapter, "BROWSER_UNAVAILABLE", stage, `Could not inspect ${adapter.displayName} readiness.`, `Run \`ask status --provider ${adapter.provider} --verbose\`.`, true, { deliveryState: "not-attempted" }, error);
    }
}
class DeadlineExceededError extends Error {
    constructor() {
        super("The command deadline expired before the operation completed.");
        this.name = "DeadlineExceededError";
    }
}
async function withAbsoluteDeadline(operation, deadlineAt) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
        throw new DeadlineExceededError();
    }
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError()), remainingMs);
    });
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            timeout
        ]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
async function runPreDispatchBeforeDeadline(adapter, deadline, stage, code, operation, options = {}) {
    ensureTimeRemaining(adapter, deadline, stage, code);
    try {
        return await withAbsoluteDeadline(operation, deadline.deadlineAt);
    }
    catch (error) {
        if (error instanceof errors_1.AskFailure) {
            throw error;
        }
        if (!(error instanceof DeadlineExceededError)) {
            if (options.preserveUnexpectedError) {
                throw error;
            }
            throw failure(adapter, code, stage, `${adapter.displayName} failed while preparing ${preDispatchStageLabel(stage)} before dispatch.`, "Wait for the provider page to settle, then retry. No prompt was sent.", true, { deliveryState: "not-attempted" }, error);
        }
        await deadline.notify(stage);
        throw failure(adapter, code, stage, `${adapter.displayName} did not become ready before the command deadline.`, "Retry with a longer --timeout after the provider page has finished loading.", true, { deliveryState: "not-attempted" }, error);
    }
}
function preDispatchStageLabel(stage) {
    switch (stage) {
        case "attachment.upload":
            return "attachments";
        case "prompt.verify":
            return "the verified draft";
        case "prompt.submit":
            return "the selected submission action";
        case "response.baseline":
            return "the response baseline";
        case "readiness.recover":
            return "provider recovery";
        default:
            return "provider readiness";
    }
}
function notifySubmissionUncertain(callback, event) {
    try {
        const callbackResult = callback?.(event);
        void Promise.resolve(callbackResult).catch(() => undefined);
    }
    catch {
        // Progress/reporting hooks cannot cross the irreversible dispatch boundary.
    }
}
async function notifyDeliveryConfirmed(callback, event) {
    try {
        await callback?.(event);
    }
    catch {
        // Marker cleanup is helpful once delivery is proven, but failure cannot
        // alter exactly-once semantics. The conservative marker remains for a
        // later guarded lifecycle retry.
    }
}
function mergeFailureContext(error, context, retryable = error.retryable) {
    return new errors_1.AskFailure({
        code: error.code,
        stage: error.stage,
        provider: error.provider,
        providerDisplayName: error.providerDisplayName,
        message: error.message,
        hint: error.hint,
        retryable,
        detail: error.detail,
        context: { ...error.context, ...context },
        cause: error.cause,
        exitCode: error.exitCode
    });
}
function hasStrongAuth(capabilities) {
    return capabilities.auth.state === "signed-in-likely" && capabilities.auth.confidence === "strong";
}
function assertNotBlocked(adapter, capabilities, stage) {
    if (capabilities.auth.state !== "blocked") {
        return;
    }
    throw failure(adapter, "PROVIDER_BLOCKED", stage, `${adapter.displayName} is showing a verification or access-blocking page.`, "Complete the browser verification in the visible ask Chrome session, then retry.", true, { authState: "blocked", deliveryState: "not-attempted" });
}
function authFailure(adapter, capabilities) {
    const authRequired = capabilities.auth.state === "login-required" || capabilities.auth.state === "guest";
    return failure(adapter, authRequired ? "AUTH_REQUIRED" : "AUTH_UNCONFIRMED", "auth.inspect", authRequired
        ? `${adapter.displayName} requires a signed-in session before ask can send this prompt.`
        : `${adapter.displayName} sign-in readiness could not be confirmed strongly.`, `Run \`ask login --provider ${adapter.provider}\`, finish signing in, then retry.`, true, {
        authState: capabilities.auth.state,
        promptInputVisible: capabilities.prompt.available,
        deliveryState: "not-attempted"
    });
}
function ensureTimeRemaining(adapter, deadline, stage, code) {
    if (deadline.remainingMs() > 0) {
        return;
    }
    throw failure(adapter, code, stage, `${adapter.displayName} did not become ready before the command deadline.`, "Retry with a longer --timeout after the provider page has finished loading.", true, { deliveryState: "not-attempted" });
}
function failure(adapter, code, stage, message, hint, retryable, context, cause) {
    return new errors_1.AskFailure({
        code,
        stage,
        provider: adapter.provider,
        providerDisplayName: adapter.displayName,
        message,
        hint,
        retryable,
        context,
        cause
    });
}
function safePageUrl(page) {
    try {
        return page.url();
    }
    catch {
        return "";
    }
}
function matchesChatGptConversationUrl(value) {
    if (!value) {
        return false;
    }
    try {
        const url = new URL(value);
        return (url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com")) &&
            /^\/c\/[^/]+/.test(url.pathname);
    }
    catch {
        return false;
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function waitOnPage(page, timeoutMs) {
    if (timeoutMs <= 0) {
        await Promise.resolve();
        return;
    }
    await page.waitForTimeout(timeoutMs);
}
async function waitOnPageUntil(page, timeoutMs, deadlineAt) {
    const boundedMs = Math.min(Math.max(0, timeoutMs), Math.max(0, deadlineAt - Date.now()));
    if (boundedMs <= 0) {
        return;
    }
    try {
        await withAbsoluteDeadline(() => waitOnPage(page, boundedMs), deadlineAt);
    }
    catch (error) {
        if (!(error instanceof DeadlineExceededError)) {
            throw error;
        }
    }
}
async function waitForObservation(page, timeoutMs) {
    if (timeoutMs <= 0) {
        return;
    }
    try {
        await page.waitForTimeout(timeoutMs);
    }
    catch {
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    }
}
async function waitForObservationUntil(page, timeoutMs, deadlineAt) {
    const boundedMs = Math.min(Math.max(0, timeoutMs), Math.max(0, deadlineAt - Date.now()));
    if (boundedMs <= 0) {
        return;
    }
    try {
        await withAbsoluteDeadline(() => waitForObservation(page, boundedMs), deadlineAt);
    }
    catch (error) {
        if (!(error instanceof DeadlineExceededError)) {
            throw error;
        }
    }
}
async function waitForTimerUntil(timeoutMs, deadlineAt) {
    const boundedMs = Math.min(Math.max(0, timeoutMs), Math.max(0, deadlineAt - Date.now()));
    if (boundedMs <= 0) {
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, boundedMs));
}
const CHATGPT_PROMPT_STRATEGIES = [
    cssStrategy("chatgpt.prompt-id", "#prompt-textarea", "strong"),
    cssStrategy("chatgpt.prompt-testid", '[data-testid="prompt-textarea"]', "strong"),
    cssStrategy("chatgpt.composer-region-role", '[data-testid*="composer"] [contenteditable="true"][role="textbox"]', "weak"),
    cssStrategy("chatgpt.composer-form-role", 'main form [contenteditable="true"][role="textbox"], main form textarea', "weak")
];
const CHATGPT_ACCOUNT_STRATEGIES = [
    cssStrategy("chatgpt.account-profile-testid", '[data-testid="accounts-profile-button"]', "strong"),
    cssStrategy("chatgpt.profile-testid", '[data-testid="profile-button"]', "strong"),
    cssStrategy("chatgpt.account-menu-structure", 'nav button[aria-haspopup="menu"]', "weak")
];
const CHATGPT_SIGN_IN_STRATEGIES = [
    cssStrategy("chatgpt.login-href", 'a[href*="/auth/login"]', "strong"),
    cssStrategy("chatgpt.login-testid", '[data-testid="login-button"]', "strong"),
    cssStrategy("chatgpt.signup-href", 'a[href*="/auth/signup"]', "strong")
];
const CHATGPT_BLOCKED_STRATEGIES = [
    cssStrategy("chatgpt.cloudflare-frame", 'iframe[src*="challenges.cloudflare.com"]', "strong"),
    cssStrategy("chatgpt.challenge-testid", '[data-testid*="challenge"]', "strong"),
    cssStrategy("chatgpt.turnstile", '[data-testid="cf-turnstile"]', "strong")
];
const CHATGPT_FILE_INPUT_STRATEGIES = [
    cssStrategy("chatgpt.file-input", 'input[type="file"]', "strong")
];
const CHATGPT_ATTACHMENT_ROOT_SELECTOR = [
    '[data-testid*="composer"] [data-testid="file-thumbnail"]',
    'main form [data-testid="file-thumbnail"]',
    '[data-testid*="composer"] [data-testid="attachment-pill"]',
    'main form [data-testid="attachment-pill"]',
    '[data-testid*="composer"] [data-testid="attachment-preview"]',
    'main form [data-testid="attachment-preview"]',
    '[data-testid*="composer"] [data-testid="upload-preview"]',
    'main form [data-testid="upload-preview"]'
].join(", ");
const CHATGPT_ATTACHMENT_REMOVE_STRATEGIES = [
    cssStrategy("chatgpt.attachment-remove-testid", '[data-testid*="composer"] button[data-testid*="remove"], main form button[data-testid*="remove"]', "strong"),
    cssStrategy("chatgpt.file-thumbnail-remove", '[data-testid*="composer"] [data-testid="file-thumbnail"] button, main form [data-testid="file-thumbnail"] button', "weak"),
    cssStrategy("chatgpt.attachment-preview-remove", '[data-testid*="composer"] [data-testid="attachment-preview"] button, ' +
        'main form [data-testid="attachment-preview"] button, ' +
        '[data-testid*="composer"] [data-testid="attachment-pill"] button, ' +
        'main form [data-testid="attachment-pill"] button', "weak"),
    cssStrategy("chatgpt.attachment-remove-label", '[data-testid*="composer"] button[aria-label*="Remove" i], main form button[aria-label*="Remove" i], ' +
        '[data-testid*="composer"] button[aria-label*="Delete" i], main form button[aria-label*="Delete" i], ' +
        '[data-testid*="composer"] button[aria-label*="移除"], main form button[aria-label*="移除"], ' +
        '[data-testid*="composer"] button[aria-label*="刪除"], main form button[aria-label*="刪除"]', "weak")
];
const CHATGPT_SEND_STRATEGIES = [
    cssStrategy("chatgpt.send-testid", 'button[data-testid="send-button"]', "strong"),
    cssStrategy("chatgpt.composer-submit-testid", 'button[data-testid="composer-submit-button"]', "strong"),
    cssStrategy("chatgpt.form-submit", 'main form button[type="submit"]', "weak")
];
const CHATGPT_RESPONSE_STRATEGIES = [
    cssStrategy("chatgpt.assistant-role", '[data-message-author-role="assistant"]', "strong"),
    cssStrategy("chatgpt.conversation-main", "main", "weak")
];
const CHATGPT_STOP_STRATEGIES = [
    cssStrategy("chatgpt.stop-testid", 'button[data-testid="stop-button"]', "strong"),
    cssStrategy("chatgpt.composer-stop-testid", 'button[data-testid="composer-stop-button"]', "strong")
];
/** Builds the ChatGPT-specific, locale-independent execution adapter. */
function createChatGptExecutionAdapter(options) {
    const pollMs = Math.max(0, options.pollMs ?? 100);
    const attachmentVerificationMs = Math.max(0, options.attachmentVerificationMs ?? 5_000);
    // A fresh ChatGPT page can expose its fallback textarea before the rich
    // composer finishes hydrating. On a real headed Chrome session that
    // transition can take several seconds, so keep this bounded by the command's
    // shared deadline but do not fail an otherwise healthy first request after
    // only 1.5 seconds.
    const draftVerificationMs = Math.max(0, options.draftVerificationMs ?? 10_000);
    return {
        provider: "chatgpt",
        displayName: "ChatGPT",
        matchesConversationUrl: options.matchesConversationUrl || matchesChatGptConversationUrl,
        discoverCapabilities: (page) => discoverChatGptCapabilities(page),
        attachAndVerify: (page, filePaths, deadlineAt) => attachAndVerifyChatGptFiles(page, options.automation, filePaths, Math.min(deadlineAt, Date.now() + attachmentVerificationMs), pollMs),
        fillAndVerifyDraft: (page, prompt, deadlineAt) => fillAndVerifyChatGptDraft(page, prompt, Math.min(deadlineAt, Date.now() + draftVerificationMs), pollMs),
        captureBaseline: (page) => captureChatGptBaseline(page),
        preselectDispatch: (page, deadlineAt) => preselectChatGptDispatch(page, deadlineAt, pollMs),
        observeSubmission: (page, baseline, prompt) => observeChatGptSubmission(page, baseline, prompt, options.matchesConversationUrl || matchesChatGptConversationUrl),
        capturePartialResponse: (page, baseline) => captureChatGptPartialResponse(page, baseline, options.automation.extractLatestAssistantText),
        waitForResponse: (page, responseOptions) => options.automation.waitForAssistantCompletion(page, {
            timeoutMs: responseOptions.timeoutMs,
            baseline: assistantBaseline(responseOptions.baseline)
        }),
        recoverBeforeSubmit: async (page, _cause, deadlineAt) => {
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) {
                return;
            }
            await page.reload({
                waitUntil: "domcontentloaded",
                timeout: remainingMs
            });
            await discoverChatGptCapabilities(page);
        }
    };
}
async function discoverChatGptCapabilities(page) {
    const prompt = await firstEditableStrategy(page, CHATGPT_PROMPT_STRATEGIES);
    const accountEvidence = await collectStrategyEvidence(page, CHATGPT_ACCOUNT_STRATEGIES, "auth-ready", "visible-or-attached");
    const signInEvidence = await collectStrategyEvidence(page, CHATGPT_SIGN_IN_STRATEGIES, "auth-required", "visible");
    const blockedEvidence = await collectStrategyEvidence(page, CHATGPT_BLOCKED_STRATEGIES, "provider-blocked", "visible-or-attached");
    const fileInput = await firstAttachedStrategy(page, CHATGPT_FILE_INPUT_STRATEGIES);
    const send = await firstActionableClickStrategy(page, CHATGPT_SEND_STRATEGIES, 250);
    const responseObserver = await firstVisibleStrategy(page, CHATGPT_RESPONSE_STRATEGIES);
    const promptEvidence = prompt ? [strategyEvidence(prompt.strategy, "prompt-input")] : [];
    const attachmentEvidence = fileInput
        ? [strategyEvidence(fileInput.strategy, "attachment-input")]
        : [];
    const clickEvidence = send ? [strategyEvidence(send.strategy, "dispatch")] : [];
    const enterEvidence = prompt
        ? [{
                name: "chatgpt.composer-enter",
                claim: "dispatch",
                strength: "weak",
                detail: `Enter through ${prompt.strategy.name}`
            }]
        : [];
    const responseEvidence = responseObserver
        ? [strategyEvidence(responseObserver.strategy, "response-observation")]
        : [];
    const auth = aggregateAuth(accountEvidence, signInEvidence, blockedEvidence, Boolean(prompt));
    const evidence = [
        ...auth.evidence,
        ...promptEvidence,
        ...attachmentEvidence,
        ...clickEvidence,
        ...enterEvidence,
        ...responseEvidence
    ];
    return {
        url: safePageUrl(page),
        auth,
        prompt: capability(prompt?.strategy.name, promptEvidence),
        attachment: capability(fileInput?.strategy.name, attachmentEvidence),
        clickDispatch: capability(send?.strategy.name, clickEvidence),
        enterDispatch: capability(prompt ? "chatgpt.composer-enter" : undefined, enterEvidence),
        response: capability(responseObserver?.strategy.name, responseEvidence),
        evidence
    };
}
function aggregateAuth(ready, required, blocked, promptAvailable) {
    if (blocked.length > 0 && (ready.length > 0 || required.length > 0)) {
        return {
            state: "unknown",
            confidence: "conflicting",
            evidence: [...blocked, ...ready, ...required]
        };
    }
    if (blocked.length > 0) {
        return { state: "blocked", confidence: strongestConfidence(blocked), evidence: blocked };
    }
    if (ready.length > 0 && required.length > 0) {
        return {
            state: "unknown",
            confidence: "conflicting",
            evidence: [...ready, ...required]
        };
    }
    if (ready.length > 0) {
        return {
            state: "signed-in-likely",
            confidence: strongestConfidence(ready),
            evidence: ready
        };
    }
    if (required.length > 0) {
        return {
            state: promptAvailable ? "guest" : "login-required",
            confidence: strongestConfidence(required),
            evidence: required
        };
    }
    return {
        state: "unknown",
        confidence: promptAvailable ? "weak" : "none",
        evidence: promptAvailable
            ? [{
                    name: "chatgpt.prompt-without-auth-marker",
                    claim: "auth-ready",
                    strength: "weak",
                    detail: "A composer alone does not prove an authenticated account."
                }]
            : []
    };
}
function strongestConfidence(evidence) {
    return evidence.some((item) => item.strength === "strong") ? "strong" : "weak";
}
function capability(strategy, evidence) {
    return {
        available: strategy !== undefined,
        ...(strategy ? { strategy } : {}),
        evidence
    };
}
async function attachAndVerifyChatGptFiles(page, automation, filePaths, verificationDeadline, pollMs) {
    const resolvedPaths = filePaths.map((filePath) => node_path_1.default.resolve(filePath));
    validateAttachmentPaths(resolvedPaths);
    const requestedNames = resolvedPaths.map((filePath) => node_path_1.default.basename(filePath));
    const requestedCounts = countNames(requestedNames);
    await clearChatGptComposerAttachments(page, requestedNames, verificationDeadline, pollMs);
    if (resolvedPaths.length === 0) {
        return { files: [] };
    }
    await automation.attachFiles(page, resolvedPaths);
    let surface;
    do {
        surface = await readAttachmentSurfaceState(page, requestedNames);
        const hasEveryFinishedAttachment = [...requestedCounts].every(([name, count]) => (surface.entriesByName.get(name) || []).filter((entry) => !entry.pending).length >= count);
        if (hasEveryFinishedAttachment) {
            const evidenceIndexByName = new Map();
            return {
                files: resolvedPaths.map((filePath) => {
                    const name = node_path_1.default.basename(filePath);
                    const evidenceIndex = evidenceIndexByName.get(name) || 0;
                    evidenceIndexByName.set(name, evidenceIndex + 1);
                    const finishedEntries = (surface.entriesByName.get(name) || [])
                        .filter((entry) => !entry.pending);
                    return {
                        path: filePath,
                        name,
                        evidence: finishedEntries[evidenceIndex].evidence
                    };
                })
            };
        }
        if (Date.now() >= verificationDeadline) {
            break;
        }
        await waitOnPage(page, Math.min(pollMs, verificationDeadline - Date.now()));
    } while (true);
    const unresolved = [...requestedCounts].flatMap(([name, count]) => {
        const finishedCount = (surface.entriesByName.get(name) || [])
            .filter((entry) => !entry.pending).length;
        const missingCount = Math.max(0, count - finishedCount);
        return missingCount > 0 ? [`${name}${missingCount > 1 ? ` (x${missingCount})` : ""}`] : [];
    });
    throw chatGptFailure("ATTACHMENT_UPLOAD_FAILED", "attachment.upload", `ChatGPT did not show finished composer attachment state for: ${unresolved.join(", ")}.`, "Wait for attachment processing to finish and retry once.", true);
}
function validateAttachmentPaths(filePaths) {
    for (const filePath of filePaths) {
        if (!node_fs_1.default.existsSync(filePath)) {
            throw chatGptFailure("ATTACHMENT_INVALID", "attachment.upload", `Attachment file does not exist: ${filePath}`, "Check the attachment path, then try again.", false);
        }
        if (!node_fs_1.default.statSync(filePath).isFile()) {
            throw chatGptFailure("ATTACHMENT_INVALID", "attachment.upload", `Attachment path is not a regular file: ${filePath}`, "Choose a regular file instead of a directory, then try again.", false);
        }
    }
}
async function readAttachmentSurfaceState(page, requestedNames) {
    const entriesByName = new Map();
    const selectedNames = [];
    const inputs = page.locator('input[type="file"]');
    try {
        const count = await inputs.count();
        for (let index = 0; index < count; index += 1) {
            const names = await inputs.nth(index).evaluate((element) => Array.from(element.files || []).map((file) => file.name));
            for (const name of names) {
                selectedNames.push(name);
            }
        }
    }
    catch {
        // ChatGPT commonly replaces or clears the input after accepting an upload.
    }
    const selectedCountByName = countNames(selectedNames);
    try {
        const requestedIdentities = [...new Set(requestedNames)].map((name) => ({
            name,
            patternSource: attachmentIdentityPatternSource(name)
        }));
        const observation = await page.evaluate((identities) => {
            const candidateNodes = Array.from(document.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"], [data-testid*="upload"], [aria-label]')).filter((node) => node.closest('form, [data-testid*="composer"]'));
            const rootFor = (node) => node.closest('[data-testid*="attachment"]') ||
                node.closest('[data-testid*="file"]') ||
                node.closest('[data-testid*="upload"]') ||
                node;
            const roots = [...new Set(candidateNodes.map(rootFor))].filter((node) => {
                if (node.hidden || node.getAttribute("aria-hidden") === "true") {
                    return false;
                }
                const style = getComputedStyle(node);
                return style.display !== "none" && style.visibility !== "hidden";
            });
            const valuesFor = (node) => {
                const relevant = [node, ...Array.from(node.querySelectorAll('[aria-label], [title], [download], [data-file-name], [data-filename]'))];
                return relevant.flatMap((element) => [
                    element.getAttribute("data-file-name"),
                    element.getAttribute("data-filename"),
                    element.getAttribute("title"),
                    element.getAttribute("download"),
                    element.getAttribute("aria-label"),
                    element === node ? element.innerText || element.textContent : undefined
                ]).filter((value) => Boolean(value?.trim()))
                    .map((value) => value.normalize("NFC").trim());
            };
            const isPending = (node) => {
                const state = `${node.getAttribute("data-state") || ""} ${node.getAttribute("data-status") || ""}`;
                return /upload|pending|progress/i.test(state) ||
                    node.getAttribute("aria-busy") === "true" ||
                    Boolean(node.querySelector('progress, [role="progressbar"], [aria-busy="true"], [data-testid*="progress"], [data-state*="upload"]'));
            };
            return roots.flatMap((node, rootIndex) => {
                const values = valuesFor(node);
                return identities.flatMap(({ name, patternSource }) => {
                    const matcher = new RegExp(patternSource, "u");
                    if (!values.some((value) => value === name || matcher.test(value))) {
                        return [];
                    }
                    return [{ name, pending: isPending(node), identity: `${rootIndex}` }];
                });
            });
        }, requestedIdentities);
        for (const attachment of observation) {
            const entries = entriesByName.get(attachment.name) || [];
            entries.push({
                pending: attachment.pending,
                evidence: {
                    name: `chatgpt.attachment-ui:${attachment.name}:${attachment.identity}`,
                    claim: "attachment-input",
                    strength: "strong",
                    detail: attachment.name
                }
            });
            entriesByName.set(attachment.name, entries);
        }
    }
    catch {
        // Transitional pages may not have a readable DOM yet; the caller polls.
    }
    return { entriesByName, selectedCountByName, selectedFileCount: selectedNames.length };
}
async function clearChatGptComposerAttachments(page, requestedNames, deadlineAt, pollMs) {
    const fileInputs = page.locator('input[type="file"]');
    try {
        const inputCount = await fileInputs.count();
        for (let index = 0; index < inputCount; index += 1) {
            await fileInputs.nth(index).setInputFiles([]).catch(() => undefined);
        }
    }
    catch {
        // ChatGPT may replace the file input while clearing its composer state.
    }
    let removals = 0;
    while (Date.now() < deadlineAt && removals < 50) {
        const remove = await firstActionableClickStrategy(page, CHATGPT_ATTACHMENT_REMOVE_STRATEGIES, Math.min(250, Math.max(1, deadlineAt - Date.now())));
        if (!remove) {
            break;
        }
        await remove.locator.click({ timeout: Math.max(1, deadlineAt - Date.now()) });
        removals += 1;
        await waitOnPage(page, Math.min(pollMs, Math.max(0, deadlineAt - Date.now())));
    }
    const [surface, knownRoots, remainingRemove] = await Promise.all([
        readAttachmentSurfaceState(page, requestedNames),
        page.locator(CHATGPT_ATTACHMENT_ROOT_SELECTOR).count().catch(() => 0),
        firstVisibleStrategy(page, CHATGPT_ATTACHMENT_REMOVE_STRATEGIES)
    ]);
    const matchingNamesRemain = [...new Set(requestedNames)].filter((name) => (surface.entriesByName.get(name)?.length || 0) > 0 ||
        (surface.selectedCountByName.get(name) || 0) > 0);
    if (matchingNamesRemain.length > 0 ||
        surface.selectedFileCount > 0 ||
        knownRoots > 0 ||
        remainingRemove) {
        throw chatGptFailure("ATTACHMENT_UPLOAD_FAILED", "attachment.upload", "ChatGPT retained a pre-existing composer attachment that could not be cleared safely.", "Remove the existing composer attachment in the visible ChatGPT tab, then retry.", true);
    }
}
function countNames(names) {
    const counts = new Map();
    for (const name of names) {
        counts.set(name, (counts.get(name) || 0) + 1);
    }
    return counts;
}
function attachmentIdentityPatternSource(name) {
    const normalized = name.normalize("NFC");
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundary = `[\\s\\[\\](){}"'“”‘’:;,|]`;
    return `(?:^|${boundary})${escaped}(?=$|${boundary})`;
}
async function fillAndVerifyChatGptDraft(page, prompt, verificationDeadline, pollMs) {
    const found = await firstEditableStrategy(page, CHATGPT_PROMPT_STRATEGIES);
    if (!found) {
        throw chatGptFailure("PROMPT_INPUT_NOT_FOUND", "prompt.find", "Could not find a visible ChatGPT message box.", "Wait for ChatGPT to finish loading, then retry.", true);
    }
    try {
        // Playwright fill already performs the required actionability checks and
        // focuses editable controls. A separate click is harmful on ChatGPT's
        // short-lived fallback textarea: the click can wait for hydration/navigation
        // after it has already landed and consume the entire verification budget.
        await found.locator.fill(prompt, {
            timeout: Math.max(1, verificationDeadline - Date.now())
        });
    }
    catch {
        await found.locator.click({
            timeout: Math.max(1, verificationDeadline - Date.now())
        });
        await found.locator.press("ControlOrMeta+A", {
            timeout: Math.max(1, verificationDeadline - Date.now())
        });
        await page.keyboard.insertText(prompt);
    }
    do {
        const current = await firstEditableStrategy(page, CHATGPT_PROMPT_STRATEGIES);
        if (current) {
            const readback = await readDraft(current.locator, verificationDeadline);
            if (readback !== undefined && normalizeDraft(readback) === normalizeDraft(prompt)) {
                return {
                    strategy: current.strategy.name,
                    text: readback,
                    evidence: {
                        name: "chatgpt.draft-readback",
                        claim: "prompt-input",
                        strength: "strong",
                        detail: current.strategy.name
                    }
                };
            }
        }
        if (Date.now() >= verificationDeadline) {
            break;
        }
        await waitOnPage(page, Math.min(pollMs, verificationDeadline - Date.now()));
    } while (true);
    throw chatGptFailure("PROMPT_FILL_UNCONFIRMED", "prompt.verify", "ChatGPT draft readback did not match the requested prompt.", "Wait for the ChatGPT composer to finish loading, then retry.", true);
}
async function readDraft(locator, deadlineAt = Date.now() + 250) {
    const timeoutMs = Math.max(1, Math.min(250, deadlineAt - Date.now()));
    try {
        return await locator.inputValue({ timeout: timeoutMs });
    }
    catch {
        try {
            return await locator.evaluate((element) => {
                if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                    return element.value;
                }
                return element.innerText || element.textContent || "";
            }, undefined, { timeout: Math.max(1, Math.min(250, deadlineAt - Date.now())) });
        }
        catch {
            return undefined;
        }
    }
}
function normalizeDraft(value) {
    return value
        .normalize("NFC")
        .replace(/\r\n/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/\u200b/g, "")
        .replace(/\n+$/, "");
}
async function preselectChatGptDispatch(page, deadlineAt, pollMs) {
    do {
        const send = await firstVisibleStrategy(page, CHATGPT_SEND_STRATEGIES);
        if (send) {
            try {
                if (await send.locator.isEnabled()) {
                    const remainingMs = Math.max(1, deadlineAt - Date.now());
                    await send.locator.click({
                        trial: true,
                        timeout: remainingMs
                    });
                    return {
                        name: send.strategy.name,
                        kind: "click",
                        evidence: strategyEvidence(send.strategy, "dispatch"),
                        dispatch: () => {
                            const dispatchTimeoutMs = deadlineAt - Date.now();
                            if (dispatchTimeoutMs <= 0) {
                                throw new DeadlineExceededError();
                            }
                            return send.locator.click({ timeout: dispatchTimeoutMs });
                        }
                    };
                }
            }
            catch (error) {
                throw chatGptFailure("PROMPT_SUBMIT_FAILED", "prompt.submit", "ChatGPT send control was not actionable before dispatch.", "Wait for the composer to settle, then retry.", true, error);
            }
            if (Date.now() < deadlineAt) {
                await waitOnPage(page, Math.min(pollMs, deadlineAt - Date.now()));
                continue;
            }
            throw chatGptFailure("PROMPT_SUBMIT_FAILED", "prompt.submit", "ChatGPT send control remained disabled before dispatch.", "Wait for attachments to finish processing, then retry.", true);
        }
        const prompt = await firstEditableStrategy(page, CHATGPT_PROMPT_STRATEGIES);
        if (prompt) {
            return {
                name: "chatgpt.composer-enter",
                kind: "enter",
                evidence: {
                    name: "chatgpt.composer-enter",
                    claim: "dispatch",
                    strength: "weak",
                    detail: prompt.strategy.name
                },
                dispatch: () => {
                    const dispatchTimeoutMs = deadlineAt - Date.now();
                    if (dispatchTimeoutMs <= 0) {
                        throw new DeadlineExceededError();
                    }
                    return prompt.locator.press("Enter", { timeout: dispatchTimeoutMs });
                }
            };
        }
        throw chatGptFailure("PROMPT_INPUT_NOT_FOUND", "prompt.find", "ChatGPT composer disappeared before a dispatch strategy could be selected.", "Wait for ChatGPT to finish loading, then retry.", true);
    } while (true);
}
async function captureChatGptBaseline(page) {
    const [turns, busy] = await Promise.all([
        captureChatGptTurns(page),
        firstVisibleStrategy(page, CHATGPT_STOP_STRATEGIES).then(Boolean)
    ]);
    return {
        url: safePageUrl(page),
        user: turns.user,
        assistant: turns.assistant,
        busy
    };
}
async function captureChatGptTurns(page) {
    return page.evaluate(() => {
        const normalize = (value) => (value || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
        const topLevel = (role) => {
            const all = Array.from(document.querySelectorAll(`[data-message-author-role="${role}"]`));
            return all.filter((node) => !all.some((other) => other !== node && other.contains(node)));
        };
        const summarize = (nodes) => {
            const latest = nodes.at(-1);
            const turn = latest?.closest("section[data-turn-id], [data-testid^=conversation-turn-]");
            const latestId = latest?.getAttribute("data-message-id") ||
                turn?.getAttribute("data-turn-id") ||
                turn?.getAttribute("data-testid") ||
                undefined;
            return {
                count: nodes.length,
                ...(latestId ? { latestId } : {}),
                ...(latest ? { latestText: normalize(latest.innerText || latest.textContent) } : {})
            };
        };
        return { user: summarize(topLevel("user")), assistant: summarize(topLevel("assistant")) };
    });
}
async function captureChatGptPartialResponse(page, baseline, extractLatestAssistantText) {
    const turns = await captureChatGptTurns(page);
    const assistantAdvanced = turns.assistant.count > baseline.assistant.count || Boolean(turns.assistant.latestId &&
        baseline.assistant.latestId &&
        turns.assistant.latestId !== baseline.assistant.latestId);
    if (assistantAdvanced && turns.assistant.latestText) {
        return turns.assistant.latestText;
    }
    if (!extractLatestAssistantText) {
        return "";
    }
    const extracted = await extractLatestAssistantText(page);
    return normalizeDraft(extracted) !== normalizeDraft(baseline.assistant.latestText || "")
        ? extracted
        : "";
}
async function observeChatGptSubmission(page, baseline, prompt, matchesConversationUrl) {
    const evidence = [];
    const turns = await captureChatGptTurns(page);
    const userTurnAdvanced = turns.user.count > baseline.user.count || Boolean(turns.user.latestId &&
        baseline.user.latestId &&
        turns.user.latestId !== baseline.user.latestId);
    if (userTurnAdvanced &&
        normalizeDraft(turns.user.latestText || "") === normalizeDraft(prompt)) {
        evidence.push({
            name: turns.user.count > baseline.user.count
                ? "chatgpt.user-turn-count-advanced"
                : "chatgpt.user-turn-identity-changed",
            claim: "submission",
            strength: "strong",
            independenceKey: "user-turn"
        });
    }
    if (turns.assistant.count > baseline.assistant.count ||
        (turns.assistant.latestId &&
            baseline.assistant.latestId &&
            turns.assistant.latestId !== baseline.assistant.latestId)) {
        evidence.push({
            name: "chatgpt.assistant-turn-started",
            claim: "submission",
            strength: "strong",
            independenceKey: "assistant-turn"
        });
    }
    const currentUrl = safePageUrl(page);
    if (currentUrl !== baseline.url && matchesConversationUrl(currentUrl)) {
        evidence.push({
            name: "chatgpt.conversation-url-changed",
            claim: "submission",
            strength: "weak",
            independenceKey: "navigation"
        });
    }
    const currentPrompt = await firstEditableStrategy(page, CHATGPT_PROMPT_STRATEGIES);
    if (currentPrompt) {
        const draft = await readDraft(currentPrompt.locator);
        if (draft !== undefined && normalizeDraft(prompt) !== "" && normalizeDraft(draft) === "") {
            evidence.push({
                name: "chatgpt.draft-cleared",
                claim: "submission",
                strength: "weak",
                independenceKey: "draft"
            });
        }
    }
    if (!baseline.busy && await firstVisibleStrategy(page, CHATGPT_STOP_STRATEGIES)) {
        evidence.push({
            name: "chatgpt.generation-control-visible",
            claim: "submission",
            strength: "weak",
            independenceKey: "generation"
        });
    }
    return { evidence };
}
/*
 * Gemini deliberately has a narrower first-generation adapter than ChatGPT.
 * The selectors below are limited to the structural surfaces covered by our
 * routed fixtures. In particular, we do not infer a user-turn, upload-complete
 * state, or generation/busy state from broad text selectors. If Gemini changes
 * these surfaces, readiness fails before the dispatch permit is consumed.
 */
const GEMINI_PROMPT_STRATEGIES = [
    cssAllStrategy("gemini.rich-textarea-role-textbox", 'main rich-textarea [contenteditable="true"][role="textbox"]', "strong"),
    cssAllStrategy("gemini.rich-textarea-contenteditable", 'main rich-textarea [contenteditable="true"]', "strong"),
    cssAllStrategy("gemini.composer-testid-role-textbox", 'main [data-testid="composer"] [contenteditable="true"][role="textbox"]', "strong")
];
const GEMINI_ACCOUNT_STRATEGIES = [
    cssAllStrategy("gemini.account-signout-options", 'a[href*="SignOutOptions"]', "strong"),
    cssStrategy("gemini.account-menu-testid", '[data-testid="account-menu"]', "strong"),
    cssStrategy("gemini.profile-button-testid", 'button[data-testid="profile-button"]', "strong")
];
const GEMINI_SIGN_IN_STRATEGIES = [
    cssStrategy("gemini.sign-in-service-login", 'a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/o/oauth2"]', "strong"),
    cssStrategy("gemini.sign-in-testid", '[data-testid="sign-in-button"]', "strong"),
    // These labels are intentionally only weak evidence: they are localized
    // presentation text, not an identity or authenticated-session contract.
    cssStrategy("gemini.sign-in-aria-label-en", 'a[aria-label*="Sign in" i], button[aria-label*="Sign in" i]', "weak"),
    cssStrategy("gemini.sign-in-aria-label-zh-tw", 'a[aria-label*="登入"], button[aria-label*="登入"]', "weak")
];
const GEMINI_BLOCKED_STRATEGIES = [
    cssStrategy("gemini.challenge-testid", '[data-testid*="challenge"]', "strong"),
    cssStrategy("gemini.recaptcha-frame", 'iframe[src*="recaptcha"]', "strong"),
    cssStrategy("gemini.turnstile-frame", 'iframe[src*="challenges.cloudflare.com"]', "strong")
];
const GEMINI_SEND_STRATEGIES = [
    cssAllStrategy("gemini.composer-send-testid", 'main [data-testid="composer"] button[data-testid="send-button"]', "strong"),
    cssAllStrategy("gemini.composer-submit-testid", 'main form[data-testid="composer"] button[data-testid="send-button"]', "strong"),
    cssAllStrategy("gemini.input-area-send-aria-en", 'main .text-input-field button[aria-label="Send message"]', "weak"),
    cssAllStrategy("gemini.input-area-send-aria-zh-tw", 'main .text-input-field button[aria-label="傳送訊息"]', "weak")
];
const GEMINI_RESPONSE_CAPABILITY_STRATEGIES = [
    cssStrategy("gemini.response-conversation-id", 'main .conversation-container[id] response-container', "strong"),
    cssStrategy("gemini.response-container-indexed", 'main response-container[data-response-index]', "strong"),
    // An empty new conversation has no response-container yet. `main` only
    // establishes that the scoped app surface exists; turn identity is captured
    // later from either a response index or its stable conversation-container id.
    cssStrategy("gemini.app-main", "main", "weak")
];
/**
 * Builds Gemini's fail-closed exactly-once adapter.
 *
 * No Enter strategy is exposed. Gemini dispatch is permitted only after a
 * single, structural, uniquely actionable button has been selected.
 */
function createGeminiExecutionAdapter(options) {
    const pollMs = Math.max(0, options.pollMs ?? 100);
    const draftVerificationMs = Math.max(0, options.draftVerificationMs ?? 1_500);
    // A fresh Gemini tab can render the composer a few seconds before its
    // strong SignOutOptions account marker. Wait through that normal hydration
    // gap instead of treating a partially rendered signed-in page as auth.
    const readinessDiscoveryMs = Math.max(0, options.readinessDiscoveryMs ?? 5_000);
    return {
        provider: "gemini",
        displayName: "Gemini",
        matchesConversationUrl: options.matchesConversationUrl || matchesGeminiConversationUrl,
        discoverCapabilities: (page) => discoverGeminiCapabilities(page, Date.now() + readinessDiscoveryMs, pollMs),
        attachAndVerify: (page, filePaths, _deadlineAt) => attachAndVerifyGeminiFiles(page, filePaths),
        fillAndVerifyDraft: (page, prompt, deadlineAt) => fillAndVerifyGeminiDraft(page, prompt, Math.min(deadlineAt, Date.now() + draftVerificationMs), pollMs),
        captureBaseline: (page) => captureGeminiBaseline(page),
        preselectDispatch: (page, deadlineAt) => preselectGeminiDispatch(page, deadlineAt),
        observeSubmission: (page, baseline, prompt) => observeGeminiSubmission(page, baseline, prompt, options.matchesConversationUrl || matchesGeminiConversationUrl),
        capturePartialResponse: (page, baseline) => captureGeminiPartialResponse(page, baseline, options.automation.extractLatestAssistantText),
        // The legacy Gemini waiter preserves established partial-timeout behavior.
        // Its baseline is captured by this adapter before dispatch, not after it.
        waitForResponse: (page, responseOptions) => options.automation.waitForAssistantCompletion(page, {
            timeoutMs: responseOptions.timeoutMs,
            baseline: assistantBaseline(responseOptions.baseline)
        }),
        recoverBeforeSubmit: async (page, _cause, deadlineAt) => {
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) {
                return;
            }
            await page.reload({
                waitUntil: "domcontentloaded",
                timeout: remainingMs
            });
        }
    };
}
async function discoverGeminiCapabilities(page, discoveryDeadline, pollMs) {
    let snapshot = await discoverGeminiCapabilitiesOnce(page);
    while (!geminiCapabilityDiscoveryIsConclusive(snapshot) && Date.now() < discoveryDeadline) {
        await waitOnPage(page, Math.min(pollMs, discoveryDeadline - Date.now()));
        snapshot = await discoverGeminiCapabilitiesOnce(page);
    }
    return snapshot;
}
function geminiCapabilityDiscoveryIsConclusive(snapshot) {
    if (snapshot.auth.state === "blocked" || snapshot.auth.confidence === "conflicting") {
        return true;
    }
    if (snapshot.auth.state === "login-required" || snapshot.auth.state === "guest") {
        return snapshot.auth.confidence === "strong";
    }
    return snapshot.auth.state === "signed-in-likely" &&
        snapshot.auth.confidence === "strong" &&
        snapshot.prompt.available;
}
async function discoverGeminiCapabilitiesOnce(page) {
    const prompt = await firstUniqueEditableStrategy(page, GEMINI_PROMPT_STRATEGIES);
    const accountEvidence = await collectStrategyEvidence(page, GEMINI_ACCOUNT_STRATEGIES, "auth-ready", "visible-or-attached");
    const signInEvidence = await collectStrategyEvidence(page, GEMINI_SIGN_IN_STRATEGIES, "auth-required", "visible");
    const blockedEvidence = await collectStrategyEvidence(page, GEMINI_BLOCKED_STRATEGIES, "provider-blocked", "visible-or-attached");
    const send = await firstUniqueActionableClickStrategy(page, GEMINI_SEND_STRATEGIES, 250);
    const responseObserver = await firstVisibleStrategy(page, GEMINI_RESPONSE_CAPABILITY_STRATEGIES);
    const promptEvidence = prompt ? [strategyEvidence(prompt.strategy, "prompt-input")] : [];
    // Gemini creates its send button only after the draft becomes non-empty.
    // A verified composer therefore advertises a deferred click capability for
    // status/setup; preselectGeminiDispatch still requires exactly one concrete,
    // actionable button after fill and fails before consuming the permit.
    const clickEvidence = send
        ? [strategyEvidence(send.strategy, "dispatch")]
        : prompt ? [{
                name: "gemini.send-after-draft",
                claim: "dispatch",
                strength: "weak",
                detail: prompt.strategy.name
            }] : [];
    const responseEvidence = responseObserver
        ? [strategyEvidence(responseObserver.strategy, "response-observation")]
        : [];
    const auth = aggregateAuth(accountEvidence, signInEvidence, blockedEvidence, Boolean(prompt));
    const evidence = [
        ...auth.evidence,
        ...promptEvidence,
        ...clickEvidence,
        ...responseEvidence
    ];
    return {
        url: safePageUrl(page),
        auth,
        prompt: capability(prompt?.strategy.name, promptEvidence),
        // The repository has no Gemini fixture that proves a named composer
        // attachment has completed upload. Reporting availability here would make
        // it too easy for callers to mistake file-input selection for completion.
        attachment: capability(undefined, []),
        clickDispatch: capability(send?.strategy.name || (prompt ? "gemini.send-after-draft" : undefined), clickEvidence),
        enterDispatch: capability(undefined, []),
        response: capability(responseObserver?.strategy.name, responseEvidence),
        evidence
    };
}
async function attachAndVerifyGeminiFiles(_page, filePaths) {
    const resolvedPaths = filePaths.map((filePath) => node_path_1.default.resolve(filePath));
    validateGeminiAttachmentPaths(resolvedPaths);
    if (resolvedPaths.length === 0) {
        return { files: [] };
    }
    throw geminiFailure("ATTACHMENT_UPLOAD_FAILED", "attachment.upload", "Gemini attachment completion cannot be verified from the current supported composer surface.", "Gemini attachments are not supported by exactly-once sending yet; remove --attach or use Gemini manually.", false);
}
function validateGeminiAttachmentPaths(filePaths) {
    for (const filePath of filePaths) {
        if (!node_fs_1.default.existsSync(filePath)) {
            throw geminiFailure("ATTACHMENT_INVALID", "attachment.upload", `Attachment file does not exist: ${filePath}`, "Check the attachment path, then try again.", false);
        }
        if (!node_fs_1.default.statSync(filePath).isFile()) {
            throw geminiFailure("ATTACHMENT_INVALID", "attachment.upload", `Attachment path is not a regular file: ${filePath}`, "Choose a regular file instead of a directory, then try again.", false);
        }
    }
}
async function fillAndVerifyGeminiDraft(page, prompt, verificationDeadline, pollMs) {
    const found = await firstUniqueEditableStrategy(page, GEMINI_PROMPT_STRATEGIES);
    if (!found) {
        throw geminiFailure("PROMPT_INPUT_NOT_FOUND", "prompt.find", "Could not find a visible, editable Gemini message box in the supported composer surface.", "Wait for Gemini to finish loading, then retry.", true);
    }
    await found.locator.click({ timeout: Math.max(1, verificationDeadline - Date.now()) });
    try {
        await found.locator.fill(prompt, { timeout: Math.max(1, verificationDeadline - Date.now()) });
    }
    catch {
        await found.locator.press("ControlOrMeta+A", {
            timeout: Math.max(1, verificationDeadline - Date.now())
        });
        await page.keyboard.insertText(prompt);
    }
    do {
        const current = await firstUniqueEditableStrategy(page, GEMINI_PROMPT_STRATEGIES);
        if (current) {
            const readback = await readDraft(current.locator, verificationDeadline);
            if (readback !== undefined && normalizeDraft(readback) === normalizeDraft(prompt)) {
                return {
                    strategy: current.strategy.name,
                    text: readback,
                    evidence: {
                        name: "gemini.draft-readback",
                        claim: "prompt-input",
                        strength: "strong",
                        detail: current.strategy.name
                    }
                };
            }
        }
        if (Date.now() >= verificationDeadline) {
            break;
        }
        await waitOnPage(page, Math.min(pollMs, verificationDeadline - Date.now()));
    } while (true);
    throw geminiFailure("PROMPT_FILL_UNCONFIRMED", "prompt.verify", "Gemini draft readback did not match the requested prompt.", "Wait for the Gemini composer to finish loading, then retry.", true);
}
async function preselectGeminiDispatch(page, deadlineAt) {
    const send = await firstUniqueActionableClickStrategy(page, GEMINI_SEND_STRATEGIES, Math.max(1, deadlineAt - Date.now()));
    if (!send) {
        throw geminiFailure("PROMPT_SUBMIT_FAILED", "prompt.submit", "Could not identify exactly one enabled Gemini send control before dispatch.", "Wait for the Gemini composer to settle, then retry. Ask will not use Enter as a fallback.", true);
    }
    return {
        name: send.strategy.name,
        kind: "click",
        evidence: strategyEvidence(send.strategy, "dispatch"),
        dispatch: () => {
            const dispatchTimeoutMs = deadlineAt - Date.now();
            if (dispatchTimeoutMs <= 0) {
                throw new DeadlineExceededError();
            }
            return send.locator.click({ timeout: dispatchTimeoutMs });
        }
    };
}
async function captureGeminiBaseline(page) {
    const assistant = await captureGeminiAssistantTurns(page);
    return {
        url: safePageUrl(page),
        // There is no repository-proven stable Gemini user-turn identity/count.
        // Keeping this empty prevents prompt text (including repeated prompts) from
        // ever becoming a submission confirmation signal.
        user: { count: 0 },
        assistant,
        // Do not infer a busy state from unverified Gemini controls or text.
        busy: false
    };
}
async function captureGeminiAssistantTurns(page) {
    return page.evaluate((_capture) => {
        const normalize = (value) => (value || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
        const all = Array.from(document.querySelectorAll('main .conversation-container[id] response-container, main response-container[data-response-index]'));
        const turns = all.filter((node) => !all.some((other) => other !== node && other.contains(node)));
        const latest = turns.at(-1);
        const latestId = latest?.getAttribute("data-response-index") ||
            latest?.getAttribute("data-message-id") ||
            latest?.closest(".conversation-container[id]")?.id ||
            latest?.querySelector("message-content[id]")?.id ||
            undefined;
        const content = latest?.querySelector("message-content") || latest;
        return {
            count: turns.length,
            ...(latestId ? { latestId } : {}),
            ...(latest ? { latestText: normalize(content?.innerText || content?.textContent) } : {})
        };
    }, "gemini-assistant-turns");
}
async function captureGeminiPartialResponse(page, baseline, extractLatestAssistantText) {
    const assistant = await captureGeminiAssistantTurns(page);
    const assistantAdvanced = assistant.count > baseline.assistant.count || Boolean(assistant.latestId &&
        baseline.assistant.latestId &&
        assistant.latestId !== baseline.assistant.latestId);
    if (assistantAdvanced && assistant.latestText) {
        return assistant.latestText;
    }
    if (!extractLatestAssistantText) {
        return "";
    }
    const extracted = await extractLatestAssistantText(page);
    return normalizeDraft(extracted) !== normalizeDraft(baseline.assistant.latestText || "")
        ? extracted
        : "";
}
async function observeGeminiSubmission(page, baseline, prompt, matchesConversationUrl) {
    const evidence = [];
    const assistant = await captureGeminiAssistantTurns(page);
    if (assistant.count > baseline.assistant.count ||
        (assistant.latestId &&
            baseline.assistant.latestId &&
            assistant.latestId !== baseline.assistant.latestId)) {
        evidence.push({
            name: assistant.count > baseline.assistant.count
                ? "gemini.assistant-turn-count-advanced"
                : "gemini.assistant-turn-identity-changed",
            claim: "submission",
            strength: "strong",
            independenceKey: "assistant-turn"
        });
    }
    const currentUrl = safePageUrl(page);
    if (currentUrl !== baseline.url && matchesConversationUrl(currentUrl)) {
        evidence.push({
            name: "gemini.conversation-url-changed",
            claim: "submission",
            strength: "weak",
            independenceKey: "navigation"
        });
    }
    const currentPrompt = await firstUniqueEditableStrategy(page, GEMINI_PROMPT_STRATEGIES);
    if (currentPrompt) {
        const draft = await readDraft(currentPrompt.locator);
        if (draft !== undefined && normalizeDraft(prompt) !== "" && normalizeDraft(draft) === "") {
            evidence.push({
                name: "gemini.draft-cleared",
                claim: "submission",
                strength: "weak",
                independenceKey: "draft"
            });
        }
    }
    return { evidence };
}
function matchesGeminiConversationUrl(value) {
    if (!value) {
        return false;
    }
    try {
        const url = new URL(value);
        return url.hostname === "gemini.google.com" && /^\/app\/[^/]+/.test(url.pathname);
    }
    catch {
        return false;
    }
}
function assistantBaseline(baseline) {
    return {
        key: baseline.assistant.latestId,
        text: baseline.assistant.latestText || "",
        count: baseline.assistant.count
    };
}
function cssStrategy(name, selector, strength) {
    return { name, strength, locate: (page) => page.locator(selector).last() };
}
/** Keeps the complete match set so a caller can reject ambiguity explicitly. */
function cssAllStrategy(name, selector, strength) {
    return { name, strength, locate: (page) => page.locator(selector) };
}
async function firstVisibleStrategy(page, strategies) {
    for (const strategy of strategies) {
        const locator = strategy.locate(page);
        try {
            if ((await locator.count()) > 0 && await locator.isVisible()) {
                return { strategy, locator };
            }
        }
        catch {
            // Continue across transient SPA replacements.
        }
    }
    return undefined;
}
async function firstEditableStrategy(page, strategies) {
    for (const strategy of strategies) {
        const locator = strategy.locate(page);
        try {
            if ((await locator.count()) > 0 &&
                await locator.isVisible() &&
                await locator.isEnabled() &&
                await locator.isEditable()) {
                return { strategy, locator };
            }
        }
        catch {
            // Continue across read-only fallbacks and transient SPA replacements.
        }
    }
    return undefined;
}
/** Gemini must not choose between multiple editable composer candidates. */
async function firstUniqueEditableStrategy(page, strategies) {
    for (const strategy of strategies) {
        const locator = strategy.locate(page);
        try {
            if ((await locator.count()) !== 1 ||
                !(await locator.isVisible()) ||
                !(await locator.isEnabled()) ||
                !(await locator.isEditable())) {
                continue;
            }
            return { strategy, locator };
        }
        catch {
            // A Gemini SPA replacement can temporarily detach a composer candidate.
        }
    }
    return undefined;
}
/**
 * Gemini's submit control is deliberately stricter than the older providers:
 * picking `.last()` from several matching buttons can send to the wrong
 * composer. A Gemini strategy is eligible only when its own selector resolves
 * to exactly one visible, enabled, trial-actionable control.
 */
async function firstUniqueActionableClickStrategy(page, strategies, timeoutMs) {
    for (const strategy of strategies) {
        const locator = strategy.locate(page);
        try {
            if ((await locator.count()) !== 1 ||
                !(await locator.isVisible()) ||
                !(await locator.isEnabled())) {
                continue;
            }
            await locator.click({ trial: true, timeout: Math.max(1, timeoutMs) });
            return { strategy, locator };
        }
        catch {
            // A unique candidate still needs to satisfy Playwright actionability.
        }
    }
    return undefined;
}
async function firstActionableClickStrategy(page, strategies, timeoutMs) {
    for (const strategy of strategies) {
        const locator = strategy.locate(page);
        try {
            if ((await locator.count()) === 0 || !(await locator.isVisible()) || !(await locator.isEnabled())) {
                continue;
            }
            await locator.click({ trial: true, timeout: Math.max(1, timeoutMs) });
            return { strategy, locator };
        }
        catch {
            // Capability discovery reports only controls that pass Playwright actionability.
        }
    }
    return undefined;
}
async function firstAttachedStrategy(page, strategies) {
    for (const strategy of strategies) {
        const locator = strategy.locate(page);
        try {
            if ((await locator.count()) > 0) {
                return { strategy, locator };
            }
        }
        catch {
            // Continue across transient SPA replacements.
        }
    }
    return undefined;
}
async function collectStrategyEvidence(page, strategies, claim, mode) {
    const evidence = [];
    for (const strategy of strategies) {
        const locator = strategy.locate(page);
        try {
            const count = await locator.count();
            if (count === 0) {
                continue;
            }
            let visible = false;
            for (let index = 0; index < count; index += 1) {
                if (await locator.nth(index).isVisible().catch(() => false)) {
                    visible = true;
                    break;
                }
            }
            if (mode === "visible" && !visible) {
                continue;
            }
            evidence.push({
                name: strategy.name,
                claim,
                strength: visible ? strategy.strength : "weak",
                ...(!visible ? { detail: "attached but not visible" } : {})
            });
        }
        catch {
            // Continue across transient SPA replacements.
        }
    }
    return evidence;
}
function strategyEvidence(strategy, claim) {
    return { name: strategy.name, claim, strength: strategy.strength };
}
function chatGptFailure(code, stage, message, hint, retryable, cause) {
    return new errors_1.AskFailure({
        code,
        stage,
        provider: "chatgpt",
        providerDisplayName: "ChatGPT",
        message,
        hint,
        retryable,
        cause,
        context: { deliveryState: "not-attempted" }
    });
}
function geminiFailure(code, stage, message, hint, retryable, cause) {
    return new errors_1.AskFailure({
        code,
        stage,
        provider: "gemini",
        providerDisplayName: "Gemini",
        message,
        hint,
        retryable,
        cause,
        context: { deliveryState: "not-attempted" }
    });
}
