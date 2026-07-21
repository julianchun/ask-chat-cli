#!/usr/bin/env node
import { Command, Option } from "commander";
import { AskApp, type BrowserStatus } from "./app";
import { combinePromptAndStdin, parseTimeout, resolveOpenTarget } from "./args";
import { DEFAULT_TIMEOUT_MS } from "./config";
import { normalizeConversationName, type NamedConversation } from "./conversations";
import { MAX_QUEUED_EXECUTIONS, type ExecutionQueueUpdate } from "./execution-queue";
import { CliError } from "./errors";
import { readStdin, writeTextOutput, type WritableLike } from "./io";
import { getProvider, parseProviderName, resolveProviderName, type ProviderName } from "./providers";

export interface Runner {
  login(options: { provider?: ProviderName; headless?: boolean; timeoutMs: number; verbose?: boolean }): Promise<void> | void;
  open(options: {
    provider?: ProviderName;
    url: string;
    prompt: string;
    attachments: string[];
    headless?: boolean;
    newSession?: boolean;
    conversationName?: string;
    onContinuationUnavailable?: () => void;
    onQueueUpdate?: (update: ExecutionQueueUpdate) => void;
    timeoutMs: number;
    verbose?: boolean;
    send: boolean;
  }): Promise<void>;
  ask(options: {
    provider?: ProviderName;
    prompt: string;
    attachments: string[];
    headless?: boolean;
    newSession?: boolean;
    conversationName?: string;
    onContinuationUnavailable?: () => void;
    onQueueUpdate?: (update: ExecutionQueueUpdate) => void;
    timeoutMs: number;
    verbose?: boolean;
  }): Promise<{ text: string; timedOut: boolean; conversationUrl?: string }>;
  get(options: { provider?: ProviderName; headless?: boolean; timeoutMs: number; verbose?: boolean }): Promise<string>;
  dump(options: { provider?: ProviderName; headless?: boolean; timeoutMs: number; verbose?: boolean }): Promise<string>;
  screenshot(output: string | undefined, options: { provider?: ProviderName; headless?: boolean; timeoutMs: number; verbose?: boolean }): Promise<string>;
  status(options: { provider?: ProviderName; timeoutMs: number; verbose?: boolean }): Promise<BrowserStatus>;
  listConversations(provider?: ProviderName): Promise<NamedConversation[]>;
  forgetConversation(name: string, provider?: ProviderName): Promise<boolean>;
}

export interface CliServices {
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: WritableLike;
  stderr?: WritableLike;
  setExitCode?: (code: number) => void;
}

interface CommonOptions {
  output?: string;
  attach?: string[];
  provider?: ProviderName;
  headless?: boolean;
  new?: boolean;
  continue?: boolean;
  conversation?: string;
  timeout: number;
  verbose?: boolean;
}

interface OpenCommandOptions extends CommonOptions {
  send?: boolean;
}

const VERSION = "0.1.0";
const STATUS_TIMEOUT_MS = 3_000;

