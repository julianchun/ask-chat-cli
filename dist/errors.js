"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AskFailure = exports.CliError = void 0;
class CliError extends Error {
    exitCode;
    constructor(message, exitCode = 1) {
        super(message);
        this.name = "CliError";
        this.exitCode = exitCode;
    }
}
exports.CliError = CliError;
class AskFailure extends CliError {
    code;
    stage;
    provider;
    providerDisplayName;
    retryable;
    hint;
    detail;
    context;
    cause;
    constructor(options) {
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
exports.AskFailure = AskFailure;
