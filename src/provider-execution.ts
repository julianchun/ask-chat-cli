import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import {
  AskFailure,
  type AskExecutionStage,
  type AskFailureCode,
  type PromptDeliveryState
} from "./errors";
import type { ProviderName } from "./providers";
import type {
  AssistantResponseBaseline,
  AuthState,
  ProviderAutomation,
  ResponseResult
} from "./webchat";

export type ProviderEvidenceStrength = "strong" | "weak";

export type ProviderEvidenceClaim =
  | "auth-ready"
  | "auth-required"
  | "provider-blocked"
  | "prompt-input"
  | "attachment-input"
  | "dispatch"
  | "response-observation"
  | "submission"
  | "dispatch-error";

/** A positive, named observation. Negative observations are represented by absence. */
export interface ProviderExecutionEvidence {
  name: string;
  claim: ProviderEvidenceClaim;
  strength: ProviderEvidenceStrength;
  /** Weak submission signals only combine when their independence keys differ. */
  independenceKey?: string;
  detail?: string;
}

export type ProviderAuthConfidence = "strong" | "weak" | "conflicting" | "none";

export interface ProviderAuthCapability {
  state: AuthState;
  confidence: ProviderAuthConfidence;
  evidence: readonly ProviderExecutionEvidence[];
}

export interface ProviderCapability {
  available: boolean;
  strategy?: string;
  evidence: readonly ProviderExecutionEvidence[];
}

export interface ProviderCapabilitySnapshot {
  url: string;
  auth: ProviderAuthCapability;
  prompt: ProviderCapability;
  attachment: ProviderCapability;
  clickDispatch: ProviderCapability;
  enterDispatch: ProviderCapability;
  response: ProviderCapability;
  evidence: readonly ProviderExecutionEvidence[];
}

export interface ProviderTurnBaseline {
  count: number;
  latestId?: string;
  latestText?: string;
}

/** Captured immediately before dispatch so SPA navigation and new turns are distinguishable. */
export interface ProviderConversationBaseline {
  url: string;
  user: ProviderTurnBaseline;
  assistant: ProviderTurnBaseline;
  busy: boolean;
}

export interface AttachmentVerification {
  files: readonly {
    path: string;
    name: string;
    evidence: ProviderExecutionEvidence;
  }[];
}

export interface DraftVerification {
  strategy: string;
  text: string;
  evidence: ProviderExecutionEvidence;
}

export type PromptDispatchKind = "click" | "enter";

/** A single strategy selected before the irreversible dispatch boundary. */
export interface PromptDispatchSelection {
  name: string;
  kind: PromptDispatchKind;
  evidence: ProviderExecutionEvidence;
  dispatch(): Promise<void>;
}

export interface SubmissionObservation {
  evidence: readonly ProviderExecutionEvidence[];
}

export interface ProviderResponseWaitOptions {
  timeoutMs: number;
  baseline: ProviderConversationBaseline;
}

export interface ProviderExecutionAdapter {
  provider: ProviderName;
  displayName: string;
  /**
   * Conversation URLs are provider-owned. The coordinator only asks the
   * adapter whether a URL is safe to persist; it must not infer one provider's
   * URL shape for another provider.
   */
  matchesConversationUrl(value: string | undefined): boolean;
  discoverCapabilities(page: Page): Promise<ProviderCapabilitySnapshot>;
  attachAndVerify(
    page: Page,
    filePaths: readonly string[],
    deadlineAt: number
  ): Promise<AttachmentVerification>;
  fillAndVerifyDraft(
    page: Page,
    prompt: string,
    deadlineAt: number
  ): Promise<DraftVerification>;
  captureBaseline(page: Page): Promise<ProviderConversationBaseline>;
  preselectDispatch(
    page: Page,
    deadlineAt: number
  ): Promise<PromptDispatchSelection>;
  observeSubmission(
    page: Page,
    baseline: ProviderConversationBaseline,
    prompt: string
  ): Promise<SubmissionObservation>;
  /** A read-only snapshot used to preserve partial stdout if the response waiter hangs. */
  capturePartialResponse?(
    page: Page,
    baseline: ProviderConversationBaseline
  ): Promise<string>;
  waitForResponse(page: Page, options: ProviderResponseWaitOptions): Promise<ResponseResult>;
  recoverBeforeSubmit?(page: Page, cause: unknown, deadlineAt: number): Promise<void>;
}

export interface ProviderExecutionDeadlineEvent {
  phase: AskExecutionStage;
  deadlineAt: number;
  elapsedMs: number;
}

export type WaitForProviderReady = () => Promise<ProviderCapabilitySnapshot>;

export interface ProviderAuthHandoffContext {
  deadlineAt: number;
  remainingMs: number;
}

export interface ProviderPreSubmitRecoveryEvent {
  attempt: 1;
  cause: unknown;
  deadlineAt: number;
  remainingMs: number;
}

export interface ProviderSubmissionUncertainEvent {
  dispatchStrategy: string;
  deadlineAt: number;
  remainingMs: number;
  evidence: readonly ProviderExecutionEvidence[];
  dispatchError?: string;
}

/**
 * Runs after every pre-submit check has succeeded but immediately before the
 * single dispatch permit is consumed. It is the sole safe boundary for durable
 * uncertainty protection: a crash after this hook is conservative, whereas a
 * crash after click must never lose the marker.
 */
export interface ProviderBeforeDispatchEvent {
  dispatchStrategy: string;
  deadlineAt: number;
  remainingMs: number;
}

/** Delivery evidence is sufficient; follow-up callback errors stay observe-only. */
export interface ProviderDeliveryConfirmedEvent {
  dispatchStrategy: string;
  deadlineAt: number;
  remainingMs: number;
  conversationUrl: string;
  evidence: readonly ProviderExecutionEvidence[];
}

export interface ExecuteProviderPromptOptions {
  prompt: string;
  attachments: readonly string[];
  timeoutMs: number;
  authPollMs?: number;
  submissionPollMs?: number;
  submissionConfirmationMs?: number;
  onAuthHandoff?: (
    waitForReady: WaitForProviderReady,
    context: ProviderAuthHandoffContext
  ) => Promise<void>;
  onPreSubmitRecovery?: (event: ProviderPreSubmitRecoveryEvent) => void | Promise<void>;
  /** Durable safety hook. A rejection happens before any irreversible click. */
  onBeforeDispatch?: (event: ProviderBeforeDispatchEvent) => void | Promise<void>;
  onSubmissionUncertain?: (event: ProviderSubmissionUncertainEvent) => void | Promise<void>;
  /** Best-effort post-confirmation hook; it cannot trigger a replay. */
  onDeliveryConfirmed?: (event: ProviderDeliveryConfirmedEvent) => void | Promise<void>;
  /** Best-effort persistence hook at the irreversible confirmation boundary. */
  onSubmissionConfirmed?: (conversationUrl: string) => void | Promise<void>;
  onDeadline?: (event: ProviderExecutionDeadlineEvent) => void | Promise<void>;
}

interface ProviderExecutionResultBase {
  deliveryState: Extract<PromptDeliveryState, "confirmed" | "unknown">;
  conversationUrl: string;
  dispatchStrategy: string;
  evidence: readonly ProviderExecutionEvidence[];
}

export interface ConfirmedProviderExecutionResult extends ProviderExecutionResultBase {
  deliveryState: "confirmed";
  response: ResponseResult;
}

export interface UnknownProviderExecutionResult extends ProviderExecutionResultBase {
  deliveryState: "unknown";
  dispatchError?: string;
}

export type ProviderExecutionResult =
  | ConfirmedProviderExecutionResult
  | UnknownProviderExecutionResult;

/**
 * The permit is deliberately stateful and consumed before the selected action runs.
 * An action that throws may already have reached the page, so it can never be retried.
 */
export class PromptDispatchPermit {
  private consumedBy?: string;

  get consumed(): boolean {
    return this.consumedBy !== undefined;
  }

  get strategy(): string | undefined {
    return this.consumedBy;
  }

