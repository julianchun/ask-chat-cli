#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProgram = createProgram;
const commander_1 = require("commander");
const app_1 = require("./app");
const args_1 = require("./args");
const config_1 = require("./config");
const errors_1 = require("./errors");
const io_1 = require("./io");
const providers_1 = require("./providers");
const VERSION = "0.1.0";
const STATUS_TIMEOUT_MS = 3_000;
function createProgram(services = {}) {
    const runner = services.runner || new app_1.AskApp({ env: services.env });
    const env = services.env || process.env;
    const stdout = services.stdout || process.stdout;
    const stderr = services.stderr || process.stderr;
    const setExitCode = services.setExitCode || ((code) => {
        process.exitCode = code;
    });
    const program = new commander_1.Command();
    program
        .name("ask")
        .description("Personal CLI for driving signed-in ChatGPT or Gemini sessions in Chrome.")
        .version(VERSION)
        .helpOption("-h, --help", "display help for command")
        .showHelpAfterError()
        .exitOverride()
        .configureOutput({
        writeOut: (str) => stdout.write(str),
        writeErr: (str) => stderr.write(str)
    });
    addCommonOptions(program, { includeAttachments: true });
    program.option("--new", "start a new conversation (now the default)");
    program.addOption(new commander_1.Option("--continue", "continue the previous provider conversation; starts a new one if unavailable")
        .conflicts("new"));
    program
        .argument("[prompt...]", "prompt text; reads stdin when omitted")
        .action(async (promptParts, options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            const stdin = await (0, io_1.readStdin)(services.stdin);
            const prompt = (0, args_1.combinePromptAndStdin)(promptParts.join(" "), stdin);
            const attachments = resolveAttachments(options, program);
            if (!prompt && attachments.length === 0) {
                throw new errors_1.CliError("Provide a prompt, pipe text through stdin, or attach a file.\n" +
                    "Examples: ask \"Explain this code\" | git diff | ask \"Review this diff\"\n" +
                    "Run `ask --help` for all commands.");
            }
            const provider = resolveCliProvider(options, program, env);
            const newSession = resolveNewSession(options, program);
            const providerDisplayName = (0, providers_1.getProvider)(provider).displayName;
            const stopWaitingProgress = startWaitingSpinner(stderr, providerDisplayName, newSession, env);
            let continuationUnavailable = false;
            let elapsedMs = 0;
            let result;
            try {
                result = await runner.ask({
                    provider,
                    prompt,
                    attachments,
                    headless: options.headless,
                    newSession,
                    ...(newSession ? {} : {
                        onContinuationUnavailable: () => {
                            continuationUnavailable = true;
                            if (!isInteractive(stderr)) {
                                stderr.write(`No previous ${providerDisplayName} conversation is available. Starting a new conversation.\n`);
                            }
                        }
                    }),
                    timeoutMs: options.timeout,
                    verbose: resolveVerbose(options, program)
                });
            }
            finally {
                elapsedMs = stopWaitingProgress();
            }
            writeResponseMetadata(stderr, {
                providerDisplayName,
                conversationLabel: newSession || continuationUnavailable ? "new conversation" : "continued",
                conversationUrl: result.conversationUrl,
                elapsedMs,
                timedOut: result.timedOut
            });
            if (result.text) {
                const outputPath = await (0, io_1.writeTextOutput)(result.text, { output: resolveOutput(options, program), stdout });
                if (outputPath) {
                    stderr.write(`Saved response to ${outputPath}\n`);
                }
            }
            if (result.timedOut) {
                stderr.write(`Timed out waiting for ${(0, providers_1.getProvider)(provider).displayName}; returned the latest partial response.\n`);
                setExitCode(2);
            }
        });
    });
    program
        .command("login")
        .description("Launch Chrome with the dedicated ask profile so you can log in manually.")
        .addOption(providerOption())
        .option("--timeout <ms>", "timeout in milliseconds", args_1.parseTimeout, config_1.DEFAULT_TIMEOUT_MS)
        .option("-v, --verbose", "print browser/session details")
        .action(async (options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            writeProgress(stderr, `Opening ${(0, providers_1.getProvider)(resolveCliProvider(options, program, env)).displayName} for login…`);
            await runner.login({
                provider: resolveCliProvider(options, program, env),
                headless: options.headless,
                timeoutMs: options.timeout,
                verbose: resolveVerbose(options, program)
            });
            writeProgress(stderr, "Login page ready. Complete sign-in in the dedicated Chrome window, then run `ask status`.");
        });
    });
    const open = program
        .command("open [first] [rest...]")
        .description("Open a provider page, fill a prompt, and optionally send it after signed-in auth is confirmed.")
        .option("--send", "submit the prompt after signed-in auth is confirmed and exit without waiting for the answer")
        .option("--new", "start a new conversation (now the default)")
        .addOption(new commander_1.Option("--continue", "continue the previous provider conversation; starts a new one if unavailable")
        .conflicts("new"));
    addCommonOptions(open, { includeOutput: false, includeAttachments: true, includeHeadless: false });
    open.action(async (first, rest, options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            const provider = resolveCliProvider(options, program, env);
            const target = (0, args_1.resolveOpenTarget)(first, rest, provider);
            const newSession = resolveNewSession(options, program);
            writeProgress(stderr, `Opening ${(0, providers_1.getProvider)(provider).displayName} ${newSession ? "in a new conversation" : "in the previous conversation"}${options.send ? " and sending the prompt" : ""}…`);
            await runner.open({
                provider,
                url: target.url,
                prompt: target.prompt,
                attachments: resolveAttachments(options, program),
                headless: options.headless,
                newSession,
                ...(newSession ? {} : {
                    onContinuationUnavailable: () => {
                        stderr.write(`No previous ${(0, providers_1.getProvider)(provider).displayName} conversation is available. Starting a new conversation.\n`);
                    }
                }),
                timeoutMs: options.timeout,
                verbose: resolveVerbose(options, program),
                send: Boolean(options.send)
            });
            writeProgress(stderr, options.send ? "Prompt sent; the response will remain in Chrome." : "Provider page ready in Chrome.");
        });
    });
    const get = program.command("get").description("Print the latest assistant response from the current provider page.");
    addCommonOptions(get, { includeAttachments: false });
    get.action(async (options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            const text = await runner.get({
                provider: resolveCliProvider(options, program, env),
                headless: options.headless,
                timeoutMs: options.timeout,
                verbose: resolveVerbose(options, program)
            });
            if (!text.trim()) {
                throw new errors_1.CliError("No assistant response was found on the current provider page. " +
                    "Open the conversation containing the response, then run `ask get` again.");
            }
            const outputPath = await (0, io_1.writeTextOutput)(text, { output: resolveOutput(options, program), stdout });
            if (outputPath) {
                stderr.write(`Saved response to ${outputPath}\n`);
            }
        });
    });
    const dump = program.command("dump").description("Dump the current provider page HTML.");
    addCommonOptions(dump, { includeAttachments: false });
    dump.action(async (options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            const html = await runner.dump({
                provider: resolveCliProvider(options, program, env),
                headless: options.headless,
                timeoutMs: options.timeout,
                verbose: resolveVerbose(options, program)
            });
            const outputPath = await (0, io_1.writeTextOutput)(html, { output: resolveOutput(options, program), stdout });
            if (outputPath) {
                stderr.write(`Saved page HTML to ${outputPath}\n`);
            }
        });
    });
    const screenshot = program.command("screenshot").description("Save a screenshot of the current provider page.");
    addCommonOptions(screenshot, { includeAttachments: false });
    screenshot.action(async (options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            const output = resolveOutput(options, program);
            const filePath = await runner.screenshot(output, {
                provider: resolveCliProvider(options, program, env),
                headless: options.headless,
                timeoutMs: options.timeout,
                verbose: resolveVerbose(options, program)
            });
            if (!output) {
                stdout.write(`${filePath}\n`);
            }
            else {
                stderr.write(`Saved screenshot to ${filePath}\n`);
            }
        });
    });
    const status = program.command("status").description("Show provider readiness; use --verbose for Chrome/session details.");
    status
        .addOption(providerOption())
        .option("--timeout <ms>", "prompt input detection timeout in milliseconds", args_1.parseTimeout, STATUS_TIMEOUT_MS)
        .option("-v, --verbose", "print browser/session details")
        .action(async (options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            const result = await runner.status({
                provider: resolveCliProvider(options, program, env),
                timeoutMs: resolveStatusTimeout(options, program),
                verbose: resolveVerbose(options, program)
            });
            stdout.write(formatStatus(result, Boolean(resolveVerbose(options, program))));
        });
    });
    return program;
}
function addCommonOptions(command, options = {}) {
    const includeOutput = options.includeOutput !== false;
    const includeAttachments = options.includeAttachments !== false;
    if (includeOutput) {
        command.option("-o, --output <file>", "write output to a file");
    }
    if (includeAttachments) {
        command.option("-a, --attach <file>", "attach a local file", collect, []);
    }
    command.addOption(providerOption());
    if (options.includeHeadless !== false) {
        command.addOption(new commander_1.Option("--headless", "require the ask-managed Chrome process to run headlessly").hideHelp(false));
    }
    command.option("--timeout <ms>", "timeout in milliseconds", args_1.parseTimeout, config_1.DEFAULT_TIMEOUT_MS);
    command.option("-v, --verbose", "print browser/session details");
}
function providerOption() {
    return new commander_1.Option("--provider <provider>", "web chat provider: chatgpt or gemini").argParser(parseProviderOption);
}
function parseProviderOption(value) {
    return (0, providers_1.parseProviderName)(value);
}
function resolveCliProvider(options, program, env) {
    return (0, providers_1.resolveProviderName)(options.provider ?? program.opts().provider, env);
}
function resolveVerbose(options, program) {
    return options.verbose ?? program.opts().verbose;
}
function resolveOutput(options, program) {
    return options.output ?? program.opts().output;
}
function resolveStatusTimeout(options, program) {
    if (options.timeout !== STATUS_TIMEOUT_MS) {
        return options.timeout;
    }
    const globalTimeout = program.opts().timeout;
    return typeof globalTimeout === "number" && globalTimeout !== config_1.DEFAULT_TIMEOUT_MS ? globalTimeout : options.timeout;
}
function resolveNewSession(options, program) {
    const continuePrevious = options.continue ?? program.opts().continue;
    return !continuePrevious;
}
function collect(value, previous) {
    previous.push(value);
    return previous;
}
function resolveAttachments(options, program) {
    if (options.attach && options.attach.length > 0) {
        return options.attach;
    }
    return program.opts().attach || [];
}
function writeProgress(stderr, message) {
    if (stderr.isTTY) {
        stderr.write(`${message}\n`);
    }
}
function startWaitingSpinner(stderr, providerDisplayName, newSession, env) {
    const startedAt = Date.now();
    if (!isInteractive(stderr)) {
        return () => Date.now() - startedAt;
    }
    if (env.CI || env.TERM === "dumb") {
        stderr.write(`${providerDisplayName} · ${newSession ? "starting new conversation" : "continuing"}…\n`);
        return () => Date.now() - startedAt;
    }
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frameIndex = 0;
    const render = () => {
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        stderr.write(`\r\x1b[2K${frames[frameIndex]} ${providerDisplayName} · ${newSession ? "starting new conversation" : "continuing"} · ${elapsedSeconds}s`);
        frameIndex = (frameIndex + 1) % frames.length;
    };
    render();
    const timer = setInterval(() => {
        render();
    }, 80);
    timer.unref();
    return () => {
        clearInterval(timer);
        stderr.write("\r\x1b[2K");
        return Date.now() - startedAt;
    };
}
function writeResponseMetadata(stderr, details) {
    if (!isInteractive(stderr)) {
        return;
    }
    const icon = details.timedOut ? "⚠" : "✓";
    stderr.write(`${icon} ${details.providerDisplayName} · ${details.conversationLabel} · ${formatElapsed(details.elapsedMs)}\n`);
    if (details.conversationUrl) {
        stderr.write(`↗ ${details.conversationUrl}\n`);
    }
    stderr.write("\n");
}
function formatElapsed(elapsedMs) {
    if (elapsedMs < 10_000) {
        return `${(elapsedMs / 1_000).toFixed(1)}s`;
    }
    return `${Math.round(elapsedMs / 1_000)}s`;
}
function isInteractive(stderr) {
    return Boolean(stderr.isTTY);
}
function statusSummary(status) {
    if (!status.connected || status.sessionOwnership === "absent") {
        return "not running";
    }
    if (status.sessionOwnership !== "ask-managed") {
        return "session conflict";
    }
    if (status.authState === "signed-in-likely" && status.readyToSend) {
        return "ready";
    }
    if (status.authState === "guest" || status.authState === "login-required") {
        return "login required";
    }
    if (status.authState === "blocked") {
        return "blocked";
    }
    return "not ready";
}
function formatStatus(status, verbose = false) {
    const lines = [
        `Status: ${statusSummary(status)}`,
        `Provider: ${status.providerDisplayName} (${status.provider})`,
        `Note: ${status.note}`
    ];
    if (!verbose) {
        return `${lines.join("\n")}\n`;
    }
    lines.push(`Session: ${status.sessionOwnership}`, `Chrome debugging: ${status.connected ? "connected" : "not running"} on port ${status.port}`, `Chrome mode: ${status.connected ? (status.headless ? "headless" : "visible") : "n/a"}`, `Pages: ${status.pageCount} total, ${status.providerPageCount} ${status.providerDisplayName}`, `Current ${status.providerDisplayName} page: ${status.currentPageUrl || "none"}`, `Prompt input: ${status.promptInputVisible ? "found" : "not found"}`, `Auth: ${status.authState}`, `Ready to send: ${status.readyToSend ? "yes" : "no"}`, `Ready for headless: ${status.readyForHeadless ? "yes" : "no"}`);
    return `${lines.join("\n")}\n`;
}
async function runWithErrors(stderr, setExitCode, fn) {
    try {
        await fn();
    }
    catch (error) {
        if (error instanceof errors_1.CliError) {
            stderr.write(`${error.message}\n`);
            setExitCode(error.exitCode);
            return;
        }
        if (error && typeof error === "object" && "code" in error && String(error.code).startsWith("commander.")) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        stderr.write(`${message}\n`);
        setExitCode(1);
    }
}
if (require.main === module) {
    createProgram().parseAsync(process.argv).catch((error) => {
        if (error && typeof error === "object" && "code" in error && String(error.code).startsWith("commander.")) {
            process.exitCode = typeof error.exitCode === "number" ? error.exitCode : 1;
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}
