import type { ProviderName } from "./providers";
import type { AuthState } from "./webchat";

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export type AskExecutionStage =
  | "queue.acquire"
  | "browser.connect"
  | "conversation.resolve"
  | "page.open"
  | "auth.inspect"
  | "attachment.upload"
  | "prompt.find"
  | "response.baseline"
  | "prompt.submit"
  | "response.wait"
  | "conversation.save";

export type AskFailureCode =
  | "QUEUE_UNAVAILABLE"
  | "BROWSER_UNAVAILABLE"
  | "SESSION_CONFLICT"
  | "AUTH_REQUIRED"
  | "AUTH_UNCONFIRMED"
  | "PROVIDER_BLOCKED"
  | "ATTACHMENT_INVALID"
  | "ATTACHMENT_UPLOAD_FAILED"
  | "PROMPT_INPUT_NOT_FOUND"
  | "PROMPT_SUBMIT_FAILED"
  | "RESPONSE_TIMEOUT"
  | "RESPONSE_NOT_DETECTED"
  | "CONVERSATION_STATE_FAILED"
  | "UNEXPECTED_FAILURE";

export interface AskFailureContext {
  providerHost?: string;
  authState?: AuthState;
  promptInputVisible?: boolean;
}

export interface AskFailureOptions {
  code: AskFailureCode;
  stage: AskExecutionStage;
  provider: ProviderName;
  providerDisplayName: string;
  message: string;
  retryable: boolean;
  hint: string;
  detail?: string;
  context?: AskFailureContext;
  cause?: unknown;
  exitCode?: number;
}

export class AskFailure extends CliError {
  readonly code: AskFailureCode;
  readonly stage: AskExecutionStage;
  readonly provider: ProviderName;
  readonly providerDisplayName: string;
  readonly retryable: boolean;
  readonly hint: string;
  readonly detail?: string;
  readonly context?: AskFailureContext;
  override readonly cause?: unknown;

  constructor(options: AskFailureOptions) {
    super(options.message, options.exitCode);
    this.name = "AskFailure";
    this.code = options.code;
    this.stage = options.stage;
    this.provider = options.provider;
    this.providerDisplayName = options.providerDisplayName;
    this.retryable = options.retryable;
    this.hint = options.hint;
    this.detail = options.detail;
    this.context = options.context;
    this.cause = options.cause;
  }
}
