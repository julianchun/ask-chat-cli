import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgram, type Runner } from "../src/cli";

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

function makeRunner(): Runner {
  return {
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
      provider: "chatgpt" as const,
      providerDisplayName: "ChatGPT",
      port: 9222,
      connected: true,
      sessionOwnership: "ask-managed" as const,
      headless: false,
      pageCount: 1,
      providerPageCount: 1,
      currentPageUrl: "https://chatgpt.com/",
      promptInputVisible: true,
      authState: "signed-in-likely" as const,
      readyToSend: true,
      readyForHeadless: true,
      loggedInLikely: true,
      note: "ChatGPT appears signed in and ready in the visible ask Chrome session."
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

    expect(stderr.text).toContain("⠋ ChatGPT · starting new conversation · 0s");
    expect(stderr.text).toContain("\r\x1b[2K");
    expect(stderr.text).toContain("✓ ChatGPT · new conversation · 0.0s\n");
    expect(stderr.text).toContain("↗ https://chatgpt.com/c/abc123\n\n");
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
    expect(stderr.text).toContain("Timed out waiting for ChatGPT");
    expect(exitCode).toBe(2);
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

  it("prints provider status", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const program = makeProgram(runner, { stdout });

    await program.parseAsync(["node", "ask", "status"]);

    expect(runner.status).toHaveBeenCalledWith({
      provider: "chatgpt" as const,
      timeoutMs: 3000,
      verbose: undefined
    });
    expect(stdout.text).toContain("Status: ready");
    expect(stdout.text).toContain("Provider: ChatGPT (chatgpt)");
    expect(stdout.text).toContain("Note:");
    expect(stdout.text).not.toContain("Chrome mode: visible");
  });

  it("prints technical provider status with --verbose", async () => {
    const runner = makeRunner();
    const stdout = new BufferWriter();
    const program = makeProgram(runner, { stdout });

    await program.parseAsync(["node", "ask", "status", "--verbose"]);

    expect(stdout.text).toContain("Status: ready");
    expect(stdout.text).toContain("Chrome mode: visible");
    expect(stdout.text).toContain("Session: ask-managed");
    expect(stdout.text).toContain("Auth: signed-in-likely");
    expect(stdout.text).toContain("Ready for headless: yes");
  });

  it("leads guest status with login required", async () => {
    const runner = makeRunner();
    vi.mocked(runner.status).mockResolvedValue({
      ...await runner.status({ timeoutMs: 3000 }),
      authState: "guest",
      readyToSend: true,
      readyForHeadless: false,
      loggedInLikely: false,
      note: "ChatGPT is ready to send, but it appears signed out."
    });
    const stdout = new BufferWriter();
    const program = makeProgram(runner, { stdout });

    await program.parseAsync(["node", "ask", "status"]);

    expect(stdout.text.startsWith("Status: login required\n")).toBe(true);
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