  consume(strategy: string): void {
    if (this.consumedBy !== undefined) {
      throw new Error(
        `Prompt dispatch permit was already consumed by "${this.consumedBy}" and cannot be reused by "${strategy}".`
      );
    }
    this.consumedBy = strategy;
  }
}

interface DeadlineController {
  readonly startedAt: number;
  readonly deadlineAt: number;
  remainingMs(): number;
  notify(phase: AskExecutionStage): Promise<void>;
}

interface PreparedPrompt {
  baseline: ProviderConversationBaseline;
  dispatch: PromptDispatchSelection;
}

const DEFAULT_AUTH_POLL_MS = 250;
const DEFAULT_SUBMISSION_POLL_MS = 100;
const DEFAULT_SUBMISSION_CONFIRMATION_MS = 4_000;

export async function executeProviderPrompt(
  page: Page,
  adapter: ProviderExecutionAdapter,
  options: ExecuteProviderPromptOptions
): Promise<ProviderExecutionResult> {
  const deadline = createDeadline(options.timeoutMs, options.onDeadline);
  const authPollMs = Math.max(0, options.authPollMs ?? DEFAULT_AUTH_POLL_MS);
  const submissionPollMs = Math.max(0, options.submissionPollMs ?? DEFAULT_SUBMISSION_POLL_MS);

  let capabilities = await discoverCapabilitiesOrFailure(
    page,
    adapter,
    "readiness.discover",
    deadline
  );
  capabilities = await ensureAuthenticatedCapabilities(
    page,
    adapter,
    options,
    deadline,
    authPollMs,
    capabilities,
    "readiness.discover",
    (nextCapabilities) => {
      capabilities = nextCapabilities;
    }
  );

  let prepared: PreparedPrompt;
  try {
    prepared = await prepareWithOneRecovery(
      page,
      adapter,
      options,
      deadline,
      capabilities,
      authPollMs,
      (nextCapabilities) => {
        capabilities = nextCapabilities;
      }
    );
  } catch (error) {
    const context = {
      authState: capabilities.auth.state,
      promptInputVisible: capabilities.prompt.available,
      deliveryState: "not-attempted" as const
    };
    if (error instanceof AskFailure) {
      throw mergeFailureContext(error, context);
    }
    throw failure(
      adapter,
      "BROWSER_UNAVAILABLE",
      "readiness.recover",
      `Could not prepare ${adapter.displayName} before dispatch.`,
      `Run \`ask status --provider ${adapter.provider} --verbose\`.`,
      true,
      context,
      error
    );
  }
  ensureTimeRemaining(adapter, deadline, "prompt.submit", "PROMPT_SUBMIT_FAILED");
  // Persist any delivery-ambiguity protection *before* the single permit is
  // consumed. This callback is intentionally awaited: if protection cannot be
  // armed, no click/Enter action is allowed to cross the irreversible boundary.
  await runPreDispatchBeforeDeadline(
    adapter,
    deadline,
    "prompt.submit",
    "PROMPT_SUBMIT_FAILED",
    () => Promise.resolve(options.onBeforeDispatch?.({
      dispatchStrategy: prepared.dispatch.name,
      deadlineAt: deadline.deadlineAt,
      remainingMs: deadline.remainingMs()
    })),
    { preserveUnexpectedError: true }
  );
  const permit = new PromptDispatchPermit();
  permit.consume(prepared.dispatch.name);

  let dispatchError: unknown;
  try {
    await withAbsoluteDeadline(
      () => prepared.dispatch.dispatch(),
      deadline.deadlineAt
    );
  } catch (error) {
    dispatchError = error;
  }

  // From this point on all code is observation-only. A thrown click/press can still
  // mean the browser received the event, so falling back would risk a duplicate turn.
  const evidenceByName = new Map<string, ProviderExecutionEvidence>();
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
    : Math.min(
        Math.max(0, options.submissionConfirmationMs ?? DEFAULT_SUBMISSION_CONFIRMATION_MS),
        deadline.remainingMs()
      );
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
      const observation = await withAbsoluteDeadline(
        () => adapter.observeSubmission(
          page,
          prepared.baseline,
          options.prompt
        ),
        deadline.deadlineAt
      );
      for (const item of observation.evidence) {
        evidenceByName.set(item.name, item);
      }
    } catch (error) {
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

  const persistedConversationUrls = new Map<string, Promise<void>>();
  const persistConfirmedConversationUrl = async (candidate: string): Promise<void> => {
    if (
      !options.onSubmissionConfirmed ||
      !adapter.matchesConversationUrl(candidate) ||
      deadline.remainingMs() <= 0
    ) {
      return;
    }
    const existingPersistence = persistedConversationUrls.get(candidate);
    if (existingPersistence) {
      await existingPersistence;
      return;
    }
    const persistence = (async () => {
      try {
        await withAbsoluteDeadline(
          () => Promise.resolve(options.onSubmissionConfirmed!(candidate)),
          deadline.deadlineAt
        );
      } catch {
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
          const partial = await withAbsoluteDeadline(
            () => adapter.capturePartialResponse!(page, prepared.baseline),
            deadline.deadlineAt
          );
          if (partial) {
            latestSafePartial = partial;
          }
        } catch (error) {
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
  let response: ResponseResult;
  try {
    response = await withAbsoluteDeadline(
      () => adapter.waitForResponse(page, {
        timeoutMs: responseTimeoutMs,
        baseline: prepared.baseline
      }),
      deadline.deadlineAt
    );
  } catch (error) {
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
    } else if (error instanceof AskFailure) {
      throw mergeFailureContext(error, {
        deliveryState: "confirmed",
        ...(knownConversationUrl ? { conversationUrl: knownConversationUrl } : {})
      }, false);
    } else {
      throw failure(
        adapter,
        "RESPONSE_NOT_DETECTED",
        "response.wait",
        `Prompt delivery was confirmed, but the ${adapter.displayName} response could not be observed.`,
        "Do not resend the prompt. Reopen or continue the provider conversation.",
        false,
        {
          deliveryState: "confirmed",
          ...(knownConversationUrl ? { conversationUrl: knownConversationUrl } : {})
        },
        error
      );
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

export function isSubmissionConfirmed(evidence: readonly ProviderExecutionEvidence[]): boolean {
  const submissionEvidence = evidence.filter((item) => item.claim === "submission");
  if (submissionEvidence.some((item) => item.strength === "strong")) {
    return true;
  }

  const independentWeakSignals = new Set(
    submissionEvidence
      .filter((item) => item.strength === "weak")
      .map((item) => item.independenceKey || item.name)
  );
  return independentWeakSignals.size >= 2;
}

async function ensureAuthenticatedCapabilities(
  page: Page,
  adapter: ProviderExecutionAdapter,
  options: ExecuteProviderPromptOptions,
  deadline: DeadlineController,
  authPollMs: number,
  initialCapabilities: ProviderCapabilitySnapshot,
  initialStage: Extract<AskExecutionStage, "readiness.discover" | "readiness.recover" | "auth.handoff">,
  onCapabilities?: (capabilities: ProviderCapabilitySnapshot) => void
): Promise<ProviderCapabilitySnapshot> {
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
  const waitForReady: WaitForProviderReady = async () => {
    while (deadline.remainingMs() > 0) {
      try {
        const current = await withAbsoluteDeadline(
          () => adapter.discoverCapabilities(page),
          deadline.deadlineAt
        );
        capabilities = current;
        onCapabilities?.(capabilities);
        if (hasStrongAuth(current)) {
          return current;
        }
      } catch (error) {
        if (error instanceof DeadlineExceededError) {
          break;
        }
        // Provider SPAs can replace the document while auth completes. Keep polling
        // until the shared deadline instead of turning a transient read into a rerun.
      }
      await waitOnPageUntil(page, authPollMs, deadline.deadlineAt);
    }

    await deadline.notify("auth.handoff");
    throw failure(
      adapter,
      "AUTH_HANDOFF_TIMEOUT",
      "auth.handoff",
      `${adapter.displayName} did not become signed in before the command deadline.`,
      `Finish signing in, then retry with \`ask --provider ${adapter.provider}\`.`,
      true,
      { authState: capabilities.auth.state, deliveryState: "not-attempted" }
    );
  };

  try {
    await withAbsoluteDeadline(
      () => options.onAuthHandoff!(waitForReady, {
        deadlineAt: deadline.deadlineAt,
        remainingMs: deadline.remainingMs()
      }),
      deadline.deadlineAt
    );
  } catch (error) {
    if (!(error instanceof DeadlineExceededError)) {
      throw error;
    }
    await deadline.notify("auth.handoff");
    throw failure(
      adapter,
      "AUTH_HANDOFF_TIMEOUT",
      "auth.handoff",
      `${adapter.displayName} did not become signed in before the command deadline.`,
      `Finish signing in, then retry with \`ask --provider ${adapter.provider}\`.`,
      true,
      { authState: capabilities.auth.state, deliveryState: "not-attempted" },
      error
    );
  }

  capabilities = await discoverCapabilitiesOrFailure(
    page,
    adapter,
    "auth.handoff",
    deadline
  );
  onCapabilities?.(capabilities);
  assertNotBlocked(adapter, capabilities, "auth.handoff");
  if (!hasStrongAuth(capabilities)) {
    throw authFailure(adapter, capabilities);
  }
  return capabilities;
}

async function prepareWithOneRecovery(
  page: Page,
  adapter: ProviderExecutionAdapter,
  options: ExecuteProviderPromptOptions,
  deadline: DeadlineController,
  initialCapabilities: ProviderCapabilitySnapshot,
  authPollMs: number,
  onCapabilities: (capabilities: ProviderCapabilitySnapshot) => void
): Promise<PreparedPrompt> {
  let capabilities = initialCapabilities;
  let recoveryAttempts = 0;
  while (true) {
    try {
      await runPreDispatchBeforeDeadline(
        adapter,
        deadline,
        "attachment.upload",
        "ATTACHMENT_UPLOAD_FAILED",
        () => adapter.attachAndVerify(page, options.attachments, deadline.deadlineAt)
      );
      await runPreDispatchBeforeDeadline(
        adapter,
        deadline,
        "prompt.verify",
        "PROMPT_FILL_UNCONFIRMED",
        () => adapter.fillAndVerifyDraft(page, options.prompt, deadline.deadlineAt)
      );
      const dispatch = await runPreDispatchBeforeDeadline(
        adapter,
        deadline,
        "prompt.submit",
        "PROMPT_SUBMIT_FAILED",
        () => adapter.preselectDispatch(page, deadline.deadlineAt)
      );
      const baseline = await runPreDispatchBeforeDeadline(
        adapter,
        deadline,
        "response.baseline",
        "PROMPT_SUBMIT_FAILED",
        () => adapter.captureBaseline(page)
      );
      return { baseline, dispatch };
    } catch (error) {
      if (
        recoveryAttempts >= 1 ||
        !isRecoverablePreSubmitFailure(error) ||
        deadline.remainingMs() <= 0
      ) {
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
      } catch {
        // A progress callback is not part of provider readiness.
      }
      if (adapter.recoverBeforeSubmit) {
        try {
          await runPreDispatchBeforeDeadline(
            adapter,
            deadline,
            "readiness.recover",
            "BROWSER_UNAVAILABLE",
            () => adapter.recoverBeforeSubmit!(page, error, deadline.deadlineAt)
          );
        } catch (recoveryError) {
          // A recovery reload can itself fail during an SPA transition. When
          // the original preparation failure was already structured, keep its
          // precise stage/code instead of hiding it behind a generic browser
          // failure.
          if (error instanceof AskFailure) {
            throw error;
          }
          throw recoveryError;
        }
      } else {
        await waitOnPageUntil(page, 100, deadline.deadlineAt);
      }

      capabilities = await discoverCapabilitiesOrFailure(
        page,
        adapter,
        "readiness.recover",
        deadline
      );
      onCapabilities(capabilities);
      capabilities = await ensureAuthenticatedCapabilities(
        page,
        adapter,
        options,
        deadline,
        authPollMs,
        capabilities,
        "readiness.recover",
        onCapabilities
      );
      onCapabilities(capabilities);
    }
  }
}

function isRecoverablePreSubmitFailure(error: unknown): boolean {
  return !(error instanceof AskFailure) || error.retryable;
}

function createDeadline(
  timeoutMs: number,
  onDeadline: ExecuteProviderPromptOptions["onDeadline"]
): DeadlineController {
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
      } catch {
        // Deadline reporting cannot change delivery semantics.
      }
    }
  };
}

async function discoverCapabilitiesOrFailure(
  page: Page,
  adapter: ProviderExecutionAdapter,
  stage: Extract<AskExecutionStage, "readiness.discover" | "readiness.recover" | "auth.handoff">,
  deadline: DeadlineController
): Promise<ProviderCapabilitySnapshot> {
  try {
    return await runPreDispatchBeforeDeadline(
      adapter,
      deadline,
      stage,
      stage === "auth.handoff" ? "AUTH_HANDOFF_TIMEOUT" : "BROWSER_UNAVAILABLE",
      () => adapter.discoverCapabilities(page)
    );
  } catch (error) {
    if (error instanceof AskFailure) {
      throw mergeFailureContext(error, { deliveryState: "not-attempted" });
    }
    throw failure(
      adapter,
      "BROWSER_UNAVAILABLE",
      stage,
      `Could not inspect ${adapter.displayName} readiness.`,
      `Run \`ask status --provider ${adapter.provider} --verbose\`.`,
      true,
      { deliveryState: "not-attempted" },
      error
    );
  }
}

class DeadlineExceededError extends Error {
  constructor() {
    super("The command deadline expired before the operation completed.");
    this.name = "DeadlineExceededError";
  }
}

async function withAbsoluteDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new DeadlineExceededError();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError()), remainingMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      timeout
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function runPreDispatchBeforeDeadline<T>(
  adapter: ProviderExecutionAdapter,
  deadline: DeadlineController,
  stage: AskExecutionStage,
  code: AskFailureCode,
  operation: () => Promise<T>,
  options: { preserveUnexpectedError?: boolean } = {}
): Promise<T> {
  ensureTimeRemaining(adapter, deadline, stage, code);
  try {
    return await withAbsoluteDeadline(operation, deadline.deadlineAt);
  } catch (error) {
    if (error instanceof AskFailure) {
      throw error;
    }
    if (!(error instanceof DeadlineExceededError)) {
      if (options.preserveUnexpectedError) {
        throw error;
      }
      throw failure(
        adapter,
        code,
        stage,
        `${adapter.displayName} failed while preparing ${preDispatchStageLabel(stage)} before dispatch.`,
        "Wait for the provider page to settle, then retry. No prompt was sent.",
        true,
        { deliveryState: "not-attempted" },
        error
      );
    }
    await deadline.notify(stage);
    throw failure(
      adapter,
      code,
      stage,
      `${adapter.displayName} did not become ready before the command deadline.`,
      "Retry with a longer --timeout after the provider page has finished loading.",
      true,
      { deliveryState: "not-attempted" },
      error
    );
  }
}

function preDispatchStageLabel(stage: AskExecutionStage): string {
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

function notifySubmissionUncertain(
  callback: ExecuteProviderPromptOptions["onSubmissionUncertain"],
  event: ProviderSubmissionUncertainEvent
): void {
  try {
    const callbackResult = callback?.(event);
    void Promise.resolve(callbackResult).catch(() => undefined);
  } catch {
    // Progress/reporting hooks cannot cross the irreversible dispatch boundary.
  }
}

async function notifyDeliveryConfirmed(
  callback: ExecuteProviderPromptOptions["onDeliveryConfirmed"],
  event: ProviderDeliveryConfirmedEvent
): Promise<void> {
  try {
    await callback?.(event);
  } catch {
    // Marker cleanup is helpful once delivery is proven, but failure cannot
    // alter exactly-once semantics. The conservative marker remains for a
    // later guarded lifecycle retry.
  }
}

function mergeFailureContext(
  error: AskFailure,
  context: ConstructorParameters<typeof AskFailure>[0]["context"],
  retryable = error.retryable
): AskFailure {
  return new AskFailure({
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

function hasStrongAuth(capabilities: ProviderCapabilitySnapshot): boolean {
  return capabilities.auth.state === "signed-in-likely" && capabilities.auth.confidence === "strong";
}

function assertNotBlocked(
  adapter: ProviderExecutionAdapter,
  capabilities: ProviderCapabilitySnapshot,
  stage: AskExecutionStage
): void {
  if (capabilities.auth.state !== "blocked") {
    return;
  }
  throw failure(
    adapter,
    "PROVIDER_BLOCKED",
    stage,
    `${adapter.displayName} is showing a verification or access-blocking page.`,
    "Complete the browser verification in the visible ask Chrome session, then retry.",
    true,
    { authState: "blocked", deliveryState: "not-attempted" }
  );
}

function authFailure(
  adapter: ProviderExecutionAdapter,
  capabilities: ProviderCapabilitySnapshot
): AskFailure {
  const authRequired = capabilities.auth.state === "login-required" || capabilities.auth.state === "guest";
  return failure(
    adapter,
    authRequired ? "AUTH_REQUIRED" : "AUTH_UNCONFIRMED",
    "auth.inspect",
    authRequired
      ? `${adapter.displayName} requires a signed-in session before ask can send this prompt.`
      : `${adapter.displayName} sign-in readiness could not be confirmed strongly.`,
    `Run \`ask login --provider ${adapter.provider}\`, finish signing in, then retry.`,
    true,
    {
      authState: capabilities.auth.state,
      promptInputVisible: capabilities.prompt.available,
      deliveryState: "not-attempted"
    }
  );
}

function ensureTimeRemaining(
  adapter: ProviderExecutionAdapter,
  deadline: DeadlineController,
  stage: AskExecutionStage,
  code: AskFailureCode
): void {
  if (deadline.remainingMs() > 0) {
    return;
  }
  throw failure(
    adapter,
    code,
    stage,
    `${adapter.displayName} did not become ready before the command deadline.`,
    "Retry with a longer --timeout after the provider page has finished loading.",
    true,
    { deliveryState: "not-attempted" }
  );
}

function failure(
  adapter: Pick<ProviderExecutionAdapter, "provider" | "displayName">,
  code: AskFailureCode,
  stage: AskExecutionStage,
  message: string,
  hint: string,
  retryable: boolean,
  context?: ConstructorParameters<typeof AskFailure>[0]["context"],
  cause?: unknown
): AskFailure {
  return new AskFailure({
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

function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function matchesChatGptConversationUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com")) &&
      /^\/c\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitOnPage(page: Page, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    await Promise.resolve();
    return;
  }
  await page.waitForTimeout(timeoutMs);
}

async function waitOnPageUntil(
  page: Page,
  timeoutMs: number,
  deadlineAt: number
): Promise<void> {
  const boundedMs = Math.min(Math.max(0, timeoutMs), Math.max(0, deadlineAt - Date.now()));
  if (boundedMs <= 0) {
    return;
  }
  try {
    await withAbsoluteDeadline(() => waitOnPage(page, boundedMs), deadlineAt);
  } catch (error) {
    if (!(error instanceof DeadlineExceededError)) {
      throw error;
    }
  }
}

async function waitForObservation(page: Page, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    return;
  }
  try {
    await page.waitForTimeout(timeoutMs);
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  }
}

async function waitForObservationUntil(
  page: Page,
  timeoutMs: number,
  deadlineAt: number
): Promise<void> {
  const boundedMs = Math.min(Math.max(0, timeoutMs), Math.max(0, deadlineAt - Date.now()));
  if (boundedMs <= 0) {
    return;
  }
  try {
    await withAbsoluteDeadline(() => waitForObservation(page, boundedMs), deadlineAt);
  } catch (error) {
    if (!(error instanceof DeadlineExceededError)) {
      throw error;
    }
  }
}

async function waitForTimerUntil(timeoutMs: number, deadlineAt: number): Promise<void> {
  const boundedMs = Math.min(Math.max(0, timeoutMs), Math.max(0, deadlineAt - Date.now()));
  if (boundedMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, boundedMs));
}

interface LocatorStrategy {
  name: string;
  strength: ProviderEvidenceStrength;
  locate(page: Page): Locator;
}

interface LocatedStrategy {
  strategy: LocatorStrategy;
  locator: Locator;
}

const CHATGPT_PROMPT_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy("chatgpt.prompt-id", "#prompt-textarea", "strong"),
  cssStrategy("chatgpt.prompt-testid", '[data-testid="prompt-textarea"]', "strong"),
  cssStrategy(
    "chatgpt.composer-region-role",
    '[data-testid*="composer"] [contenteditable="true"][role="textbox"]',
    "weak"
  ),
  cssStrategy(
    "chatgpt.composer-form-role",
    'main form [contenteditable="true"][role="textbox"], main form textarea',
    "weak"
  )
];

const CHATGPT_ACCOUNT_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy("chatgpt.account-profile-testid", '[data-testid="accounts-profile-button"]', "strong"),
  cssStrategy("chatgpt.profile-testid", '[data-testid="profile-button"]', "strong"),
  cssStrategy("chatgpt.account-menu-structure", 'nav button[aria-haspopup="menu"]', "weak")
];

const CHATGPT_SIGN_IN_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy("chatgpt.login-href", 'a[href*="/auth/login"]', "strong"),
  cssStrategy("chatgpt.login-testid", '[data-testid="login-button"]', "strong"),
  cssStrategy("chatgpt.signup-href", 'a[href*="/auth/signup"]', "strong")
];

const CHATGPT_BLOCKED_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy("chatgpt.cloudflare-frame", 'iframe[src*="challenges.cloudflare.com"]', "strong"),
  cssStrategy("chatgpt.challenge-testid", '[data-testid*="challenge"]', "strong"),
  cssStrategy("chatgpt.turnstile", '[data-testid="cf-turnstile"]', "strong")
];

const CHATGPT_FILE_INPUT_STRATEGIES: readonly LocatorStrategy[] = [
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

const CHATGPT_ATTACHMENT_REMOVE_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy(
    "chatgpt.attachment-remove-testid",
    '[data-testid*="composer"] button[data-testid*="remove"], main form button[data-testid*="remove"]',
    "strong"
  ),
  cssStrategy(
    "chatgpt.file-thumbnail-remove",
    '[data-testid*="composer"] [data-testid="file-thumbnail"] button, main form [data-testid="file-thumbnail"] button',
    "weak"
  ),
  cssStrategy(
    "chatgpt.attachment-preview-remove",
    '[data-testid*="composer"] [data-testid="attachment-preview"] button, ' +
      'main form [data-testid="attachment-preview"] button, ' +
      '[data-testid*="composer"] [data-testid="attachment-pill"] button, ' +
      'main form [data-testid="attachment-pill"] button',
    "weak"
  ),
  cssStrategy(
    "chatgpt.attachment-remove-label",
    '[data-testid*="composer"] button[aria-label*="Remove" i], main form button[aria-label*="Remove" i], ' +
      '[data-testid*="composer"] button[aria-label*="Delete" i], main form button[aria-label*="Delete" i], ' +
      '[data-testid*="composer"] button[aria-label*="移除"], main form button[aria-label*="移除"], ' +
      '[data-testid*="composer"] button[aria-label*="刪除"], main form button[aria-label*="刪除"]',
    "weak"
  )
];

const CHATGPT_SEND_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy("chatgpt.send-testid", 'button[data-testid="send-button"]', "strong"),
  cssStrategy("chatgpt.composer-submit-testid", 'button[data-testid="composer-submit-button"]', "strong"),
  cssStrategy("chatgpt.form-submit", 'main form button[type="submit"]', "weak")
];

const CHATGPT_RESPONSE_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy(
    "chatgpt.assistant-role",
    '[data-message-author-role="assistant"]',
    "strong"
  ),
  cssStrategy("chatgpt.conversation-main", "main", "weak")
];

