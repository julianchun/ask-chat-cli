import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Worker {
  child: WorkerChild;
  output: () => string;
  error: () => string;
  completed: Promise<number | null>;
}

type WorkerChild = ChildProcessByStdio<null, Readable, Readable>;

describe("execution queue across processes", () => {
  let askHome: string;
  const children: WorkerChild[] = [];

  beforeEach(async () => {
    askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-process-queue-"));
  });

  afterEach(async () => {
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
      child.kill("SIGKILL");
    })));
    children.length = 0;
    await fs.promises.rm(askHome, { recursive: true, force: true });
  });

  it("admits four workers, queues four, and rejects a ninth", async () => {
    const workers = Array.from({ length: 8 }, () => startWorker(askHome, 800));
    children.push(...workers.map((worker) => worker.child));

    await vi.waitFor(async () => {
      await expect(readCounts(askHome)).resolves.toEqual({ active: 4, queued: 4 });
    }, { timeout: 5_000, interval: 25 });

    const overflow = startWorker(askHome, 10);
    children.push(overflow.child);
    await expect(overflow.completed).resolves.toBe(1);
    expect(overflow.error()).toContain("execution queue is full (4 active, 4 waiting)");

    await expect(Promise.all(workers.map((worker) => worker.completed))).resolves.toEqual(
      Array.from({ length: 8 }, () => 0)
    );
    for (const worker of workers) {
      expect(worker.output()).toContain('"event":"acquired"');
      expect(worker.output()).toContain('"event":"released"');
    }
    await expect(readCounts(askHome)).resolves.toEqual({ active: 0, queued: 0 });
  }, 10_000);

  it("reclaims a slot after an active worker crashes", async () => {
    const active = Array.from({ length: 4 }, () => startWorker(askHome, 10_000));
    children.push(...active.map((worker) => worker.child));
    await vi.waitFor(async () => {
      await expect(readCounts(askHome)).resolves.toEqual({ active: 4, queued: 0 });
    }, { timeout: 5_000, interval: 25 });

    const waiting = startWorker(askHome, 10_000);
    children.push(waiting.child);
    await vi.waitFor(async () => {
      await expect(readCounts(askHome)).resolves.toEqual({ active: 4, queued: 1 });
    }, { timeout: 5_000, interval: 25 });

    active[0].child.kill("SIGKILL");
    await vi.waitFor(() => {
      expect(waiting.output()).toContain('"event":"acquired"');
    }, { timeout: 6_000, interval: 50 });
    await expect(readCounts(askHome)).resolves.toEqual({ active: 4, queued: 0 });
  }, 10_000);

  it("removes a queued worker when it is interrupted", async () => {
    const active = Array.from({ length: 4 }, () => startWorker(askHome, 10_000));
    children.push(...active.map((worker) => worker.child));
    await vi.waitFor(async () => {
      await expect(readCounts(askHome)).resolves.toEqual({ active: 4, queued: 0 });
    }, { timeout: 5_000, interval: 25 });

    const waiting = startWorker(askHome, 10_000);
    children.push(waiting.child);
    await vi.waitFor(async () => {
      await expect(readCounts(askHome)).resolves.toEqual({ active: 4, queued: 1 });
    }, { timeout: 5_000, interval: 25 });

    waiting.child.kill("SIGTERM");
    await waiting.completed;
    await vi.waitFor(async () => {
      await expect(readCounts(askHome)).resolves.toEqual({ active: 4, queued: 0 });
    }, { timeout: 5_000, interval: 25 });
  }, 10_000);

  it("keeps new executions queued while another process holds browser maintenance", async () => {
    const guard = startGuardWorker(askHome, "browser", 600);
    children.push(guard.child);
    await vi.waitFor(() => {
      expect(guard.output()).toContain('"event":"guard-acquired"');
    }, { timeout: 5_000, interval: 25 });

    const waiting = startWorker(askHome, 10);
    children.push(waiting.child);
    await vi.waitFor(async () => {
      await expect(readCounts(askHome)).resolves.toEqual({ active: 0, queued: 1 });
    }, { timeout: 5_000, interval: 25 });

    await expect(guard.completed).resolves.toBe(0);
    await expect(waiting.completed).resolves.toBe(0);
    expect(waiting.output()).toContain('"event":"acquired"');
  }, 10_000);

  it("keeps a matching conversation queued while another process forgets it", async () => {
    const guard = startGuardWorker(askHome, "conversation", 600, "chatgpt", "release");
    children.push(guard.child);
    await vi.waitFor(() => {
      expect(guard.output()).toContain('"event":"guard-acquired"');
    }, { timeout: 5_000, interval: 25 });

    const matching = startWorker(askHome, 10, "release");
    children.push(matching.child);
    await vi.waitFor(async () => {
      await expect(readCounts(askHome)).resolves.toEqual({ active: 0, queued: 1 });
    }, { timeout: 5_000, interval: 25 });

    await expect(guard.completed).resolves.toBe(0);
    await expect(matching.completed).resolves.toBe(0);
  }, 10_000);
});

function startWorker(askHome: string, holdMs: number, conversationName?: string): Worker {
  const fixture = path.join(__dirname, "fixtures", "execution-worker.cjs");
  const args = [fixture, "chatgpt", String(holdMs)];
  if (conversationName) {
    args.push(conversationName);
  }
  return startChild(askHome, args);
}

function startGuardWorker(
  askHome: string,
  kind: "browser" | "conversation",
  holdMs: number,
  provider = "chatgpt",
  conversationName = "release"
): Worker {
  const fixture = path.join(__dirname, "fixtures", "guard-worker.cjs");
  return startChild(askHome, [fixture, kind, String(holdMs), provider, conversationName]);
}

function startChild(askHome: string, args: string[]): Worker {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ASK_HOME: askHome },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    output: () => stdout,
    error: () => stderr,
    completed: new Promise((resolve) => child.once("close", resolve))
  };
}

async function readCounts(askHome: string): Promise<{ active: number; queued: number }> {
  const state = JSON.parse(
    await fs.promises.readFile(path.join(askHome, "executions.json"), "utf8")
  ) as { active: unknown[]; queued: unknown[] };
  return { active: state.active.length, queued: state.queued.length };
}