export function createProgram(services: CliServices = {}): Command {
  const runner = services.runner || new AskApp({ env: services.env });
  const env = services.env || process.env;
  const stdout = services.stdout || process.stdout;
  const stderr = services.stderr || process.stderr;
  const setExitCode = services.setExitCode || ((code: number) => {
    process.exitCode = code;
  });

  const program = new Command();
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
  program.addOption(
    new Option("--continue", "continue the previous provider conversation; starts a new one if unavailable")
      .conflicts("new")
  );
  program.addOption(conversationOption());

  program
    .argument("[prompt...]", "prompt text; reads stdin when omitted")
    .action(async (promptParts: string[], options: CommonOptions) => {
      await runWithErrors(stderr, setExitCode, async () => {
        const stdin = await readStdin(services.stdin);
        const prompt = combinePromptAndStdin(promptParts.join(" "), stdin);
        const attachments = resolveAttachments(options, program);
        if (!prompt && attachments.length === 0) {
          throw new CliError(
            "Provide a prompt, pipe text through stdin, or attach a file.\n" +
              "Examples: ask \"Explain this code\" | git diff | ask \"Review this diff\"\n" +
              "Run `ask --help` for all commands."
          );
        }

        const provider = resolveCliProvider(options, program, env);
        const newSession = resolveNewSession(options, program);
        const conversationName = resolveConversationName(options, program);
        const providerDisplayName = getProvider(provider).displayName;
        const queueProgress = createQueueProgress(stderr, providerDisplayName);
        const stopWaitingProgress = startWaitingSpinner(
          stderr,
          providerDisplayName,
          newSession,
          env,
          () => queueProgress.current
        );
        let continuationUnavailable = false;
        let elapsedMs = 0;
        let result: { text: string; timedOut: boolean; conversationUrl?: string };
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
                  stderr.write(
                    `No previous ${providerDisplayName} conversation is available. Starting a new conversation.\n`
                  );
                }
              }
            }),
            onQueueUpdate: queueProgress.update,
            timeoutMs: options.timeout,
            verbose: resolveVerbose(options, program)
          });
        } finally {
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
          const outputPath = await writeTextOutput(result.text, { output: resolveOutput(options, program), stdout });
          if (outputPath) {
            stderr.write(`Saved response to ${outputPath}\n`);
          }
        }

        if (result.timedOut) {
          stderr.write(`Timed out waiting for ${getProvider(provider).displayName}; returned the latest partial response.\n`);
          setExitCode(2);
        }
      });
    });

  program
    .command("login")
    .description("Launch Chrome with the dedicated ask profile so you can log in manually.")
    .addOption(providerOption())
    .option("--timeout <ms>", "timeout in milliseconds", parseTimeout, DEFAULT_TIMEOUT_MS)
    .option("-v, --verbose", "print browser/session details")
    .action(async (options: CommonOptions) => {
      await runWithErrors(stderr, setExitCode, async () => {
        writeProgress(stderr, `Opening ${getProvider(resolveCliProvider(options, program, env)).displayName} for login…`);
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
    .addOption(
      new Option("--continue", "continue the previous provider conversation; starts a new one if unavailable")
        .conflicts("new")
    )
    .addOption(conversationOption());
  addCommonOptions(open, { includeOutput: false, includeAttachments: true, includeHeadless: false });
  open.action(async (first: string | undefined, rest: string[], options: OpenCommandOptions) => {
    await runWithErrors(stderr, setExitCode, async () => {
      const provider = resolveCliProvider(options, program, env);
      const target = resolveOpenTarget(first, rest, provider);
      const newSession = resolveNewSession(options, program);
      const conversationName = resolveConversationName(options, program);
      const queueProgress = createQueueProgress(stderr, getProvider(provider).displayName);
      writeProgress(
        stderr,
        `Opening ${getProvider(provider).displayName} ${newSession ? "in a new conversation" : "in the previous conversation"}${options.send ? " and sending the prompt" : ""}…`
      );
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
            stderr.write(
              `No previous ${getProvider(provider).displayName} conversation is available. Starting a new conversation.\n`
            );
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
  get.action(async (options: CommonOptions) => {
    await runWithErrors(stderr, setExitCode, async () => {
      const text = await runner.get({
        provider: resolveCliProvider(options, program, env),
        headless: options.headless,
        timeoutMs: options.timeout,
        verbose: resolveVerbose(options, program)
      });
      if (!text.trim()) {
        throw new CliError(
          "No assistant response was found on the current provider page. " +
            "Open the conversation containing the response, then run `ask get` again."
        );
      }
      const outputPath = await writeTextOutput(text, { output: resolveOutput(options, program), stdout });
      if (outputPath) {
        stderr.write(`Saved response to ${outputPath}\n`);
      }
    });
  });

  const dump = program.command("dump").description("Dump the current provider page HTML.");
  addCommonOptions(dump, { includeAttachments: false });
  dump.action(async (options: CommonOptions) => {
    await runWithErrors(stderr, setExitCode, async () => {
      const html = await runner.dump({
        provider: resolveCliProvider(options, program, env),
        headless: options.headless,
        timeoutMs: options.timeout,
        verbose: resolveVerbose(options, program)
      });
      const outputPath = await writeTextOutput(html, { output: resolveOutput(options, program), stdout });
      if (outputPath) {
        stderr.write(`Saved page HTML to ${outputPath}\n`);
      }
    });
  });

  const screenshot = program.command("screenshot").description("Save a screenshot of the current provider page.");
  addCommonOptions(screenshot, { includeAttachments: false });
  screenshot.action(async (options: CommonOptions) => {
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
      } else {
        stderr.write(`Saved screenshot to ${filePath}\n`);
      }
    });
  });

  const status = program.command("status").description("Show provider readiness; use --verbose for Chrome/session details.");
  status
    .addOption(providerOption())
    .option("--timeout <ms>", "prompt input detection timeout in milliseconds", parseTimeout, STATUS_TIMEOUT_MS)
    .option("-v, --verbose", "print browser/session details")
    .action(async (options: CommonOptions) => {
      await runWithErrors(stderr, setExitCode, async () => {
        const result = await runner.status({
          provider: resolveCliProvider(options, program, env),
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
    .action(async (options: { provider?: ProviderName; json?: boolean }) => {
      await runWithErrors(stderr, setExitCode, async () => {
        const provider = options.provider ?? (program.opts() as Partial<CommonOptions>).provider;
        const entries = await runner.listConversations(provider);
        stdout.write(options.json ? formatConversationsJson(entries) : formatConversations(entries));
      });
    });

  conversations
    .command("forget <name>")
    .description("Forget a local name without deleting the provider chat.")
    .addOption(providerOption())
    .action(async (name: string, options: { provider?: ProviderName }) => {
      await runWithErrors(stderr, setExitCode, async () => {
        const provider = resolveCliProvider(options, program, env);
        const normalizedName = normalizeConversationName(name);
        const removed = await runner.forgetConversation(normalizedName, provider);
        if (!removed) {
          throw new CliError(`No named ${getProvider(provider).displayName} conversation \"${normalizedName}\" was found.`);
        }
        stderr.write(`Forgot local ${getProvider(provider).displayName} conversation \"${normalizedName}\". The provider chat was not deleted.\n`);
      });
    });

  return program;
}

function addCommonOptions(
  command: Command,
  options: { includeOutput?: boolean; includeAttachments?: boolean; includeHeadless?: boolean } = {}
): void {
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
    command.addOption(new Option("--headless", "require the ask-managed Chrome process to run headlessly").hideHelp(false));
  }
  command.option("--timeout <ms>", "timeout in milliseconds", parseTimeout, DEFAULT_TIMEOUT_MS);
  command.option("-v, --verbose", "print browser/session details");
}

function providerOption(): Option {
  return new Option("--provider <provider>", "web chat provider: chatgpt or gemini").argParser(parseProviderOption);
}

function conversationOption(): Option {
  return new Option("--conversation <name>", "resume a named conversation, or create it if missing")
    .conflicts("continue")
    .argParser(normalizeConversationName);
}

function parseProviderOption(value: string): ProviderName {
  return parseProviderName(value);
}

function resolveCliProvider(options: Pick<CommonOptions, "provider">, program: Command, env: NodeJS.ProcessEnv): ProviderName {
  return resolveProviderName(options.provider ?? (program.opts() as Partial<CommonOptions>).provider, env);
}

function resolveVerbose(options: CommonOptions, program: Command): boolean | undefined {
  return options.verbose ?? (program.opts() as Partial<CommonOptions>).verbose;
}

function resolveOutput(options: CommonOptions, program: Command): string | undefined {
  return options.output ?? (program.opts() as Partial<CommonOptions>).output;
}

function resolveStatusTimeout(options: CommonOptions, program: Command): number {
  if (options.timeout !== STATUS_TIMEOUT_MS) {
    return options.timeout;
  }

  const globalTimeout = (program.opts() as Partial<CommonOptions>).timeout;
  return typeof globalTimeout === "number" && globalTimeout !== DEFAULT_TIMEOUT_MS ? globalTimeout : options.timeout;
}

function resolveNewSession(options: CommonOptions, program: Command): boolean {
  const conversationName = resolveConversationName(options, program);
  const continuePrevious = options.continue ?? (program.opts() as Partial<CommonOptions>).continue;
  if (conversationName && continuePrevious) {
    throw new Error("--conversation cannot be used with --continue");
  }
  if (conversationName) {
    return Boolean(options.new ?? (program.opts() as Partial<CommonOptions>).new);
  }
  return !continuePrevious;
}

function resolveConversationName(options: CommonOptions, program: Command): string | undefined {
  return options.conversation ?? (program.opts() as Partial<CommonOptions>).conversation;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function resolveAttachments(options: CommonOptions, program: Command): string[] {
  if (options.attach && options.attach.length > 0) {
    return options.attach;
  }
  return (program.opts() as Partial<CommonOptions>).attach || [];
}

function writeProgress(stderr: WritableLike, message: string): void {
  if ((stderr as WritableLike & { isTTY?: boolean }).isTTY) {
    stderr.write(`${message}\n`);
  }
}

function startWaitingSpinner(
  stderr: WritableLike,
  providerDisplayName: string,
  newSession: boolean,
  env: NodeJS.ProcessEnv,
  getQueueUpdate: () => ExecutionQueueUpdate | undefined
): () => number {
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
      ? `queued ${queue.position}/${MAX_QUEUED_EXECUTIONS}`
      : newSession ? "starting new conversation" : "continuing";
    stderr.write(
      `\r\x1b[2K${frames[frameIndex]} ${providerDisplayName} · ${activity} · ${elapsedSeconds}s`
    );
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

function createQueueProgress(stderr: WritableLike, providerDisplayName: string): {
  current?: ExecutionQueueUpdate;
  update(update: ExecutionQueueUpdate): void;
} {
  const progress: {
    current?: ExecutionQueueUpdate;
    update(update: ExecutionQueueUpdate): void;
  } = {
    update(update) {
      const previous = progress.current;
      progress.current = update;
      if (isInteractive(stderr)) {
        return;
      }
      if (update.phase === "queued" && previous?.phase !== "queued") {
        stderr.write(
          `${providerDisplayName} · queued ${update.position}/${MAX_QUEUED_EXECUTIONS} · waiting for an execution slot\n`
        );
      } else if (update.phase === "active" && previous?.phase === "queued") {
        stderr.write(`${providerDisplayName} · execution slot acquired · starting…\n`);
      }
    }
  };
  return progress;
}

function writeResponseMetadata(
  stderr: WritableLike,
  details: {
    providerDisplayName: string;
    conversationLabel: "new conversation" | "continued";
    conversationUrl?: string;
    elapsedMs: number;
    timedOut: boolean;
  }
): void {
  if (!isInteractive(stderr)) {
    return;
  }

  const icon = details.timedOut ? "⚠" : "✓";
  stderr.write(
    `${icon} ${details.providerDisplayName} · ${details.conversationLabel} · ${formatElapsed(details.elapsedMs)}\n`
  );
  if (details.conversationUrl) {
    stderr.write(`↗ ${details.conversationUrl}\n`);
  }
  stderr.write("\n");
}

function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 10_000) {
    return `${(elapsedMs / 1_000).toFixed(1)}s`;
  }
  return `${Math.round(elapsedMs / 1_000)}s`;
}

function isInteractive(stderr: WritableLike): boolean {
  return Boolean((stderr as WritableLike & { isTTY?: boolean }).isTTY);
}

function statusSummary(status: BrowserStatus): string {
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

function formatStatus(status: BrowserStatus, verbose = false): string {
  const lines = [
    `Status: ${statusSummary(status)}`,
    `Provider: ${status.providerDisplayName} (${status.provider})`,
    `Note: ${status.note}`
  ];

  if (!verbose) {
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `Session: ${status.sessionOwnership}`,
    `Chrome debugging: ${status.connected ? "connected" : "not running"} on port ${status.port}`,
    `Chrome mode: ${status.connected ? (status.headless ? "headless" : "visible") : "n/a"}`,
    `Pages: ${status.pageCount} total, ${status.providerPageCount} ${status.providerDisplayName}`,
    `Current ${status.providerDisplayName} page: ${status.currentPageUrl || "none"}`,
    `Prompt input: ${status.promptInputVisible ? "found" : "not found"}`,
    `Auth: ${status.authState}`,
    `Ready to send: ${status.readyToSend ? "yes" : "no"}`,
    `Ready for headless: ${status.readyForHeadless ? "yes" : "no"}`
  );

  return `${lines.join("\n")}\n`;
}

function formatConversations(entries: NamedConversation[]): string {
  if (entries.length === 0) {
    return "No named conversations.\n";
  }

  const lines = ["PROVIDER\tNAME\tUPDATED\tURL"];
  for (const entry of entries) {
    lines.push(`${entry.provider}\t${entry.name}\t${entry.updatedAt}\t${entry.url}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatConversationsJson(entries: NamedConversation[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

async function runWithErrors(
  stderr: WritableLike,
  setExitCode: (code: number) => void,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof CliError) {
      stderr.write(`${error.message}\n`);
      setExitCode(error.exitCode);
      return;
    }

    if (error && typeof error === "object" && "code" in error && String((error as { code: unknown }).code).startsWith("commander.")) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    setExitCode(1);
  }
}

if (require.main === module) {
  createProgram().parseAsync(process.argv).catch((error) => {
    if (error && typeof error === "object" && "code" in error && String((error as { code: unknown }).code).startsWith("commander.")) {
      process.exitCode = typeof (error as { exitCode?: unknown }).exitCode === "number" ? (error as { exitCode: number }).exitCode : 1;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}