const CHATGPT_STOP_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy("chatgpt.stop-testid", 'button[data-testid="stop-button"]', "strong"),
  cssStrategy("chatgpt.composer-stop-testid", 'button[data-testid="composer-stop-button"]', "strong")
];

interface ChatGptExecutionAdapterOptions {
  automation: Pick<ProviderAutomation, "attachFiles" | "waitForAssistantCompletion"> &
    Partial<Pick<ProviderAutomation, "extractLatestAssistantText">>;
  matchesConversationUrl?: (value: string | undefined) => boolean;
  attachmentVerificationMs?: number;
  draftVerificationMs?: number;
  pollMs?: number;
}

/** Builds the ChatGPT-specific, locale-independent execution adapter. */
export function createChatGptExecutionAdapter(
  options: ChatGptExecutionAdapterOptions
): ProviderExecutionAdapter {
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
    attachAndVerify: (page, filePaths, deadlineAt) => attachAndVerifyChatGptFiles(
      page,
      options.automation,
      filePaths,
      Math.min(deadlineAt, Date.now() + attachmentVerificationMs),
      pollMs
    ),
    fillAndVerifyDraft: (page, prompt, deadlineAt) => fillAndVerifyChatGptDraft(
      page,
      prompt,
      Math.min(deadlineAt, Date.now() + draftVerificationMs),
      pollMs
    ),
    captureBaseline: (page) => captureChatGptBaseline(page),
    preselectDispatch: (page, deadlineAt) => preselectChatGptDispatch(page, deadlineAt, pollMs),
    observeSubmission: (page, baseline, prompt) => observeChatGptSubmission(
      page,
      baseline,
      prompt,
      options.matchesConversationUrl || matchesChatGptConversationUrl
    ),
    capturePartialResponse: (page, baseline) => captureChatGptPartialResponse(
      page,
      baseline,
      options.automation.extractLatestAssistantText
    ),
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

async function discoverChatGptCapabilities(page: Page): Promise<ProviderCapabilitySnapshot> {
  const prompt = await firstEditableStrategy(page, CHATGPT_PROMPT_STRATEGIES);
  const accountEvidence = await collectStrategyEvidence(
    page,
    CHATGPT_ACCOUNT_STRATEGIES,
    "auth-ready",
    "visible-or-attached"
  );
  const signInEvidence = await collectStrategyEvidence(
    page,
    CHATGPT_SIGN_IN_STRATEGIES,
    "auth-required",
    "visible"
  );
  const blockedEvidence = await collectStrategyEvidence(
    page,
    CHATGPT_BLOCKED_STRATEGIES,
    "provider-blocked",
    "visible-or-attached"
  );
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
        claim: "dispatch" as const,
        strength: "weak" as const,
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

function aggregateAuth(
  ready: ProviderExecutionEvidence[],
  required: ProviderExecutionEvidence[],
  blocked: ProviderExecutionEvidence[],
  promptAvailable: boolean
): ProviderAuthCapability {
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

function strongestConfidence(evidence: readonly ProviderExecutionEvidence[]): "strong" | "weak" {
  return evidence.some((item) => item.strength === "strong") ? "strong" : "weak";
}

function capability(
  strategy: string | undefined,
  evidence: readonly ProviderExecutionEvidence[]
): ProviderCapability {
  return {
    available: strategy !== undefined,
    ...(strategy ? { strategy } : {}),
    evidence
  };
}

async function attachAndVerifyChatGptFiles(
  page: Page,
  automation: Pick<ProviderAutomation, "attachFiles">,
  filePaths: readonly string[],
  verificationDeadline: number,
  pollMs: number
): Promise<AttachmentVerification> {
  const resolvedPaths = filePaths.map((filePath) => path.resolve(filePath));
  validateAttachmentPaths(resolvedPaths);
  const requestedNames = resolvedPaths.map((filePath) => path.basename(filePath));
  const requestedCounts = countNames(requestedNames);
  await clearChatGptComposerAttachments(page, requestedNames, verificationDeadline, pollMs);
  if (resolvedPaths.length === 0) {
    return { files: [] };
  }
  await automation.attachFiles(page, resolvedPaths);

  let surface: AttachmentSurfaceState;
  do {
    surface = await readAttachmentSurfaceState(page, requestedNames);
    const hasEveryFinishedAttachment = [...requestedCounts].every(([name, count]) =>
      (surface.entriesByName.get(name) || []).filter((entry) => !entry.pending).length >= count
    );
    if (hasEveryFinishedAttachment) {
      const evidenceIndexByName = new Map<string, number>();
      return {
        files: resolvedPaths.map((filePath) => {
          const name = path.basename(filePath);
          const evidenceIndex = evidenceIndexByName.get(name) || 0;
          evidenceIndexByName.set(name, evidenceIndex + 1);
          const finishedEntries = (surface.entriesByName.get(name) || [])
            .filter((entry) => !entry.pending);
          return {
            path: filePath,
            name,
            evidence: finishedEntries[evidenceIndex]!.evidence
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
  throw chatGptFailure(
    "ATTACHMENT_UPLOAD_FAILED",
    "attachment.upload",
    `ChatGPT did not show finished composer attachment state for: ${unresolved.join(", ")}.`,
    "Wait for attachment processing to finish and retry once.",
    true
  );
}

function validateAttachmentPaths(filePaths: readonly string[]): void {
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      throw chatGptFailure(
        "ATTACHMENT_INVALID",
        "attachment.upload",
        `Attachment file does not exist: ${filePath}`,
        "Check the attachment path, then try again.",
        false
      );
    }
    if (!fs.statSync(filePath).isFile()) {
      throw chatGptFailure(
        "ATTACHMENT_INVALID",
        "attachment.upload",
        `Attachment path is not a regular file: ${filePath}`,
        "Choose a regular file instead of a directory, then try again.",
        false
      );
    }
  }
}

interface AttachmentSurfaceState {
  entriesByName: Map<string, AttachmentSurfaceEntry[]>;
  selectedCountByName: Map<string, number>;
  selectedFileCount: number;
}

interface AttachmentSurfaceEntry {
  pending: boolean;
  evidence: ProviderExecutionEvidence;
}

async function readAttachmentSurfaceState(
  page: Page,
  requestedNames: readonly string[]
): Promise<AttachmentSurfaceState> {
  const entriesByName = new Map<string, AttachmentSurfaceEntry[]>();
  const selectedNames: string[] = [];
  const inputs = page.locator('input[type="file"]');
  try {
    const count = await inputs.count();
    for (let index = 0; index < count; index += 1) {
      const names = await inputs.nth(index).evaluate((element) =>
        Array.from((element as HTMLInputElement).files || []).map((file) => file.name)
      );
      for (const name of names) {
        selectedNames.push(name);
      }
    }
  } catch {
    // ChatGPT commonly replaces or clears the input after accepting an upload.
  }

  const selectedCountByName = countNames(selectedNames);

  try {
    const requestedIdentities = [...new Set(requestedNames)].map((name) => ({
      name,
      patternSource: attachmentIdentityPatternSource(name)
    }));
    const observation = await page.evaluate((identities) => {
      const candidateNodes = Array.from(document.querySelectorAll<HTMLElement>(
        '[data-testid*="attachment"], [data-testid*="file"], [data-testid*="upload"], [aria-label]'
      )).filter((node) => node.closest('form, [data-testid*="composer"]'));
      const rootFor = (node: HTMLElement) =>
        node.closest<HTMLElement>('[data-testid*="attachment"]') ||
        node.closest<HTMLElement>('[data-testid*="file"]') ||
        node.closest<HTMLElement>('[data-testid*="upload"]') ||
        node;
      const roots = [...new Set(candidateNodes.map(rootFor))].filter((node) => {
        if (node.hidden || node.getAttribute("aria-hidden") === "true") {
          return false;
        }
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      const valuesFor = (node: HTMLElement) => {
        const relevant = [node, ...Array.from(node.querySelectorAll<HTMLElement>(
          '[aria-label], [title], [download], [data-file-name], [data-filename]'
        ))];
        return relevant.flatMap((element) => [
          element.getAttribute("data-file-name"),
          element.getAttribute("data-filename"),
          element.getAttribute("title"),
          element.getAttribute("download"),
          element.getAttribute("aria-label"),
          element === node ? element.innerText || element.textContent : undefined
        ]).filter((value): value is string => Boolean(value?.trim()))
          .map((value) => value.normalize("NFC").trim());
      };
      const isPending = (node: HTMLElement) => {
        const state = `${node.getAttribute("data-state") || ""} ${node.getAttribute("data-status") || ""}`;
        return /upload|pending|progress/i.test(state) ||
          node.getAttribute("aria-busy") === "true" ||
          Boolean(node.querySelector(
            'progress, [role="progressbar"], [aria-busy="true"], [data-testid*="progress"], [data-state*="upload"]'
          ));
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
  } catch {
    // Transitional pages may not have a readable DOM yet; the caller polls.
  }
  return { entriesByName, selectedCountByName, selectedFileCount: selectedNames.length };
}

async function clearChatGptComposerAttachments(
  page: Page,
  requestedNames: readonly string[],
  deadlineAt: number,
  pollMs: number
): Promise<void> {
  const fileInputs = page.locator('input[type="file"]');
  try {
    const inputCount = await fileInputs.count();
    for (let index = 0; index < inputCount; index += 1) {
      await fileInputs.nth(index).setInputFiles([]).catch(() => undefined);
    }
  } catch {
    // ChatGPT may replace the file input while clearing its composer state.
  }

  let removals = 0;
  while (Date.now() < deadlineAt && removals < 50) {
    const remove = await firstActionableClickStrategy(
      page,
      CHATGPT_ATTACHMENT_REMOVE_STRATEGIES,
      Math.min(250, Math.max(1, deadlineAt - Date.now()))
    );
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
  const matchingNamesRemain = [...new Set(requestedNames)].filter((name) =>
    (surface.entriesByName.get(name)?.length || 0) > 0 ||
    (surface.selectedCountByName.get(name) || 0) > 0
  );
  if (
    matchingNamesRemain.length > 0 ||
    surface.selectedFileCount > 0 ||
    knownRoots > 0 ||
    remainingRemove
  ) {
    throw chatGptFailure(
      "ATTACHMENT_UPLOAD_FAILED",
      "attachment.upload",
      "ChatGPT retained a pre-existing composer attachment that could not be cleared safely.",
      "Remove the existing composer attachment in the visible ChatGPT tab, then retry.",
      true
    );
  }
}

function countNames(names: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

function attachmentIdentityPatternSource(name: string): string {
  const normalized = name.normalize("NFC");
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = `[\\s\\[\\](){}"'“”‘’:;,|]`;
  return `(?:^|${boundary})${escaped}(?=$|${boundary})`;
}

async function fillAndVerifyChatGptDraft(
  page: Page,
  prompt: string,
  verificationDeadline: number,
  pollMs: number
): Promise<DraftVerification> {
  const found = await firstEditableStrategy(page, CHATGPT_PROMPT_STRATEGIES);
  if (!found) {
    throw chatGptFailure(
      "PROMPT_INPUT_NOT_FOUND",
      "prompt.find",
      "Could not find a visible ChatGPT message box.",
      "Wait for ChatGPT to finish loading, then retry.",
      true
    );
  }

  try {
    // Playwright fill already performs the required actionability checks and
    // focuses editable controls. A separate click is harmful on ChatGPT's
    // short-lived fallback textarea: the click can wait for hydration/navigation
    // after it has already landed and consume the entire verification budget.
    await found.locator.fill(prompt, {
      timeout: Math.max(1, verificationDeadline - Date.now())
    });
  } catch {
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

  throw chatGptFailure(
    "PROMPT_FILL_UNCONFIRMED",
    "prompt.verify",
    "ChatGPT draft readback did not match the requested prompt.",
    "Wait for the ChatGPT composer to finish loading, then retry.",
    true
  );
}

async function readDraft(locator: Locator, deadlineAt = Date.now() + 250): Promise<string | undefined> {
  const timeoutMs = Math.max(1, Math.min(250, deadlineAt - Date.now()));
  try {
    return await locator.inputValue({ timeout: timeoutMs });
  } catch {
    try {
      return await locator.evaluate((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          return element.value;
        }
        return (element as HTMLElement).innerText || element.textContent || "";
      }, undefined, { timeout: Math.max(1, Math.min(250, deadlineAt - Date.now())) });
    } catch {
      return undefined;
    }
  }
}

function normalizeDraft(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .replace(/\n+$/, "");
}

async function preselectChatGptDispatch(
  page: Page,
  deadlineAt: number,
  pollMs: number
): Promise<PromptDispatchSelection> {
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
      } catch (error) {
        throw chatGptFailure(
          "PROMPT_SUBMIT_FAILED",
          "prompt.submit",
          "ChatGPT send control was not actionable before dispatch.",
          "Wait for the composer to settle, then retry.",
          true,
          error
        );
      }
      if (Date.now() < deadlineAt) {
        await waitOnPage(page, Math.min(pollMs, deadlineAt - Date.now()));
        continue;
      }
      throw chatGptFailure(
        "PROMPT_SUBMIT_FAILED",
        "prompt.submit",
        "ChatGPT send control remained disabled before dispatch.",
        "Wait for attachments to finish processing, then retry.",
        true
      );
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

    throw chatGptFailure(
      "PROMPT_INPUT_NOT_FOUND",
      "prompt.find",
      "ChatGPT composer disappeared before a dispatch strategy could be selected.",
      "Wait for ChatGPT to finish loading, then retry.",
      true
    );
  } while (true);
}

async function captureChatGptBaseline(page: Page): Promise<ProviderConversationBaseline> {
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

async function captureChatGptTurns(
  page: Page
): Promise<{ user: ProviderTurnBaseline; assistant: ProviderTurnBaseline }> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined) =>
      (value || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
    const topLevel = (role: "user" | "assistant") => {
      const all = Array.from(document.querySelectorAll<HTMLElement>(
        `[data-message-author-role="${role}"]`
      ));
      return all.filter((node) => !all.some((other) => other !== node && other.contains(node)));
    };
    const summarize = (nodes: HTMLElement[]) => {
      const latest = nodes.at(-1);
      const turn = latest?.closest<HTMLElement>("section[data-turn-id], [data-testid^=conversation-turn-]");
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

async function captureChatGptPartialResponse(
  page: Page,
  baseline: ProviderConversationBaseline,
  extractLatestAssistantText?: (page: Page) => Promise<string>
): Promise<string> {
  const turns = await captureChatGptTurns(page);
  const assistantAdvanced = turns.assistant.count > baseline.assistant.count || Boolean(
    turns.assistant.latestId &&
    baseline.assistant.latestId &&
    turns.assistant.latestId !== baseline.assistant.latestId
  );
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

async function observeChatGptSubmission(
  page: Page,
  baseline: ProviderConversationBaseline,
  prompt: string,
  matchesConversationUrl: (value: string | undefined) => boolean
): Promise<SubmissionObservation> {
  const evidence: ProviderExecutionEvidence[] = [];
  const turns = await captureChatGptTurns(page);

  const userTurnAdvanced = turns.user.count > baseline.user.count || Boolean(
    turns.user.latestId &&
    baseline.user.latestId &&
    turns.user.latestId !== baseline.user.latestId
  );
  if (
    userTurnAdvanced &&
    normalizeDraft(turns.user.latestText || "") === normalizeDraft(prompt)
  ) {
    evidence.push({
      name: turns.user.count > baseline.user.count
        ? "chatgpt.user-turn-count-advanced"
        : "chatgpt.user-turn-identity-changed",
      claim: "submission",
      strength: "strong",
      independenceKey: "user-turn"
    });
  }

  if (
    turns.assistant.count > baseline.assistant.count ||
    (turns.assistant.latestId &&
      baseline.assistant.latestId &&
      turns.assistant.latestId !== baseline.assistant.latestId)
  ) {
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
const GEMINI_PROMPT_STRATEGIES: readonly LocatorStrategy[] = [
  cssAllStrategy(
    "gemini.rich-textarea-role-textbox",
    'main rich-textarea [contenteditable="true"][role="textbox"]',
    "strong"
  ),
  cssAllStrategy(
    "gemini.rich-textarea-contenteditable",
    'main rich-textarea [contenteditable="true"]',
    "strong"
  ),
  cssAllStrategy(
    "gemini.composer-testid-role-textbox",
    'main [data-testid="composer"] [contenteditable="true"][role="textbox"]',
    "strong"
  )
];

const GEMINI_ACCOUNT_STRATEGIES: readonly LocatorStrategy[] = [
  cssAllStrategy("gemini.account-signout-options", 'a[href*="SignOutOptions"]', "strong"),
  cssStrategy("gemini.account-menu-testid", '[data-testid="account-menu"]', "strong"),
  cssStrategy("gemini.profile-button-testid", 'button[data-testid="profile-button"]', "strong")
];

const GEMINI_SIGN_IN_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy(
    "gemini.sign-in-service-login",
    'a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/o/oauth2"]',
    "strong"
  ),
  cssStrategy("gemini.sign-in-testid", '[data-testid="sign-in-button"]', "strong"),
  // These labels are intentionally only weak evidence: they are localized
  // presentation text, not an identity or authenticated-session contract.
  cssStrategy(
    "gemini.sign-in-aria-label-en",
    'a[aria-label*="Sign in" i], button[aria-label*="Sign in" i]',
    "weak"
  ),
  cssStrategy(
    "gemini.sign-in-aria-label-zh-tw",
    'a[aria-label*="登入"], button[aria-label*="登入"]',
    "weak"
  )
];

const GEMINI_BLOCKED_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy("gemini.challenge-testid", '[data-testid*="challenge"]', "strong"),
  cssStrategy("gemini.recaptcha-frame", 'iframe[src*="recaptcha"]', "strong"),
  cssStrategy("gemini.turnstile-frame", 'iframe[src*="challenges.cloudflare.com"]', "strong")
];

const GEMINI_SEND_STRATEGIES: readonly LocatorStrategy[] = [
  cssAllStrategy(
    "gemini.composer-send-testid",
    'main [data-testid="composer"] button[data-testid="send-button"]',
    "strong"
  ),
  cssAllStrategy(
    "gemini.composer-submit-testid",
    'main form[data-testid="composer"] button[data-testid="send-button"]',
    "strong"
  ),
  cssAllStrategy(
    "gemini.input-area-send-aria-en",
    'main .text-input-field button[aria-label="Send message"]',
    "weak"
  ),
  cssAllStrategy(
    "gemini.input-area-send-aria-zh-tw",
    'main .text-input-field button[aria-label="傳送訊息"]',
    "weak"
  )
];

const GEMINI_RESPONSE_CAPABILITY_STRATEGIES: readonly LocatorStrategy[] = [
  cssStrategy(
    "gemini.response-conversation-id",
    'main .conversation-container[id] response-container',
    "strong"
  ),
  cssStrategy(
    "gemini.response-container-indexed",
    'main response-container[data-response-index]',
    "strong"
  ),
  // An empty new conversation has no response-container yet. `main` only
  // establishes that the scoped app surface exists; turn identity is captured
  // later from either a response index or its stable conversation-container id.
  cssStrategy("gemini.app-main", "main", "weak")
];

interface GeminiExecutionAdapterOptions {
  automation: Pick<ProviderAutomation, "waitForAssistantCompletion"> &
    Partial<Pick<ProviderAutomation, "extractLatestAssistantText">>;
  matchesConversationUrl?: (value: string | undefined) => boolean;
  draftVerificationMs?: number;
  readinessDiscoveryMs?: number;
  pollMs?: number;
}

/**
 * Builds Gemini's fail-closed exactly-once adapter.
 *
 * No Enter strategy is exposed. Gemini dispatch is permitted only after a
 * single, structural, uniquely actionable button has been selected.
 */
export function createGeminiExecutionAdapter(
  options: GeminiExecutionAdapterOptions
): ProviderExecutionAdapter {
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
    discoverCapabilities: (page) => discoverGeminiCapabilities(
      page,
      Date.now() + readinessDiscoveryMs,
      pollMs
    ),
    attachAndVerify: (page, filePaths, _deadlineAt) => attachAndVerifyGeminiFiles(page, filePaths),
    fillAndVerifyDraft: (page, prompt, deadlineAt) => fillAndVerifyGeminiDraft(
      page,
      prompt,
      Math.min(deadlineAt, Date.now() + draftVerificationMs),
      pollMs
    ),
    captureBaseline: (page) => captureGeminiBaseline(page),
    preselectDispatch: (page, deadlineAt) => preselectGeminiDispatch(page, deadlineAt),
    observeSubmission: (page, baseline, prompt) => observeGeminiSubmission(
      page,
      baseline,
      prompt,
      options.matchesConversationUrl || matchesGeminiConversationUrl
    ),
    capturePartialResponse: (page, baseline) => captureGeminiPartialResponse(
      page,
      baseline,
      options.automation.extractLatestAssistantText
    ),
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

async function discoverGeminiCapabilities(
  page: Page,
  discoveryDeadline: number,
  pollMs: number
): Promise<ProviderCapabilitySnapshot> {
  let snapshot = await discoverGeminiCapabilitiesOnce(page);
  while (!geminiCapabilityDiscoveryIsConclusive(snapshot) && Date.now() < discoveryDeadline) {
    await waitOnPage(page, Math.min(pollMs, discoveryDeadline - Date.now()));
    snapshot = await discoverGeminiCapabilitiesOnce(page);
  }
  return snapshot;
}

function geminiCapabilityDiscoveryIsConclusive(snapshot: ProviderCapabilitySnapshot): boolean {
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

async function discoverGeminiCapabilitiesOnce(page: Page): Promise<ProviderCapabilitySnapshot> {
  const prompt = await firstUniqueEditableStrategy(page, GEMINI_PROMPT_STRATEGIES);
  const accountEvidence = await collectStrategyEvidence(
    page,
    GEMINI_ACCOUNT_STRATEGIES,
    "auth-ready",
    "visible-or-attached"
  );
  const signInEvidence = await collectStrategyEvidence(
    page,
    GEMINI_SIGN_IN_STRATEGIES,
    "auth-required",
    "visible"
  );
  const blockedEvidence = await collectStrategyEvidence(
    page,
    GEMINI_BLOCKED_STRATEGIES,
    "provider-blocked",
    "visible-or-attached"
  );
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
        claim: "dispatch" as const,
        strength: "weak" as const,
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

async function attachAndVerifyGeminiFiles(
  _page: Page,
  filePaths: readonly string[]
): Promise<AttachmentVerification> {
  const resolvedPaths = filePaths.map((filePath) => path.resolve(filePath));
  validateGeminiAttachmentPaths(resolvedPaths);
  if (resolvedPaths.length === 0) {
    return { files: [] };
  }

  throw geminiFailure(
    "ATTACHMENT_UPLOAD_FAILED",
    "attachment.upload",
    "Gemini attachment completion cannot be verified from the current supported composer surface.",
    "Gemini attachments are not supported by exactly-once sending yet; remove --attach or use Gemini manually.",
    false
  );
}

function validateGeminiAttachmentPaths(filePaths: readonly string[]): void {
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      throw geminiFailure(
        "ATTACHMENT_INVALID",
        "attachment.upload",
        `Attachment file does not exist: ${filePath}`,
        "Check the attachment path, then try again.",
        false
      );
    }
    if (!fs.statSync(filePath).isFile()) {
      throw geminiFailure(
        "ATTACHMENT_INVALID",
        "attachment.upload",
        `Attachment path is not a regular file: ${filePath}`,
        "Choose a regular file instead of a directory, then try again.",
        false
      );
    }
  }
}

async function fillAndVerifyGeminiDraft(
  page: Page,
  prompt: string,
  verificationDeadline: number,
  pollMs: number
): Promise<DraftVerification> {
  const found = await firstUniqueEditableStrategy(page, GEMINI_PROMPT_STRATEGIES);
  if (!found) {
    throw geminiFailure(
      "PROMPT_INPUT_NOT_FOUND",
      "prompt.find",
      "Could not find a visible, editable Gemini message box in the supported composer surface.",
      "Wait for Gemini to finish loading, then retry.",
      true
    );
  }

  await found.locator.click({ timeout: Math.max(1, verificationDeadline - Date.now()) });
  try {
    await found.locator.fill(prompt, { timeout: Math.max(1, verificationDeadline - Date.now()) });
  } catch {
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

  throw geminiFailure(
    "PROMPT_FILL_UNCONFIRMED",
    "prompt.verify",
    "Gemini draft readback did not match the requested prompt.",
    "Wait for the Gemini composer to finish loading, then retry.",
    true
  );
}

async function preselectGeminiDispatch(
  page: Page,
  deadlineAt: number
): Promise<PromptDispatchSelection> {
  const send = await firstUniqueActionableClickStrategy(
    page,
    GEMINI_SEND_STRATEGIES,
    Math.max(1, deadlineAt - Date.now())
  );
  if (!send) {
    throw geminiFailure(
      "PROMPT_SUBMIT_FAILED",
      "prompt.submit",
      "Could not identify exactly one enabled Gemini send control before dispatch.",
      "Wait for the Gemini composer to settle, then retry. Ask will not use Enter as a fallback.",
      true
    );
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

async function captureGeminiBaseline(page: Page): Promise<ProviderConversationBaseline> {
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

async function captureGeminiAssistantTurns(page: Page): Promise<ProviderTurnBaseline> {
  return page.evaluate((_capture) => {
    const normalize = (value: string | null | undefined) =>
      (value || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
    const all = Array.from(document.querySelectorAll<HTMLElement>(
      'main .conversation-container[id] response-container, main response-container[data-response-index]'
    ));
    const turns = all.filter((node) => !all.some((other) => other !== node && other.contains(node)));
    const latest = turns.at(-1);
    const latestId = latest?.getAttribute("data-response-index") ||
      latest?.getAttribute("data-message-id") ||
      latest?.closest<HTMLElement>(".conversation-container[id]")?.id ||
      latest?.querySelector<HTMLElement>("message-content[id]")?.id ||
      undefined;
    const content = latest?.querySelector<HTMLElement>("message-content") || latest;
    return {
      count: turns.length,
      ...(latestId ? { latestId } : {}),
      ...(latest ? { latestText: normalize(content?.innerText || content?.textContent) } : {})
    };
  }, "gemini-assistant-turns");
}

async function captureGeminiPartialResponse(
  page: Page,
  baseline: ProviderConversationBaseline,
  extractLatestAssistantText?: (page: Page) => Promise<string>
): Promise<string> {
  const assistant = await captureGeminiAssistantTurns(page);
  const assistantAdvanced = assistant.count > baseline.assistant.count || Boolean(
    assistant.latestId &&
    baseline.assistant.latestId &&
    assistant.latestId !== baseline.assistant.latestId
  );
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

async function observeGeminiSubmission(
  page: Page,
  baseline: ProviderConversationBaseline,
  prompt: string,
  matchesConversationUrl: (value: string | undefined) => boolean
): Promise<SubmissionObservation> {
  const evidence: ProviderExecutionEvidence[] = [];
  const assistant = await captureGeminiAssistantTurns(page);
  if (
    assistant.count > baseline.assistant.count ||
    (assistant.latestId &&
      baseline.assistant.latestId &&
      assistant.latestId !== baseline.assistant.latestId)
  ) {
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

function matchesGeminiConversationUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.hostname === "gemini.google.com" && /^\/app\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function assistantBaseline(baseline: ProviderConversationBaseline): AssistantResponseBaseline {
  return {
    key: baseline.assistant.latestId,
    text: baseline.assistant.latestText || "",
    count: baseline.assistant.count
  };
}

function cssStrategy(
  name: string,
  selector: string,
  strength: ProviderEvidenceStrength
): LocatorStrategy {
  return { name, strength, locate: (page) => page.locator(selector).last() };
}

/** Keeps the complete match set so a caller can reject ambiguity explicitly. */
function cssAllStrategy(
  name: string,
  selector: string,
  strength: ProviderEvidenceStrength
): LocatorStrategy {
  return { name, strength, locate: (page) => page.locator(selector) };
}

async function firstVisibleStrategy(
  page: Page,
  strategies: readonly LocatorStrategy[]
): Promise<LocatedStrategy | undefined> {
  for (const strategy of strategies) {
    const locator = strategy.locate(page);
    try {
      if ((await locator.count()) > 0 && await locator.isVisible()) {
        return { strategy, locator };
      }
    } catch {
      // Continue across transient SPA replacements.
    }
  }
  return undefined;
}

async function firstEditableStrategy(
  page: Page,
  strategies: readonly LocatorStrategy[]
): Promise<LocatedStrategy | undefined> {
  for (const strategy of strategies) {
    const locator = strategy.locate(page);
    try {
      if (
        (await locator.count()) > 0 &&
        await locator.isVisible() &&
        await locator.isEnabled() &&
        await locator.isEditable()
      ) {
        return { strategy, locator };
      }
    } catch {
      // Continue across read-only fallbacks and transient SPA replacements.
    }
  }
  return undefined;
}

/** Gemini must not choose between multiple editable composer candidates. */
async function firstUniqueEditableStrategy(
  page: Page,
  strategies: readonly LocatorStrategy[]
): Promise<LocatedStrategy | undefined> {
  for (const strategy of strategies) {
    const locator = strategy.locate(page);
    try {
      if (
        (await locator.count()) !== 1 ||
        !(await locator.isVisible()) ||
        !(await locator.isEnabled()) ||
        !(await locator.isEditable())
      ) {
        continue;
      }
      return { strategy, locator };
    } catch {
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
async function firstUniqueActionableClickStrategy(
  page: Page,
  strategies: readonly LocatorStrategy[],
  timeoutMs: number
): Promise<LocatedStrategy | undefined> {
  for (const strategy of strategies) {
    const locator = strategy.locate(page);
    try {
      if (
        (await locator.count()) !== 1 ||
        !(await locator.isVisible()) ||
        !(await locator.isEnabled())
      ) {
        continue;
      }
      await locator.click({ trial: true, timeout: Math.max(1, timeoutMs) });
      return { strategy, locator };
    } catch {
      // A unique candidate still needs to satisfy Playwright actionability.
    }
  }
  return undefined;
}

async function firstActionableClickStrategy(
  page: Page,
  strategies: readonly LocatorStrategy[],
  timeoutMs: number
): Promise<LocatedStrategy | undefined> {
  for (const strategy of strategies) {
    const locator = strategy.locate(page);
    try {
      if ((await locator.count()) === 0 || !(await locator.isVisible()) || !(await locator.isEnabled())) {
        continue;
      }
      await locator.click({ trial: true, timeout: Math.max(1, timeoutMs) });
      return { strategy, locator };
    } catch {
      // Capability discovery reports only controls that pass Playwright actionability.
    }
  }
  return undefined;
}

async function firstAttachedStrategy(
  page: Page,
  strategies: readonly LocatorStrategy[]
): Promise<LocatedStrategy | undefined> {
  for (const strategy of strategies) {
    const locator = strategy.locate(page);
    try {
      if ((await locator.count()) > 0) {
        return { strategy, locator };
      }
    } catch {
      // Continue across transient SPA replacements.
    }
  }
  return undefined;
}

async function collectStrategyEvidence(
  page: Page,
  strategies: readonly LocatorStrategy[],
  claim: ProviderEvidenceClaim,
  mode: "visible" | "visible-or-attached"
): Promise<ProviderExecutionEvidence[]> {
  const evidence: ProviderExecutionEvidence[] = [];
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
    } catch {
      // Continue across transient SPA replacements.
    }
  }
  return evidence;
}

function strategyEvidence(
  strategy: LocatorStrategy,
  claim: ProviderEvidenceClaim
): ProviderExecutionEvidence {
  return { name: strategy.name, claim, strength: strategy.strength };
}

function chatGptFailure(
  code: AskFailureCode,
  stage: AskExecutionStage,
  message: string,
  hint: string,
  retryable: boolean,
  cause?: unknown
): AskFailure {
  return new AskFailure({
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

function geminiFailure(
  code: AskFailureCode,
  stage: AskExecutionStage,
  message: string,
  hint: string,
  retryable: boolean,
  cause?: unknown
): AskFailure {
  return new AskFailure({
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
