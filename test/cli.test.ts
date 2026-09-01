import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgram, type Runner } from "../src/cli";
import { AskFailure } from "../src/errors";

class BufferWriter {
  text = "";
  isTTY?: boolean;

  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  write(chunk: string): void {
    this.text += chunk;
  }
}

function ttyStdin(): NodeJS.ReadStream {
  return { isTTY: true } as NodeJS.ReadStream;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.()
  };
}

function preDispatchAuthFailure(provider: "chatgpt" | "gemini" = "chatgpt"): AskFailure {
  return new AskFailure({
    code: "AUTH_REQUIRED",
    stage: "auth.inspect",
    provider,
    providerDisplayName: provider === "chatgpt" ? "ChatGPT" : "Gemini",
    message: "Sign-in required.",
    retryable: true,
    hint: "Sign in.",
    context: { deliveryState: "not-attempted" }
  });
}

function makeRunner(): Runner {
  return {
    acquireProviderReadinessLease: vi.fn(async () => ({
      id: "test-readiness",
      release: async () => undefined
    })),
    inspectProviderReadiness: vi.fn(async () => "auth-required" as const),
    setup: vi.fn(),
    login: vi.fn(),
    open: vi.fn(),
    ask: vi.fn(async () => ({
      text: "answer",
      timedOut: false,
      conversationUrl: "https://chatgpt.com/c/abc123"
    })),
    get: vi.fn(async () => "latest"),
    dump: vi.fn(async () => "<html></html>"),
    screenshot: vi.fn(async () => "C:\\Users\\Me\\.ask\\screenshots\\shot.png"),
    status: vi.fn(async () => ({
      session: {
        port: 9222,
        portPolicy: "pinned" as const,
        connected: true,
        sessionOwnership: "ask-managed" as const,
        headless: false,
        placement: "visible" as const,
        browser: "Chrome/149.0.0.0",
        userAgent: "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36",
        pageCount: 1
      },
      providers: [
        {
          provider: "chatgpt" as const,
          providerDisplayName: "ChatGPT",
          status: "ready" as const,
          providerPageCount: 1,
          currentPageUrl: "https://chatgpt.com/",
          messageBox: "available" as const,
          promptInputVisible: true,
          authState: "signed-in-likely" as const,
          readyToSend: true,
          readyForHeadless: true,
          loggedInLikely: true,
          note: "ChatGPT appears signed in and ready in the visible ask Chrome session."
        },
        {
          provider: "gemini" as const,
          providerDisplayName: "Gemini",
          status: "not-open" as const,
          providerPageCount: 0,
          messageBox: "not-checked" as const,
          promptInputVisible: false,
          authState: "unknown" as const,
          readyToSend: false,
          readyForHeadless: false,
          loggedInLikely: false,
          note: "No Gemini page is open in the ask-managed Chrome session."
        }
      ]
    })),
    listConversations: vi.fn(async () => []),
    forgetConversation: vi.fn(async () => true)
  };
}

function makeProgram(runner: Runner, options: { env?: NodeJS.ProcessEnv; stdout?: BufferWriter; stderr?: BufferWriter; setExitCode?: (code: number) => void } = {}) {
  return createProgram({
    runner,
    env: options.env,
    stdin: ttyStdin(),
    stdout: options.stdout || new BufferWriter(),
    stderr: options.stderr || new BufferWriter(),
    setExitCode: options.setExitCode
  });
}

