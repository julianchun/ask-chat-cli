"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CliError = void 0;
class CliError extends Error {
    exitCode;
    constructor(message, exitCode = 1) {
        super(message);
        this.name = "CliError";
        this.exitCode = exitCode;
    }
}
exports.CliError = CliError;
