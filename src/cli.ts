#!/usr/bin/env node
import { Command, Option } from "commander";
import {
  AskApp,
  type BrowserStatusReport,
  type PromptRunResult,
  type ProviderReadinessCheck,
  type ReadinessUpdate
} from "./app";
import { combinePromptAndStdin, parseTimeout, resolveOpenTarget } from "./args";
import { DEFAULT_TIMEOUT_MS } from "./config";
import { normalizeConversationName, type NamedConversation } from "./conversations";
import {
  MAX_QUEUED_EXECUTIONS,
  type ExecutionLease,
  type ExecutionQueueUpdate
} from "./execution-queue";
import { AskFailure, CliError } from "./errors";
import { readStdin, writeTextOutput, type WritableLike } from "./io";
import { getProvider, parseProviderName, resolveProviderName, type ProviderName } from "./providers";

export interface Runner {
  acquireProviderReadinessLease(provider: ProviderName, timeoutMs: number): Promise<ExecutionLease>;
  inspectProviderReadiness(provider: ProviderName, timeoutMs: number): Promise<ProviderReadinessCheck>;
  setup(options: { provider?: ProviderName; timeoutMs: number; verbose?: boolean }): Promise<void> | void;
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
    allowInteractiveAuth?: boolean;
    onReadinessUpdate?: (update: ReadinessUpdate) => void;
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
    allowInteractiveAuth?: boolean;
    onReadinessUpdate?: (update: ReadinessUpdate) => void;
    timeoutMs: number;
    verbose?: boolean;
  }): Promise<PromptRunResult>;
  get(options: { provider?: ProviderName; headless?: boolean; timeoutMs: number; verbose?: boolean }): Promise<string>;
  dump(options: { provider?: ProviderName; headless?: boolean; timeoutMs: number; verbose?: boolean }): Promise<string>;
  screenshot(output: string | undefined, options: { provider?: ProviderName; headless?: boolean; timeoutMs: number; verbose?: boolean }): Promise<string>;
  status(options: { provider?: ProviderName; timeoutMs: number; verbose?: boolean }): Promise<BrowserStatusReport>;
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
        const readinessProgress = createReadinessProgress(stderr);
        const stopWaitingProgress = startWaitingSpinner(
          stderr,
          providerDisplayName,
          newSession,
          env,
          () => queueProgress.current,
          () => readinessProgress.current
        );
        let continuationUnavailable = false;
        let elapsedMs = 0;
        let result: PromptRunResult;
        const firstAttemptStartedAt = Date.now();
        const commandTimeoutMs = resolveTimeout(options, program);
        try {
          const askOptions = {
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
            // Authentication in a remotely controlled Chrome can be rejected
            // by identity providers. A safe pre-dispatch auth failure below
            // switches to the ordinary-Chrome setup bootstrap instead.
            allowInteractiveAuth: false,
            onReadinessUpdate: readinessProgress.update,
            timeoutMs: commandTimeoutMs,
            verbose: resolveVerbose(options, program)
          };
          try {
            result = await runner.ask(askOptions);
          } catch (error) {
            if (!shouldRunSecureSetup(error, stderr, options.headless)) {
              throw error;
            }
            const commandDeadlineAt =
              (queueProgress.activeAt ?? firstAttemptStartedAt) + Math.max(0, commandTimeoutMs);
            result = await retryAfterCoalescedSecureSetup({
              runner,
              provider,
              providerDisplayName,
              deadlineAt: commandDeadlineAt,
              initialError: error,
              verbose: resolveVerbose(options, program),
              readinessProgress,
              run: (timeoutMs) => runner.ask({ ...askOptions, timeoutMs })
            });
          }
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
          const deliveryState = result.deliveryState || "confirmed";
          const failure = result.failure || new AskFailure({
            code: result.text ? "RESPONSE_TIMEOUT" : "RESPONSE_NOT_DETECTED",
            stage: "response.wait",
            provider,
            providerDisplayName,
            message: result.text
              ? `Timed out waiting for ${providerDisplayName}; returned the latest partial response.`
              : `Timed out without detecting a ${providerDisplayName} response.`,
            retryable: deliveryState !== "confirmed",
            hint: deliveryState === "confirmed"
              ? `Prompt delivery was confirmed; do not resend it. Reopen or continue the saved conversation, or run \`ask get --provider ${provider}\`.`
              : `Retry with a larger \`--timeout\`, or run \`ask status --provider ${provider} --verbose\`.`,
            context: {
              deliveryState,
              ...(result.conversationUrl ? { conversationUrl: result.conversationUrl } : {})
            },
            exitCode: 2
          });
          stderr.write(formatAskFailure(failure));
          setExitCode(failure.exitCode);
        }
      });
    });

  program
    .command("setup")
    .description("Set up a persistent Ask Chrome profile using an ordinary Chrome sign-in window with automation off.")
    .addOption(providerOption())
    .option("--timeout <ms>", "time allowed to finish sign-in and fully quit Chrome", parseTimeout, DEFAULT_TIMEOUT_MS)
    .option("-v, --verbose", "print browser/session details")
    .action(async (options: CommonOptions) => {
      await runWithErrors(stderr, setExitCode, async () => {
        const provider = resolveCliProvider(options, program, env);
        const providerDisplayName = getProvider(provider).displayName;
        writeProgress(
          stderr,
          `Opening ordinary Chrome for ${providerDisplayName} sign-in with automation off. Sign in, then fully quit that Chrome instance; Ask will verify and move the managed profile into the background automatically…`
        );
        await runner.setup({
          provider,
          timeoutMs: resolveTimeout(options, program),
          verbose: resolveVerbose(options, program)
        });
        writeProgress(stderr, `${providerDisplayName} is signed in and ready for Ask.`);
      });
    });

  program
    .command("login")
    .description("Alias for `ask setup`; sign in to the persistent Ask Chrome profile with automation off.")
    .addOption(providerOption())
    .option("--timeout <ms>", "timeout in milliseconds", parseTimeout, DEFAULT_TIMEOUT_MS)
    .option("-v, --verbose", "print browser/session details")
    .action(async (options: CommonOptions) => {
      await runWithErrors(stderr, setExitCode, async () => {
        const provider = resolveCliProvider(options, program, env);
        const providerDisplayName = getProvider(provider).displayName;
        writeProgress(
          stderr,
          `Opening ordinary Chrome for ${providerDisplayName} sign-in with automation off. Sign in, then fully quit that Chrome instance…`
        );
        await runner.login({
          provider,
          headless: options.headless,
          timeoutMs: resolveTimeout(options, program),
          verbose: resolveVerbose(options, program)
        });
        writeProgress(stderr, `${providerDisplayName} is signed in and ready for Ask.`);
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
      const providerDisplayName = getProvider(provider).displayName;
      const queueProgress = createQueueProgress(stderr, providerDisplayName);
      const readinessProgress = createReadinessProgress(stderr);
      const commandTimeoutMs = resolveTimeout(options, program);
      const firstAttemptStartedAt = Date.now();
      writeProgress(
        stderr,
        `Opening ${providerDisplayName} ${newSession ? "in a new conversation" : "in the previous conversation"}${options.send ? " and sending the prompt" : ""}…`
      );
      const openOptions = {
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
        // Never foreground a remotely controlled worker for auth. The safe
        // ordinary-Chrome bootstrap below only runs after a pre-send failure.
        allowInteractiveAuth: false,
        onReadinessUpdate: readinessProgress.update,
        timeoutMs: commandTimeoutMs,
        verbose: resolveVerbose(options, program),
        send: Boolean(options.send)
      };
      try {
        await runner.open(openOptions);
      } catch (error) {
        if (!options.send || !shouldRunSecureSetup(error, stderr, options.headless)) {
          throw error;
        }
        const commandDeadlineAt =
          (queueProgress.activeAt ?? firstAttemptStartedAt) + Math.max(0, commandTimeoutMs);
        await retryAfterCoalescedSecureSetup({
          runner,
          provider,
          providerDisplayName,
          deadlineAt: commandDeadlineAt,
          initialError: error,
          verbose: resolveVerbose(options, program),
          readinessProgress,
          run: (timeoutMs) => runner.open({ ...openOptions, timeoutMs })
        });
      }
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
        timeoutMs: resolveTimeout(options, program),
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
        timeoutMs: resolveTimeout(options, program),
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
        timeoutMs: resolveTimeout(options, program),
        verbose: resolveVerbose(options, program)
      });
      if (!output) {
        stdout.write(`${filePath}\n`);
      } else {
        stderr.write(`Saved screenshot to ${filePath}\n`);
      }
    });
  });

  const status = program.command("status").description("Show Chrome and provider readiness; use --verbose for technical details.");
  status
    .addOption(providerOption())
    .option("--timeout <ms>", "message-box detection timeout in milliseconds", parseTimeout, STATUS_TIMEOUT_MS)
    .option("-v, --verbose", "print browser/session details")
    .action(async (options: CommonOptions) => {
      await runWithErrors(stderr, setExitCode, async () => {
        const provider = options.provider ?? (program.opts() as Partial<CommonOptions>).provider;
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

function resolveTimeout(options: CommonOptions, program: Command): number {
  if (options.timeout !== DEFAULT_TIMEOUT_MS) {
    return options.timeout;
  }

  const globalTimeout = (program.opts() as Partial<CommonOptions>).timeout;
  return typeof globalTimeout === "number" ? globalTimeout : options.timeout;
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
  getQueueUpdate: () => ExecutionQueueUpdate | undefined,
  getReadinessUpdate: () => ReadinessUpdate | undefined
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
  let announcedReadinessPhase: ReadinessUpdate["phase"] | undefined;
  let spinnerVisible = false;
  const render = () => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const queue = getQueueUpdate();
    const readiness = getReadinessUpdate();
    if (readiness?.phase === "awaiting-auth") {
      if (announcedReadinessPhase !== readiness.phase) {
        if (spinnerVisible) {
          stderr.write("\r\x1b[2K");
          spinnerVisible = false;
        }
        announcedReadinessPhase = readiness.phase;
      }
      return;
    }
    const readinessActivity = readiness?.phase === "recovering"
      ? "recovering provider page"
      : readiness?.phase === "resumed"
      ? "resuming after sign-in"
      : readiness?.phase === "submission-uncertain"
      ? "checking whether prompt was sent"
      : undefined;
    const activity = readinessActivity || (queue?.phase === "queued"
      ? `queued ${queue.position}/${MAX_QUEUED_EXECUTIONS}`
      : newSession ? "starting new conversation" : "continuing");
    stderr.write(
      `\r\x1b[2K${frames[frameIndex]} ${providerDisplayName} · ${activity} · ${elapsedSeconds}s`
    );
    spinnerVisible = true;
    announcedReadinessPhase = readiness?.phase;
    frameIndex = (frameIndex + 1) % frames.length;
  };

  render();
  const timer = setInterval(() => {
    render();
  }, 80);
  timer.unref();

  return () => {
    clearInterval(timer);
    if (spinnerVisible) {
      stderr.write("\r\x1b[2K");
    }
    return Date.now() - startedAt;
  };
}

function createReadinessProgress(stderr: WritableLike): {
  current?: ReadinessUpdate;
  update(update: ReadinessUpdate): void;
} {
  const progress: {
    current?: ReadinessUpdate;
    update(update: ReadinessUpdate): void;
  } = {
    update(update) {
      const previous = progress.current;
      progress.current = update;
      if (previous?.phase === update.phase) {
        return;
      }
      if (isInteractive(stderr)) {
        if (update.phase === "awaiting-auth") {
          stderr.write(`\r\x1b[2K${update.message}\n`);
        } else if (update.phase === "resumed" && previous?.phase === "awaiting-auth") {
          stderr.write(`${update.message}\n`);
        }
        return;
      }
      stderr.write(`${update.message}\n`);
    }
  };
  return progress;
}

function createQueueProgress(stderr: WritableLike, providerDisplayName: string): {
  current?: ExecutionQueueUpdate;
  activeAt?: number;
  update(update: ExecutionQueueUpdate): void;
} {
  const progress: {
    current?: ExecutionQueueUpdate;
    activeAt?: number;
    update(update: ExecutionQueueUpdate): void;
  } = {
    update(update) {
      const previous = progress.current;
      progress.current = update;
      if (update.phase === "active" && progress.activeAt === undefined) {
        progress.activeAt = Date.now();
      }
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

function remainingTimeout(deadlineAt: number): number {
  return Math.max(0, Math.ceil(deadlineAt - Date.now()));
}

function isInteractive(stderr: WritableLike): boolean {
  return Boolean((stderr as WritableLike & { isTTY?: boolean }).isTTY);
}

function shouldRunSecureSetup(
  error: unknown,
  stderr: WritableLike,
  headless: boolean | undefined
): error is AskFailure {
  if (!isInteractive(stderr) || headless || !(error instanceof AskFailure)) {
    return false;
  }
  if (error.context?.deliveryState !== "not-attempted") {
    return false;
  }
  return error.code === "AUTH_REQUIRED" ||
    error.code === "AUTH_UNCONFIRMED";
}

interface CoalescedSecureSetupRetry<T> {
  runner: Runner;
  provider: ProviderName;
  providerDisplayName: string;
  deadlineAt: number;
  initialError: unknown;
  verbose: boolean | undefined;
  readinessProgress: { update(update: ReadinessUpdate): void };
  run(timeoutMs: number): Promise<T>;
}

/**
 * A provider readiness lease covers only a read-only readiness recheck and
 * the human setup flow. Prompt execution never runs under it: after the lease
 * is released, every command gets one original retry with its own remaining
 * deadline. Only a still-observed auth failure opens ordinary Chrome.
 */
async function retryAfterCoalescedSecureSetup<T>(options: CoalescedSecureSetupRetry<T>): Promise<T> {
  const leaseTimeoutMs = remainingTimeout(options.deadlineAt);
  if (leaseTimeoutMs <= 0) {
    throw options.initialError;
  }

  const lease = await options.runner.acquireProviderReadinessLease(options.provider, leaseTimeoutMs);
  try {
    const readinessTimeoutMs = remainingTimeout(options.deadlineAt);
    if (readinessTimeoutMs <= 0) {
      throw options.initialError;
    }
    let readiness: ProviderReadinessCheck = "unavailable";
    try {
      readiness = await options.runner.inspectProviderReadiness(options.provider, readinessTimeoutMs);
    } catch {
      // An inspection outage is not proof that credentials are missing. The
      // one direct retry below returns its own safe structured failure.
    }

    if (readiness === "auth-required" || readiness === "auth-unconfirmed") {
      const setupTimeoutMs = remainingTimeout(options.deadlineAt);
      if (setupTimeoutMs <= 0) {
        throw options.initialError;
      }
      options.readinessProgress.update({
        phase: "awaiting-auth",
        provider: options.provider,
        message: `Finish ${options.providerDisplayName} sign-in in the ordinary Chrome window (automation is off), then fully quit that Chrome instance.`
      });
      await options.runner.setup({
        provider: options.provider,
        timeoutMs: setupTimeoutMs,
        verbose: options.verbose
      });
      options.readinessProgress.update({
        phase: "resumed",
        provider: options.provider,
        message: `${options.providerDisplayName} sign-in verified; resuming the original prompt.`
      });
    }
  } finally {
    await lease.release();
  }

  const retryTimeoutMs = remainingTimeout(options.deadlineAt);
  if (retryTimeoutMs <= 0) {
    throw options.initialError;
  }
  // This final original command is intentionally outside the readiness lease:
  // it may take the full response budget, while other followers can observe
  // ready state and proceed. Never wrap it in this recovery again.
  return options.run(retryTimeoutMs);
}

function formatStatus(report: BrowserStatusReport, verbose = false): string {
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

function formatChromeStatus(report: BrowserStatusReport): string {
  const session = report.session;
  const placement = session.placement || (session.headless ? "headless" : "unknown");
  const port = typeof session.port === "number"
    ? `port ${session.port}`
    : session.portPolicy === "automatic" ? "port auto" : "port unassigned";
  if (!session.connected || session.sessionOwnership === "absent") {
    return `Chrome: not running · ${port}`;
  }
  if (session.sessionOwnership !== "ask-managed") {
    return `Chrome: session conflict · ${session.sessionOwnership} · ${port}`;
  }
  return `Chrome: running · ask-managed · ${placement} · ${port}`;
}

function formatStatusTable(report: BrowserStatusReport): string {
  const rows = [
    ["PROVIDER", "STATUS", "AUTH", "MESSAGE BOX"],
    ...report.providers.map((provider) => [
      provider.providerDisplayName,
      provider.status.replaceAll("-", " "),
      provider.authState,
      provider.messageBox.replaceAll("-", " ")
    ])
  ];
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => row[index]?.length || 0))
  );
  return rows
    .map((row) => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd())
    .join("\n");
}

function formatVerboseStatus(report: BrowserStatusReport): string[] {
  const session = report.session;
  const placement = session.placement || (session.headless ? "headless" : "unknown");
  const endpoint = typeof session.port === "number"
    ? `port ${session.port}`
    : session.portPolicy === "automatic" ? "automatic port (not assigned)" : "pinned port (not assigned)";
  const lines = [
    `Session: ${session.sessionOwnership}`,
    `Chrome debugging: ${session.connected ? "connected" : "not running"} on ${endpoint}`,
    `Port policy: ${session.portPolicy}`,
    `Chrome mode: ${session.connected ? (session.headless ? "headless" : "headed") : "n/a"}`,
    `Window placement: ${session.connected ? placement : "n/a"}`,
    `Browser: ${session.browser || "unknown"}`,
    `User agent: ${session.userAgent || "unknown"}`,
    `Pages: ${session.pageCount} total`
  ];

  for (const provider of report.providers) {
    lines.push(
      "",
      `${provider.providerDisplayName} (${provider.provider}):`,
      `  Status: ${provider.status.replaceAll("-", " ")}`,
      `  Pages: ${provider.providerPageCount}`,
      `  Current page: ${provider.currentPageUrl || "none"}`,
      `  Message box: ${provider.messageBox.replaceAll("-", " ")}`,
      `  Auth: ${provider.authState}`,
      `  Ready to send: ${provider.readyToSend ? "yes" : "no"}`,
      `  Ready for headless: ${provider.readyForHeadless ? "yes" : "no"}`,
      `  Note: ${provider.note}`
    );
  }

  return lines;
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

function formatAskFailure(error: AskFailure): string {
  const lines = [
    `ask: ${error.providerDisplayName} failed at ${error.stage} [${error.code}]`,
    error.message
  ];
  if (error.detail) {
    lines.push(`Detail: ${error.detail}`);
  }
  const context: string[] = [];
  if (error.context?.providerHost) {
    context.push(`host=${error.context.providerHost}`);
  }
  if (error.context?.authState) {
    context.push(`auth=${error.context.authState}`);
  }
  if (typeof error.context?.promptInputVisible === "boolean") {
    context.push(`message-box=${error.context.promptInputVisible ? "available" : "not-found"}`);
  }
  if (error.context?.deliveryState) {
    context.push(`delivery=${error.context.deliveryState}`);
  }
  if (typeof error.context?.recoveryAttempts === "number") {
    context.push(`recoveries=${error.context.recoveryAttempts}`);
  }
  if (error.context?.capability) {
    context.push(`capability=${error.context.capability}`);
  }
  if (error.context?.conversationUrl) {
    context.push(`conversation=${error.context.conversationUrl}`);
  }
  if (context.length > 0) {
    lines.push(`Context: ${context.join(" · ")}`);
  }
  lines.push(`Next: ${error.hint}`);
  return `${lines.join("\n")}\n`;
}

async function runWithErrors(
  stderr: WritableLike,
  setExitCode: (code: number) => void,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AskFailure) {
      stderr.write(formatAskFailure(error));
      setExitCode(error.exitCode);
      return;
    }

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