describe("cli", () => {
  it("routes the top-level prompt to ask and prints the answer", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    let exitCode = 0;

    const program = createProgram({
      runner,
      stdin: ttyStdin(),
      stdout,
      stderr,
      setExitCode: (code) => {
        exitCode = code;
      }
    });

    await program.parseAsync(["node", "ask", "Plan", "this"]);

    expect(runner.ask).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      prompt: "Plan this",
      attachments: [],
      headless: undefined,
      newSession: true,
      onQueueUpdate: expect.any(Function),
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function),
      timeoutMs: 600000,
      verbose: undefined
    });
    expect(stdout.text).toBe("answer\n");
    expect(stderr.text).toBe("");
    expect(exitCode).toBe(0);
  });

  it("maps -v to verbose for the top-level prompt", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    const program = createProgram({
      runner,
      stdin: ttyStdin(),
      stdout,
      stderr
    });

    await program.parseAsync(["node", "ask", "-v", "Plan", "this"]);

    expect(runner.ask).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      prompt: "Plan this",
      attachments: [],
      headless: undefined,
      newSession: true,
      onQueueUpdate: expect.any(Function),
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function),
      timeoutMs: 600000,
      verbose: true
    });
  });

  it("prints concise guidance when no prompt, stdin, or attachment is provided", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    let exitCode = 0;

    const program = createProgram({
      runner,
      stdin: ttyStdin(),
      stdout,
      stderr,
      setExitCode: (code) => {
        exitCode = code;
      }
    });

    await program.parseAsync(["node", "ask"]);

    expect(stderr.text).toContain("Provide a prompt, pipe text through stdin, or attach a file.");
    expect(stderr.text).toContain('ask "Explain this code"');
    expect(stderr.text).toContain("ask --help");
    expect(stderr.text).not.toContain("Commands:");
    expect(stdout.text).toBe("");
    expect(exitCode).toBe(1);
    expect(runner.ask).not.toHaveBeenCalled();
  });

  it.each(["-h", "--help"])("prints top-level help for %s", async (flag) => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    const program = createProgram({
      runner,
      stdin: ttyStdin(),
      stdout,
      stderr
    });

    await expect(program.parseAsync(["node", "ask", flag])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
      exitCode: 0
    });

    expect(stdout.text).toContain("Usage: ask [options] [command] [prompt...]");
    expect(stdout.text).toContain("signed-in ChatGPT or Gemini sessions");
    expect(stdout.text).toContain("prompt text; reads stdin when omitted");
    expect(stdout.text).toContain("-h, --help");
    expect(stdout.text).toContain("-v, --verbose");
    expect(stdout.text).toContain("-a, --attach");
    expect(stdout.text).not.toContain("-i, --image");
    expect(stdout.text).toContain("--provider");
    expect(stdout.text).toContain("--new");
    expect(stdout.text).toContain("--continue");
    expect(stdout.text).toContain("status");
    expect(stdout.text).not.toContain("--image-output");
    expect(stdout.text).not.toContain("--force");
    expect(stderr.text).toBe("");
    expect(runner.ask).not.toHaveBeenCalled();
  });

  it("prints open help with signed-in send guidance", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    const program = createProgram({
      runner,
      stdin: ttyStdin(),
      stdout,
      stderr
    });

    await expect(program.parseAsync(["node", "ask", "open", "--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
      exitCode: 0
    });

    expect(stdout.text).toContain("signed-in auth is confirmed");
    expect(stdout.text).toContain("--send");
    expect(stdout.text).toContain("--provider");
    expect(stdout.text).not.toContain("--headless");
    expect(stderr.text).toBe("");
    expect(runner.open).not.toHaveBeenCalled();
  });
  it("maps repeated -a attachments for the top-level prompt", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "-a", "report.pdf", "-a", "data.csv", "Plan", "this"]);

    expect(runner.ask).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      prompt: "Plan this",
      attachments: ["report.pdf", "data.csv"],
      headless: undefined,
      newSession: true,
      onQueueUpdate: expect.any(Function),
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function),
      timeoutMs: 600000,
      verbose: undefined
    });
  });

  it("allows an attachment-only top-level prompt", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "--attach", "report.pdf"]);

    expect(runner.ask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "",
      attachments: ["report.pdf"]
    }));
  });

  it.each(["-i", "--image"])("rejects removed image option %s", async (flag) => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await expect(program.parseAsync(["node", "ask", flag, "image.png", "Describe it"])).rejects.toMatchObject({
      code: "commander.unknownOption"
    });
    expect(runner.ask).not.toHaveBeenCalled();
  });

  it("maps --new to a fresh top-level session", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "--new", "Plan", "this"]);

    expect(runner.ask).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      prompt: "Plan this",
      attachments: [],
      headless: undefined,
      newSession: true,
      onQueueUpdate: expect.any(Function),
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function),
      timeoutMs: 600000,
      verbose: undefined
    });
  });

  it("continues the previous conversation and reports automatic new-session fallback", async () => {
    const runner = makeRunner();
    vi.mocked(runner.ask).mockImplementation(async (options) => {
      options.onContinuationUnavailable?.();
      return { text: "answer", timedOut: false };
    });
    const stderr = new BufferWriter();
    const program = makeProgram(runner, { stderr });

    await program.parseAsync(["node", "ask", "--continue", "Plan", "this"]);

    expect(runner.ask).toHaveBeenCalledWith(expect.objectContaining({
      newSession: false,
      onContinuationUnavailable: expect.any(Function)
    }));
    expect(stderr.text).toContain(
      "No previous ChatGPT conversation is available. Starting a new conversation."
    );
  });

  it("reports provider and conversation choice on an interactive terminal", async () => {
    const runner = makeRunner();
    const stderr = new BufferWriter(true);
    const program = makeProgram(runner, { stderr, env: { TERM: "xterm" } as NodeJS.ProcessEnv });

    await program.parseAsync(["node", "ask", "--new", "Plan", "this"]);

    expect(runner.ask).toHaveBeenCalledWith(expect.objectContaining({
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function)
    }));
    expect(stderr.text).toContain("⠋ ChatGPT · starting new conversation · 0s");
    expect(stderr.text).toContain("\r\x1b[2K");
    expect(stderr.text).toContain("✓ ChatGPT · new conversation · 0.0s\n");
    expect(stderr.text).toContain("↗ https://chatgpt.com/c/abc123\n\n");
  });

  it("pauses interactive progress for authentication and prints one resume message", async () => {
    const runner = makeRunner();
    vi.mocked(runner.ask).mockImplementation(async (options) => {
      options.onReadinessUpdate?.({
        phase: "awaiting-auth",
        provider: "chatgpt",
        message: "Finish ChatGPT sign-in in Chrome; this prompt will resume automatically."
      });
      options.onReadinessUpdate?.({
        phase: "resumed",
        provider: "chatgpt",
        message: "ChatGPT is ready; resuming."
      });
      return { text: "answer", timedOut: false };
    });
    const stderr = new BufferWriter(true);
    const program = makeProgram(runner, { stderr, env: { TERM: "xterm" } as NodeJS.ProcessEnv });

    await program.parseAsync(["node", "ask", "resume"]);

    expect(stderr.text.match(/Finish ChatGPT sign-in in Chrome/g)).toHaveLength(1);
    expect(stderr.text.match(/ChatGPT is ready; resuming\./g)).toHaveLength(1);
    expect(stderr.text).toContain("\r\x1b[2KFinish ChatGPT sign-in");
  });

  it("animates one waiting line with elapsed time for a slow interactive response", async () => {
    vi.useFakeTimers();
    try {
      const runner = makeRunner();
      let resolveAsk: ((value: { text: string; timedOut: boolean; conversationUrl?: string }) => void) | undefined;
      vi.mocked(runner.ask).mockImplementation(
        () => new Promise((resolve) => {
          resolveAsk = resolve;
        })
      );
      const stderr = new BufferWriter(true);
      const program = makeProgram(runner, { stderr, env: { TERM: "xterm" } as NodeJS.ProcessEnv });
      const run = program.parseAsync(["node", "ask", "Plan", "this"]);

      await vi.advanceTimersByTimeAsync(1_040);
      expect(stderr.text).toContain("ChatGPT · starting new conversation · 1s");
      expect(stderr.text).not.toContain("Still waiting");

      resolveAsk?.({ text: "answer", timedOut: false, conversationUrl: "https://chatgpt.com/c/slow" });
      await run;
      expect(stderr.text).toContain("✓ ChatGPT · new conversation · 1.0s");
      expect(stderr.text).toContain("↗ https://chatgpt.com/c/slow\n\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports queued and admitted execution progress on stderr", async () => {
    const runner = makeRunner();
    vi.mocked(runner.ask).mockImplementation(async (options) => {
      options.onQueueUpdate?.({ phase: "queued", position: 2, active: 4, queued: 2, waitedMs: 0 });
      options.onQueueUpdate?.({ phase: "active", position: 0, active: 4, queued: 1, waitedMs: 100 });
      return { text: "answer", timedOut: false };
    });
    const stderr = new BufferWriter();
    const program = makeProgram(runner, { stderr });

    await program.parseAsync(["node", "ask", "Plan this"]);

    expect(stderr.text).toContain("ChatGPT · queued 2/4 · waiting for an execution slot");
    expect(stderr.text).toContain("ChatGPT · execution slot acquired · starting…");
  });

  it("labels a continued conversation and prints its URL before the response", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter(true);
    const stderr = new BufferWriter(true);
    const program = makeProgram(runner, { stdout, stderr, env: { TERM: "xterm" } as NodeJS.ProcessEnv });

    await program.parseAsync(["node", "ask", "--continue", "hi"]);

    expect(stderr.text).toContain("✓ ChatGPT · continued · 0.0s\n");
    expect(stderr.text).toContain("↗ https://chatgpt.com/c/abc123\n\n");
    expect(stdout.text).toBe("answer\n");
  });

  it("confirms saved prompt output without writing the response to stdout", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-cli-prompt-save-"));
    const output = path.join(tempDir, "answer.txt");

    try {
      const program = makeProgram(runner, { stdout, stderr });
      await program.parseAsync(["node", "ask", "--output", output, "Plan", "this"]);

      expect(stdout.text).toBe("");
      expect(stderr.text).toBe(`Saved response to ${output}\n`);
      await expect(fs.promises.readFile(output, "utf8")).resolves.toBe("answer");
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sets a non-zero exit code when ChatGPT times out with a partial response", async () => {
    const runner = makeRunner();
    vi.mocked(runner.ask).mockResolvedValue({ text: "partial", timedOut: true });
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    let exitCode = 0;

    const program = createProgram({
      runner,
      stdin: ttyStdin(),
      stdout,
      stderr,
      setExitCode: (code) => {
        exitCode = code;
      }
    });

    await program.parseAsync(["node", "ask", "prompt"]);

    expect(stdout.text).toBe("partial\n");
    expect(stderr.text).toContain("ask: ChatGPT failed at response.wait [RESPONSE_TIMEOUT]");
    expect(stderr.text).toContain("Timed out waiting for ChatGPT");
    expect(stderr.text).toContain("Next:");
    expect(exitCode).toBe(2);
  });

  it("prints structured provider failures with safe context and remediation", async () => {
    const runner = makeRunner();
    vi.mocked(runner.ask).mockRejectedValue(new AskFailure({
      code: "PROMPT_INPUT_NOT_FOUND",
      stage: "prompt.find",
      provider: "gemini",
      providerDisplayName: "Gemini",
      message: "Could not find a visible Gemini message box.",
      retryable: true,
      hint: "Run `ask status --provider gemini --verbose`.",
      detail: "No configured editor selector matched.",
      context: {
        providerHost: "gemini.google.com",
        authState: "signed-in-likely",
        promptInputVisible: false
      }
    }));
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    let exitCode = 0;
    const program = makeProgram(runner, {
      stdout,
      stderr,
      setExitCode: (code) => {
        exitCode = code;
      }
    });

    await program.parseAsync(["node", "ask", "--provider", "gemini", "prompt"]);

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe(
      "ask: Gemini failed at prompt.find [PROMPT_INPUT_NOT_FOUND]\n" +
      "Could not find a visible Gemini message box.\n" +
      "Detail: No configured editor selector matched.\n" +
      "Context: host=gemini.google.com · auth=signed-in-likely · message-box=not-found\n" +
      "Next: Run `ask status --provider gemini --verbose`.\n"
    );
    expect(exitCode).toBe(1);
  });

  it("prints delivery-unknown recovery context without leaking prompt or page content", async () => {
    const runner = makeRunner();
    const secret = "secret prompt text";
    vi.mocked(runner.ask).mockRejectedValue(new AskFailure({
      code: "PROMPT_DELIVERY_UNKNOWN",
      stage: "prompt.confirm",
      provider: "chatgpt",
      providerDisplayName: "ChatGPT",
      message: "ChatGPT may have received the prompt, but delivery could not be confirmed safely.",
      retryable: false,
      hint: "Inspect the preserved ChatGPT tab; do not resend automatically.",
      context: {
        providerHost: "chatgpt.com",
        deliveryState: "unknown",
        recoveryAttempts: 1,
        capability: "chatgpt.send-testid",
        conversationUrl: "https://chatgpt.com/c/uncertain"
      }
    }));
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    let exitCode = 0;
    const program = makeProgram(runner, {
      stdout,
      stderr,
      setExitCode: (code) => {
        exitCode = code;
      }
    });

    await program.parseAsync(["node", "ask", secret]);

    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("delivery=unknown");
    expect(stderr.text).toContain("recoveries=1");
    expect(stderr.text).toContain("conversation=https://chatgpt.com/c/uncertain");
    expect(stderr.text).not.toContain(secret);
    expect(stderr.text).not.toContain("<html");
    expect(exitCode).toBe(1);
  });

  it("routes a top-level Gemini prompt", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "--provider", "gemini", "Plan", "this"]);

    expect(runner.ask).toHaveBeenCalledWith({
      provider: "gemini",
      prompt: "Plan this",
      attachments: [],
      headless: undefined,
      newSession: true,
      onQueueUpdate: expect.any(Function),
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function),
      timeoutMs: 600000,
      verbose: undefined
    });
  });

  it("uses ASK_PROVIDER as the default provider", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner, { env: { ASK_PROVIDER: "gemini" } as NodeJS.ProcessEnv });

    await program.parseAsync(["node", "ask", "Plan", "this"]);

    expect(runner.ask).toHaveBeenCalledWith(expect.objectContaining({ provider: "gemini" }));
  });

  it("lets an explicit provider override ASK_PROVIDER", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner, { env: { ASK_PROVIDER: "chatgpt" } as NodeJS.ProcessEnv });

    await program.parseAsync(["node", "ask", "--provider", "gemini", "Plan", "this"]);

    expect(runner.ask).toHaveBeenCalledWith(expect.objectContaining({ provider: "gemini" }));
  });

  it("rejects invalid ASK_PROVIDER values clearly", async () => {
    const runner = makeRunner();
    const stderr = new BufferWriter();
    let exitCode = 0;
    const program = makeProgram(runner, {
      env: { ASK_PROVIDER: "claude" } as NodeJS.ProcessEnv,
      stderr,
      setExitCode: (code) => {
        exitCode = code;
      }
    });

    await program.parseAsync(["node", "ask", "Plan", "this"]);

    expect(stderr.text).toContain('Unsupported provider "claude"');
    expect(stderr.text).toContain("chatgpt, gemini");
    expect(exitCode).toBe(1);
    expect(runner.ask).not.toHaveBeenCalled();
  });

  it("maps -v to verbose for login", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "login", "-v"]);

    expect(runner.login).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      headless: undefined,
      timeoutMs: 600000,
      verbose: true
    });
  });

  it("routes setup to the dedicated-profile authentication bootstrap", async () => {
    const runner = makeRunner();
    const stderr = new BufferWriter(true);
    const program = makeProgram(runner, { stderr });

    await program.parseAsync(["node", "ask", "setup", "--provider", "gemini", "--timeout", "120000"]);

    expect(runner.setup).toHaveBeenCalledWith({
      provider: "gemini",
      timeoutMs: 120000,
      verbose: undefined
    });
    expect(stderr.text).toContain("ordinary Chrome");
    expect(stderr.text).toContain("fully quit");
    expect(stderr.text).toContain("Gemini is signed in and ready for Ask");
  });

  it("runs dedicated-profile setup after a safe first-use auth failure and retries once", async () => {
    const runner = makeRunner();
    vi.mocked(runner.ask)
      .mockRejectedValueOnce(new AskFailure({
        code: "AUTH_REQUIRED",
        stage: "auth.inspect",
        provider: "chatgpt",
        providerDisplayName: "ChatGPT",
        message: "Sign-in required.",
        retryable: true,
        hint: "Sign in.",
        context: { deliveryState: "not-attempted" }
      }))
      .mockResolvedValueOnce({ text: "answer", timedOut: false });
    const stderr = new BufferWriter(true);
    const program = makeProgram(runner, { stderr });

    await program.parseAsync(["node", "ask", "Plan", "this"]);

    expect(runner.setup).toHaveBeenCalledWith({
      provider: "chatgpt",
      timeoutMs: expect.any(Number),
      verbose: undefined
    });
    expect(vi.mocked(runner.setup).mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
    expect(runner.ask).toHaveBeenCalledTimes(2);
    expect(stderr.text).toContain("Finish ChatGPT sign-in in the ordinary Chrome window");
    expect(stderr.text).toContain("resuming the original prompt");
  });

  it("coalesces concurrent first-use setup and releases readiness before both prompt retries", async () => {
    const runner = makeRunner();
    const leaderSetupStarted = deferred();
    const allowLeaderSetupToFinish = deferred();
    const followerWaitingForReadiness = deferred();
    const leaderReleasedReadiness = deferred();
    const firstStderr = new BufferWriter(true);
    const secondStderr = new BufferWriter(true);
    const firstProgram = makeProgram(runner, { stderr: firstStderr });
    const secondProgram = makeProgram(runner, { stderr: secondStderr });
    const attempts: Array<{ command: "ask" | "open"; prompt: string; timeoutMs: number }> = [];
    const dispatched: string[] = [];
    let signedIn = false;
    let now = 10_000;
    let leaseReleaseCount = 0;
    let firstLease = true;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      vi.mocked(runner.acquireProviderReadinessLease).mockImplementation(async () => {
        if (firstLease) {
          firstLease = false;
          return {
            id: "leader",
            release: async () => {
              leaseReleaseCount += 1;
              leaderReleasedReadiness.resolve();
            }
          };
        }
        followerWaitingForReadiness.resolve();
        await leaderReleasedReadiness.promise;
        return {
          id: "follower",
          release: async () => {
            leaseReleaseCount += 1;
          }
        };
      });
      vi.mocked(runner.inspectProviderReadiness).mockImplementation(async () =>
        signedIn ? "ready" : "auth-required"
      );
      vi.mocked(runner.setup).mockImplementation(async () => {
        leaderSetupStarted.resolve();
        await allowLeaderSetupToFinish.promise;
        now += 125;
        signedIn = true;
      });
      vi.mocked(runner.ask).mockImplementation(async (options) => {
        attempts.push({ command: "ask", prompt: options.prompt, timeoutMs: options.timeoutMs });
        if (!signedIn) {
          throw preDispatchAuthFailure();
        }
        dispatched.push(options.prompt);
        return { text: `${options.prompt} answer`, timedOut: false };
      });
      vi.mocked(runner.open).mockImplementation(async (options) => {
        attempts.push({ command: "open", prompt: options.prompt, timeoutMs: options.timeoutMs });
        if (!signedIn) {
          throw preDispatchAuthFailure();
        }
        dispatched.push(options.prompt);
      });

      const first = firstProgram.parseAsync(["node", "ask", "--timeout", "1000", "first prompt"]);
      await leaderSetupStarted.promise;

      const second = secondProgram.parseAsync([
        "node", "ask", "open", "--send", "--timeout", "1000", "second prompt"
      ]);
      await followerWaitingForReadiness.promise;
      allowLeaderSetupToFinish.resolve();

      await Promise.all([first, second]);

      expect(runner.setup).toHaveBeenCalledOnce();
      expect(runner.inspectProviderReadiness).toHaveBeenCalledTimes(2);
      expect(leaseReleaseCount).toBe(2);
      expect(dispatched.sort()).toEqual(["first prompt", "second prompt"]);
      expect(attempts.filter((attempt) => attempt.prompt === "first prompt")).toHaveLength(2);
      expect(attempts.filter((attempt) => attempt.prompt === "second prompt")).toHaveLength(2);
      expect(attempts.filter((attempt) => attempt.command === "ask")).toHaveLength(2);
      expect(attempts.filter((attempt) => attempt.command === "open")).toHaveLength(2);
      expect(attempts.filter((attempt) => attempt.timeoutMs < 1_000)).toHaveLength(2);
      expect(firstStderr.text).toContain("ordinary Chrome window");
      expect(firstStderr.text).toContain("resuming the original prompt");
      expect(secondStderr.text).not.toContain("ordinary Chrome window");
      expect(secondStderr.text).not.toContain("resuming the original prompt");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("releases a failed setup leader so one waiting follower can re-evaluate without retrying in a loop", async () => {
    const runner = makeRunner();
    const leaderSetupStarted = deferred();
    const failLeaderSetup = deferred();
    const followerWaitingForReadiness = deferred();
    const leaderReleasedReadiness = deferred();
    const firstStderr = new BufferWriter(true);
    const secondStderr = new BufferWriter(true);
    let firstExitCode = 0;
    let secondExitCode = 0;
    const firstProgram = makeProgram(runner, { stderr: firstStderr, setExitCode: (code) => { firstExitCode = code; } });
    const secondProgram = makeProgram(runner, { stderr: secondStderr, setExitCode: (code) => { secondExitCode = code; } });
    const attempts: string[] = [];
    const dispatched: string[] = [];
    let signedIn = false;
    let setupAttempts = 0;
    let leaseReleaseCount = 0;
    let firstLease = true;

    vi.mocked(runner.acquireProviderReadinessLease).mockImplementation(async () => {
      if (firstLease) {
        firstLease = false;
        return {
          id: "failed-leader",
          release: async () => {
            leaseReleaseCount += 1;
            leaderReleasedReadiness.resolve();
          }
        };
      }
      followerWaitingForReadiness.resolve();
      await leaderReleasedReadiness.promise;
      return {
        id: "replacement-leader",
        release: async () => {
          leaseReleaseCount += 1;
        }
      };
    });
    vi.mocked(runner.inspectProviderReadiness).mockImplementation(async () =>
      signedIn ? "ready" : "auth-required"
    );
    vi.mocked(runner.setup).mockImplementation(async () => {
      setupAttempts += 1;
      if (setupAttempts === 1) {
        leaderSetupStarted.resolve();
        await failLeaderSetup.promise;
        throw new Error("ordinary Chrome setup was cancelled");
      }
      signedIn = true;
    });
    vi.mocked(runner.ask).mockImplementation(async (options) => {
      attempts.push(options.prompt);
      if (!signedIn) {
        throw preDispatchAuthFailure();
      }
      dispatched.push(options.prompt);
      return { text: `${options.prompt} answer`, timedOut: false };
    });

    const first = firstProgram.parseAsync(["node", "ask", "first prompt"]);
    await leaderSetupStarted.promise;
    const second = secondProgram.parseAsync(["node", "ask", "second prompt"]);
    await followerWaitingForReadiness.promise;
    failLeaderSetup.resolve();

    await Promise.all([first, second]);

    expect(setupAttempts).toBe(2);
    expect(leaseReleaseCount).toBe(2);
    expect(firstExitCode).toBe(1);
    expect(secondExitCode).toBe(0);
    expect(attempts.filter((prompt) => prompt === "first prompt")).toHaveLength(1);
    expect(attempts.filter((prompt) => prompt === "second prompt")).toHaveLength(2);
    expect(dispatched).toEqual(["second prompt"]);
    expect(firstStderr.text).toContain("ordinary Chrome setup was cancelled");
    expect(secondStderr.text).toContain("ordinary Chrome window");
  });

  it("runs ordinary-Chrome setup at most once for an interactive open --send auth failure", async () => {
    const runner = makeRunner();
    vi.mocked(runner.open)
      .mockRejectedValueOnce(new AskFailure({
        code: "AUTH_REQUIRED",
        stage: "auth.inspect",
        provider: "gemini",
        providerDisplayName: "Gemini",
        message: "Sign-in required.",
        retryable: true,
        hint: "Sign in.",
        context: { deliveryState: "not-attempted" }
      }))
      .mockResolvedValueOnce(undefined);
    const stderr = new BufferWriter(true);
    const program = makeProgram(runner, { stderr });

    await program.parseAsync(["node", "ask", "open", "--provider", "gemini", "--send", "Plan this"]);

    expect(runner.setup).toHaveBeenCalledTimes(1);
    expect(runner.setup).toHaveBeenCalledWith({
      provider: "gemini",
      timeoutMs: expect.any(Number),
      verbose: undefined
    });
    expect(vi.mocked(runner.setup).mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
    expect(runner.open).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runner.open).mock.calls[0]?.[0]).toMatchObject({
      allowInteractiveAuth: false,
      send: true,
      timeoutMs: 600000
    });
    expect(vi.mocked(runner.open).mock.calls[1]?.[0]).toMatchObject({
      allowInteractiveAuth: false,
      send: true,
      timeoutMs: expect.any(Number)
    });
    expect(stderr.text).toContain("ordinary Chrome window");
    expect(stderr.text).toContain("resuming the original prompt");
  });

  it("does not bootstrap setup for a non-interactive or delivery-unknown open --send failure", async () => {
    const cases = [
      { tty: false, deliveryState: "not-attempted" as const, code: "AUTH_REQUIRED" as const },
      { tty: true, deliveryState: "unknown" as const, code: "PROMPT_DELIVERY_UNKNOWN" as const }
    ];
    for (const testCase of cases) {
      const runner = makeRunner();
      vi.mocked(runner.open).mockRejectedValueOnce(new AskFailure({
        code: testCase.code,
        stage: testCase.deliveryState === "unknown" ? "prompt.confirm" : "auth.inspect",
        provider: "chatgpt",
        providerDisplayName: "ChatGPT",
        message: "Cannot continue.",
        retryable: false,
        hint: "Inspect the session.",
        context: { deliveryState: testCase.deliveryState }
      }));
      const program = makeProgram(runner, { stderr: new BufferWriter(testCase.tty) });

      await program.parseAsync(["node", "ask", "open", "--send", "Plan this"]);

      expect(runner.setup).not.toHaveBeenCalled();
      expect(runner.open).toHaveBeenCalledOnce();
    }
  });

  it("does not open setup for non-interactive or post-dispatch failures", async () => {
    const cases = [
      { tty: false, deliveryState: "not-attempted" as const },
      { tty: true, deliveryState: "unknown" as const }
    ];
    for (const testCase of cases) {
      const runner = makeRunner();
      vi.mocked(runner.ask).mockRejectedValueOnce(new AskFailure({
        code: testCase.deliveryState === "unknown" ? "PROMPT_DELIVERY_UNKNOWN" : "AUTH_REQUIRED",
        stage: testCase.deliveryState === "unknown" ? "prompt.confirm" : "auth.inspect",
        provider: "chatgpt",
        providerDisplayName: "ChatGPT",
        message: "Cannot continue.",
        retryable: false,
        hint: "Inspect the session.",
        context: { deliveryState: testCase.deliveryState }
      }));
      const stderr = new BufferWriter(testCase.tty);
      const program = makeProgram(runner, { stderr });

      await program.parseAsync(["node", "ask", "Plan", "this"]);

      expect(runner.setup).not.toHaveBeenCalled();
      expect(runner.ask).toHaveBeenCalledOnce();
    }
  });

  it("shares the queue-active deadline across ordinary setup and the single retry", async () => {
    const runner = makeRunner();
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      vi.mocked(runner.ask)
        .mockImplementationOnce(async (options) => {
          options.onQueueUpdate?.({
            phase: "active",
            position: 0,
            active: 1,
            queued: 0,
            waitedMs: 0
          });
          now += 250;
          throw new AskFailure({
            code: "AUTH_REQUIRED",
            stage: "auth.inspect",
            provider: "chatgpt",
            providerDisplayName: "ChatGPT",
            message: "Sign-in required.",
            retryable: true,
            hint: "Sign in.",
            context: { deliveryState: "not-attempted" }
          });
        })
        .mockImplementationOnce(async () => ({ text: "answer", timedOut: false }));
      vi.mocked(runner.setup).mockImplementationOnce(async () => {
        now += 250;
      });
      const program = makeProgram(runner, { stderr: new BufferWriter(true) });

      await program.parseAsync(["node", "ask", "--timeout", "1000", "Plan", "this"]);

      expect(vi.mocked(runner.ask).mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 1_000 });
      expect(vi.mocked(runner.setup).mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 750 });
      expect(vi.mocked(runner.ask).mock.calls[1]?.[0]).toMatchObject({ timeoutMs: 500 });
      expect(runner.setup).toHaveBeenCalledOnce();
      expect(runner.ask).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "a headless ask auth failure",
      argv: ["--headless", "Plan this"],
      method: "ask",
      tty: true,
      code: "AUTH_REQUIRED",
      deliveryState: "not-attempted"
    },
    {
      name: "a non-TTY ask auth failure",
      argv: ["Plan this"],
      method: "ask",
      tty: false,
      code: "AUTH_REQUIRED",
      deliveryState: "not-attempted"
    },
    {
      name: "an ask delivery-unknown failure",
      argv: ["Plan this"],
      method: "ask",
      tty: true,
      code: "PROMPT_DELIVERY_UNKNOWN",
      deliveryState: "unknown"
    },
    {
      name: "an ask failure after a confirmed dispatch",
      argv: ["Plan this"],
      method: "ask",
      tty: true,
      code: "AUTH_REQUIRED",
      deliveryState: "confirmed"
    },
    {
      name: "a non-auth ask failure",
      argv: ["Plan this"],
      method: "ask",
      tty: true,
      code: "BROWSER_UNAVAILABLE",
      deliveryState: "not-attempted"
    },
    {
      name: "an open --send failure after a confirmed dispatch",
      argv: ["open", "--send", "Plan this"],
      method: "open",
      tty: true,
      code: "AUTH_REQUIRED",
      deliveryState: "confirmed"
    },
    {
      name: "a plain open auth failure before send is requested",
      argv: ["open", "Plan this"],
      method: "open",
      tty: true,
      code: "AUTH_REQUIRED",
      deliveryState: "not-attempted"
    }
  ] as const)("never starts ordinary setup for $name", async (testCase) => {
    const runner = makeRunner();
    const failure = new AskFailure({
      code: testCase.code,
      stage: testCase.deliveryState === "unknown"
        ? "prompt.confirm"
        : testCase.code === "BROWSER_UNAVAILABLE" ? "browser.connect" : "auth.inspect",
      provider: "chatgpt",
      providerDisplayName: "ChatGPT",
      message: "Cannot continue safely.",
      retryable: false,
      hint: "Inspect the session.",
      context: { deliveryState: testCase.deliveryState }
    });
    if (testCase.method === "ask") {
      vi.mocked(runner.ask).mockRejectedValueOnce(failure);
    } else {
      vi.mocked(runner.open).mockRejectedValueOnce(failure);
    }
    const program = makeProgram(runner, { stderr: new BufferWriter(testCase.tty) });

    await program.parseAsync(["node", "ask", ...testCase.argv]);

    expect(runner.setup).not.toHaveBeenCalled();
    if (testCase.method === "ask") {
      expect(runner.ask).toHaveBeenCalledOnce();
      expect(runner.open).not.toHaveBeenCalled();
    } else {
      expect(runner.open).toHaveBeenCalledOnce();
      expect(runner.ask).not.toHaveBeenCalled();
    }
  });

  it("routes command-local provider for login", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "login", "--provider", "gemini"]);

    expect(runner.login).toHaveBeenCalledWith({
      provider: "gemini",
      headless: undefined,
      timeoutMs: 600000,
      verbose: undefined
    });
  });

  it("maps -v to verbose for open", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "open", "-v", "Plan this"]);

    expect(runner.open).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      url: "https://chatgpt.com/",
      prompt: "Plan this",
      attachments: [],
      headless: undefined,
      newSession: true,
      onQueueUpdate: expect.any(Function),
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function),
      timeoutMs: 600000,
      verbose: true,
      send: false
    });
  });

  it("maps -a to an attachment for open", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "open", "--attach", "report.pdf", "Plan this"]);

    expect(runner.open).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      url: "https://chatgpt.com/",
      prompt: "Plan this",
      attachments: ["report.pdf"],
      headless: undefined,
      newSession: true,
      onQueueUpdate: expect.any(Function),
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function),
      timeoutMs: 600000,
      verbose: undefined,
      send: false
    });
  });

  it("maps a global attachment option for open", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "-a", "report.pdf", "open", "Plan this"]);

    expect(runner.open).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Plan this",
      attachments: ["report.pdf"]
    }));
  });

  it("maps --new to a fresh open session", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "open", "--new", "Plan this"]);

    expect(runner.open).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      url: "https://chatgpt.com/",
      prompt: "Plan this",
      attachments: [],
      headless: undefined,
      newSession: true,
      onQueueUpdate: expect.any(Function),
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function),
      timeoutMs: 600000,
      verbose: undefined,
      send: false
    });
  });

  it("parses open conversation URLs separately from prompts", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    const program = createProgram({
      runner,
      stdin: ttyStdin(),
      stdout,
      stderr
    });

    await program.parseAsync(["node", "ask", "open", "--send", "https://chatgpt.com/c/abc123", "continue"]);

    expect(runner.open).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      url: "https://chatgpt.com/c/abc123",
      prompt: "continue",
      attachments: [],
      headless: undefined,
      newSession: true,
      onQueueUpdate: expect.any(Function),
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function),
      timeoutMs: 600000,
      verbose: undefined,
      send: true
    });
  });

  it("uses Gemini home for a Gemini open prompt", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "--provider", "gemini", "open", "Plan this"]);

    expect(runner.open).toHaveBeenCalledWith({
      provider: "gemini",
      url: "https://gemini.google.com/app",
      prompt: "Plan this",
      attachments: [],
      headless: undefined,
      newSession: true,
      onQueueUpdate: expect.any(Function),
      allowInteractiveAuth: false,
      onReadinessUpdate: expect.any(Function),
      timeoutMs: 600000,
      verbose: undefined,
      send: false
    });
  });

  it("uses command-local provider for a Gemini open prompt", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "open", "--provider", "gemini", "Plan this"]);

    expect(runner.open).toHaveBeenCalledWith(expect.objectContaining({
      provider: "gemini",
      url: "https://gemini.google.com/app"
    }));
  });

  it("prints get output through the shared writer", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();

    const program = createProgram({
      runner,
      stdin: ttyStdin(),
      stdout,
      stderr: new BufferWriter()
    });

    await program.parseAsync(["node", "ask", "get"]);
    expect(runner.get).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      headless: undefined,
      timeoutMs: 600000,
      verbose: undefined
    });
    expect(stdout.text).toBe("latest\n");
  });

  it("does not claim success or create output when get finds no response", async () => {
    const runner = makeRunner();
    vi.mocked(runner.get).mockResolvedValue("");
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    let exitCode = 0;
    const program = createProgram({
      runner,
      stdin: ttyStdin(),
      stdout,
      stderr,
      setExitCode: (code) => {
        exitCode = code;
      }
    });

    await program.parseAsync(["node", "ask", "get"]);

    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("No assistant response was found");
    expect(stderr.text).not.toContain("Saved response");
    expect(exitCode).toBe(1);
  });

  it("confirms the resolved path when saving output", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-cli-save-"));
    const output = path.join(tempDir, "nested", "latest.md");

    try {
      const program = makeProgram(runner, { stdout, stderr });
      await program.parseAsync(["node", "ask", "get", "--output", output]);

      expect(stdout.text).toBe("");
      expect(stderr.text).toBe(`Saved response to ${output}\n`);
      await expect(fs.promises.readFile(output, "utf8")).resolves.toBe("latest");
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prints every provider status by default", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const program = makeProgram(runner, { stdout });

    await program.parseAsync(["node", "ask", "status"]);

    expect(runner.status).toHaveBeenCalledWith({
      timeoutMs: 3000,
      verbose: undefined
    });
    expect(stdout.text).toContain("Chrome: running · ask-managed · visible · port 9222");
    expect(stdout.text).toContain("PROVIDER  STATUS    AUTH              MESSAGE BOX");
    expect(stdout.text).toContain("ChatGPT   ready     signed-in-likely  available");
    expect(stdout.text).toContain("Gemini    not open  unknown           not checked");
    expect(stdout.text).not.toContain("Message box:");
  });

  it("renders port auto before an automatic session has been assigned", async () => {
    const runner = makeRunner();
    const report = await runner.status({ timeoutMs: 3000 });
    vi.mocked(runner.status).mockResolvedValue({
      ...report,
      session: {
        ...report.session,
        port: undefined,
        portPolicy: "automatic",
        connected: false,
        sessionOwnership: "absent",
        headless: undefined,
        placement: "unknown",
        pageCount: 0
      }
    });
    const stdout = new BufferWriter();
    const program = makeProgram(runner, { stdout });

    await program.parseAsync(["node", "ask", "status"]);

    expect(stdout.text).toContain("Chrome: not running · port auto");
  });

  it.each(["background", "unknown"] as const)("renders headed Chrome placement as %s", async (placement) => {
    const runner = makeRunner();
    const report = await runner.status({ timeoutMs: 3000 });
    vi.mocked(runner.status).mockResolvedValue({
      ...report,
      session: {
        ...report.session,
        headless: false,
        placement
      }
    });
    const stdout = new BufferWriter();
    const program = makeProgram(runner, { stdout });

    await program.parseAsync(["node", "ask", "status"]);

    expect(stdout.text).toContain(`Chrome: running · ask-managed · ${placement} · port 9222`);
  });

  it("prints technical provider details and message-box status with --verbose", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const program = makeProgram(runner, { stdout });

    await program.parseAsync(["node", "ask", "status", "--verbose"]);

    expect(stdout.text).toContain("Chrome mode: headed");
    expect(stdout.text).toContain("Window placement: visible");
    expect(stdout.text).toContain("Session: ask-managed");
    expect(stdout.text).toContain("ChatGPT (chatgpt):");
    expect(stdout.text).toContain("Message box: available");
    expect(stdout.text).toContain("Gemini (gemini):");
    expect(stdout.text).toContain("Message box: not checked");
  });

  it("shows a guest provider as login required", async () => {
    const runner = makeRunner();
    const report = await runner.status({ timeoutMs: 3000 });
    vi.mocked(runner.status).mockResolvedValue({
      ...report,
      providers: report.providers.map((provider) =>
        provider.provider === "chatgpt"
          ? {
              ...provider,
              status: "login-required" as const,
              authState: "guest" as const,
              readyForHeadless: false,
              loggedInLikely: false,
              note: "ChatGPT is ready to send, but it appears signed out."
            }
          : provider
      )
    });
    const stdout = new BufferWriter();
    const program = makeProgram(runner, { stdout });

    await program.parseAsync(["node", "ask", "status"]);

    expect(stdout.text).toContain("ChatGPT   login required  guest");
  });

  it("routes command-local provider for status", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "status", "--provider", "gemini", "--timeout", "1000"]);

    expect(runner.status).toHaveBeenCalledWith({
      provider: "gemini",
      timeoutMs: 1000,
      verbose: undefined
    });
  });

  it("ignores ASK_PROVIDER when status has no explicit provider filter", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner, {
      env: { ASK_PROVIDER: "gemini" } as NodeJS.ProcessEnv
    });

    await program.parseAsync(["node", "ask", "status"]);

    expect(runner.status).toHaveBeenCalledWith({
      timeoutMs: 3000,
      verbose: undefined
    });
  });

  it("resumes a named conversation and allows --new to reset it", async () => {
    const runner = makeRunner();
    let program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "--conversation", "Release-Notes", "Draft", "this"]);

    expect(runner.ask).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: "chatgpt",
      prompt: "Draft this",
      conversationName: "release-notes",
      newSession: false
    }));

    program = makeProgram(runner);
    await program.parseAsync(["node", "ask", "--conversation", "release-notes", "--new", "Restart"]);
    expect(runner.ask).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationName: "release-notes",
      newSession: true
    }));
  });

  it("routes named conversations through open", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await program.parseAsync(["node", "ask", "open", "--conversation", "research", "Continue"]);

    expect(runner.open).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Continue",
      conversationName: "research",
      newSession: false
    }));
  });

  it("lists named conversations as JSON", async () => {
    const runner = makeRunner();
    vi.mocked(runner.listConversations).mockResolvedValue([{
      provider: "chatgpt",
      name: "release-notes",
      url: "https://chatgpt.com/c/release",
      updatedAt: "2026-07-15T12:00:00.000Z"
    }]);
    const stdout = new BufferWriter();
    const program = makeProgram(runner, { stdout });

    await program.parseAsync(["node", "ask", "conversations", "list", "--provider", "chatgpt", "--json"]);

    expect(runner.listConversations).toHaveBeenCalledWith("chatgpt");
    expect(JSON.parse(stdout.text)).toEqual([
      expect.objectContaining({ name: "release-notes", provider: "chatgpt" })
    ]);
  });

  it("forgets only the local named conversation", async () => {
    const runner = makeRunner();
    const stderr = new BufferWriter();
    const program = makeProgram(runner, { stderr });

    await program.parseAsync(["node", "ask", "conversations", "forget", "Release-Notes"]);

    expect(runner.forgetConversation).toHaveBeenCalledWith("release-notes", "chatgpt");
    expect(stderr.text).toContain("The provider chat was not deleted.");
  });

  it("rejects --conversation with --continue", async () => {
    const runner = makeRunner();
    const program = makeProgram(runner);

    await expect(program.parseAsync([
      "node", "ask", "--conversation", "release", "--continue", "Continue"
    ])).rejects.toMatchObject({ code: "commander.conflictingOption" });
    expect(runner.ask).not.toHaveBeenCalled();
  });

  it("does not advertise the unimplemented image output option", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const program = createProgram({
      runner,
      stdin: ttyStdin(),
      stdout,
      stderr
    });

    await expect(program.parseAsync(["node", "ask", "--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
      exitCode: 0
    });

    expect(stdout.text).not.toContain("--image-output");
    expect(runner.ask).not.toHaveBeenCalled();
  });
});
