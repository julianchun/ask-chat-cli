#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProgram = createProgram;
const commander_1 = require("commander");
const app_1 = require("./app");
const args_1 = require("./args");
const config_1 = require("./config");
const conversations_1 = require("./conversations");
const execution_queue_1 = require("./execution-queue");
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
    program.addOption(conversationOption());
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
            const conversationName = resolveConversationName(options, program);
            const providerDisplayName = (0, providers_1.getProvider)(provider).displayName;
            const queueProgress = createQueueProgress(stderr, providerDisplayName);
            const stopWaitingProgress = startWaitingSpinner(stderr, providerDisplayName, newSession, env, () => queueProgress.current);
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
                    ...(conversationName ? { conversationName } : {}),
                    ...(newSession ? {} : {
                        onContinuationUnavailable: () => {
                            continuationUnavailable = true;
                            if (!isInteractive(stderr)) {
                                stderr.write(`No previous ${providerDisplayName} conversation is available. Starting a new conversation.\n`);
                            }
                        }
                    }),
                    onQueueUpdate: queueProgress.update,
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
                const failure = result.failure || new errors_1.AskFailure({
                    code: result.text ? "RESPONSE_TIMEOUT" : "RESPONSE_NOT_DETECTED",
                    stage: "response.wait",
                    provider,
                    providerDisplayName,
                    message: result.text
                        ? `Timed out waiting for ${providerDisplayName}; returned the latest partial response.`
                        : `Timed out without detecting a ${providerDisplayName} response.`,
                    retryable: true,
                    hint: `Retry with a larger \`--timeout\`, or run \`ask status --provider ${provider} --verbose\`.`,
                    exitCode: 2
                });
                stderr.write(formatAskFailure(failure));
                setExitCode(failure.exitCode);
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
        .option("--send", "submit the prompt and wait for completion after signed-in auth is confirmed")
        .option("--new", "start a new conversation (now the default)")
        .addOption(new commander_1.Option("--continue", "continue the previous provider conversation; starts a new one if unavailable")
        .conflicts("new"))
        .addOption(conversationOption());
    addCommonOptions(open, { includeOutput: false, includeAttachments: true, includeHeadless: false });
    open.action(async (first, rest, options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            const provider = resolveCliProvider(options, program, env);
            const target = (0, args_1.resolveOpenTarget)(first, rest, provider);
            const newSession = resolveNewSession(options, program);
            const conversationName = resolveConversationName(options, program);
            const queueProgress = createQueueProgress(stderr, (0, providers_1.getProvider)(provider).displayName);
            writeProgress(stderr, `Opening ${(0, providers_1.getProvider)(provider).displayName} ${newSession ? "in a new conversation" : "in the previous conversation"}${options.send ? " and sending the prompt" : ""}…`);
            await runner.open({
                provider,
                url: target.url,
                prompt: target.prompt,
                attachments: resolveAttachments(options, program),
                headless: options.headless,
                newSession,
                ...(conversationName ? { conversationName } : {}),
                ...(newSession ? {} : {
                    onContinuationUnavailable: () => {
                        stderr.write(`No previous ${(0, providers_1.getProvider)(provider).displayName} conversation is available. Starting a new conversation.\n`);
                    }
                }),
                onQueueUpdate: queueProgress.update,
                timeoutMs: options.timeout,
                verbose: resolveVerbose(options, program),
                send: Boolean(options.send)
            });
            writeProgress(stderr, options.send ? "Prompt completed." : "Provider page ready in Chrome.");
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
    const status = program.command("status").description("Show Chrome and provider readiness; use --verbose for technical details.");
    status
        .addOption(providerOption())
        .option("--timeout <ms>", "message-box detection timeout in milliseconds", args_1.parseTimeout, STATUS_TIMEOUT_MS)
        .option("-v, --verbose", "print browser/session details")
        .action(async (options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            const provider = options.provider ?? program.opts().provider;
            const result = await runner.status({
                ...(provider ? { provider } : {}),
                timeoutMs: resolveStatusTimeout(options, program),
                verbose: resolveVerbose(options, program)
            });
            stdout.write(formatStatus(result, Boolean(resolveVerbose(options, program))));
        });
    });
    const conversations = program
        .command("conversations")
        .description("List or forget locally named provider conversations.");
    conversations
        .command("list")
        .description("List named conversations.")
        .addOption(providerOption())
        .option("--json", "print machine-readable JSON")
        .action(async (options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            const provider = options.provider ?? program.opts().provider;
            const entries = await runner.listConversations(provider);
            stdout.write(options.json ? formatConversationsJson(entries) : formatConversations(entries));
        });
    });
    conversations
        .command("forget <name>")
        .description("Forget a local name without deleting the provider chat.")
        .addOption(providerOption())
        .action(async (name, options) => {
        await runWithErrors(stderr, setExitCode, async () => {
            const provider = resolveCliProvider(options, program, env);
            const normalizedName = (0, conversations_1.normalizeConversationName)(name);
            const removed = await runner.forgetConversation(normalizedName, provider);
            if (!removed) {
                throw new errors_1.CliError(`No named ${(0, providers_1.getProvider)(provider).displayName} conversation \"${normalizedName}\" was found.`);
            }
            stderr.write(`Forgot local ${(0, providers_1.getProvider)(provider).displayName} conversation \"${normalizedName}\". The provider chat was not deleted.\n`);
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
function conversationOption() {
    return new commander_1.Option("--conversation <name>", "resume a named conversation, or create it if missing")
        .conflicts("continue")
        .argParser(conversations_1.normalizeConversationName);
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
    const conversationName = resolveConversationName(options, program);
    const continuePrevious = options.continue ?? program.opts().continue;
    if (conversationName && continuePrevious) {
        throw new Error("--conversation cannot be used with --continue");
    }
    if (conversationName) {
        return Boolean(options.new ?? program.opts().new);
    }
    return !continuePrevious;
}
function resolveConversationName(options, program) {
    return options.conversation ?? program.opts().conversation;
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
function startWaitingSpinner(stderr, providerDisplayName, newSession, env, getQueueUpdate) {
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
        const queue = getQueueUpdate();
        const activity = queue?.phase === "queued"
            ? `queued ${queue.position}/${execution_queue_1.MAX_QUEUED_EXECUTIONS}`
            : newSession ? "starting new conversation" : "continuing";
        stderr.write(`\r\x1b[2K${frames[frameIndex]} ${providerDisplayName} · ${activity} · ${elapsedSeconds}s`);
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
function createQueueProgress(stderr, providerDisplayName) {
    const progress = {
        update(update) {
            const previous = progress.current;
            progress.current = update;
            if (isInteractive(stderr)) {
                return;
            }
            if (update.phase === "queued" && previous?.phase !== "queued") {
                stderr.write(`${providerDisplayName} · queued ${update.position}/${execution_queue_1.MAX_QUEUED_EXECUTIONS} · waiting for an execution slot\n`);
            }
            else if (update.phase === "active" && previous?.phase === "queued") {
                stderr.write(`${providerDisplayName} · execution slot acquired · starting…\n`);
            }
        }
    };
    return progress;
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
function formatStatus(report, verbose = false) {
    const lines = [
        formatChromeStatus(report),
        "",
        formatStatusTable(report)
    ];
    if (verbose) {
        lines.push("", ...formatVerboseStatus(report));
    }
    return `${lines.join("\n")}\n`;
}
function formatChromeStatus(report) {
    const session = report.session;
    if (!session.connected || session.sessionOwnership === "absent") {
        return `Chrome: not running · port ${session.port}`;
    }
    if (session.sessionOwnership !== "ask-managed") {
        return `Chrome: session conflict · ${session.sessionOwnership} · port ${session.port}`;
    }
    return `Chrome: running · ask-managed · ${session.headless ? "headless" : "visible"} · port ${session.port}`;
}
function formatStatusTable(report) {
    const rows = [
        ["PROVIDER", "STATUS", "AUTH", "MESSAGE BOX"],
        ...report.providers.map((provider) => [
            provider.providerDisplayName,
            provider.status.replaceAll("-", " "),
            provider.authState,
            provider.messageBox.replaceAll("-", " ")
        ])
    ];
    const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index]?.length || 0)));
    return rows
        .map((row) => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd())
        .join("\n");
}
function formatVerboseStatus(report) {
    const session = report.session;
    const lines = [
        `Session: ${session.sessionOwnership}`,
        `Chrome debugging: ${session.connected ? "connected" : "not running"} on port ${session.port}`,
        `Chrome mode: ${session.connected ? (session.headless ? "headless" : "visible") : "n/a"}`,
        `Browser: ${session.browser || "unknown"}`,
        `User agent: ${session.userAgent || "unknown"}`,
        `Pages: ${session.pageCount} total`
    ];
    for (const provider of report.providers) {
        lines.push("", `${provider.providerDisplayName} (${provider.provider}):`, `  Status: ${provider.status.replaceAll("-", " ")}`, `  Pages: ${provider.providerPageCount}`, `  Current page: ${provider.currentPageUrl || "none"}`, `  Message box: ${provider.messageBox.replaceAll("-", " ")}`, `  Auth: ${provider.authState}`, `  Ready to send: ${provider.readyToSend ? "yes" : "no"}`, `  Ready for headless: ${provider.readyForHeadless ? "yes" : "no"}`, `  Note: ${provider.note}`);
    }
    return lines;
}
function formatConversations(entries) {
    if (entries.length === 0) {
        return "No named conversations.\n";
    }
    const lines = ["PROVIDER\tNAME\tUPDATED\tURL"];
    for (const entry of entries) {
        lines.push(`${entry.provider}\t${entry.name}\t${entry.updatedAt}\t${entry.url}`);
    }
    return `${lines.join("\n")}\n`;
}
function formatConversationsJson(entries) {
    return `${JSON.stringify(entries, null, 2)}\n`;
}
function formatAskFailure(error) {
    const lines = [
        `ask: ${error.providerDisplayName} failed at ${error.stage} [${error.code}]`,
        error.message
    ];
    if (error.detail) {
        lines.push(`Detail: ${error.detail}`);
    }
    const context = [];
    if (error.context?.providerHost) {
        context.push(`host=${error.context.providerHost}`);
    }
    if (error.context?.authState) {
        context.push(`auth=${error.context.authState}`);
    }
    if (typeof error.context?.promptInputVisible === "boolean") {
        context.push(`message-box=${error.context.promptInputVisible ? "available" : "not-found"}`);
    }
    if (context.length > 0) {
        lines.push(`Context: ${context.join(" · ")}`);
    }
    lines.push(`Next: ${error.hint}`);
    return `${lines.join("\n")}\n`;
}
async function runWithErrors(stderr, setExitCode, fn) {
    try {
        await fn();
    }
    catch (error) {
        if (error instanceof errors_1.AskFailure) {
            stderr.write(formatAskFailure(error));
            setExitCode(error.exitCode);
            return;
        }
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
