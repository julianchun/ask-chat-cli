import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionQueue,
  getExecutionStatePath,
  type ExecutionLease
} from "../src/execution-queue";

describe("execution queue", () => {
  let askHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-executions-"));
    env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    await fs.promises.rm(askHome, { recursive: true, force: true });
  });

  function makeQueue(options: Parameters<typeof createExecutionQueue>[1] = {}) {
    return createExecutionQueue(env, {
      pollMs: 5,
      handleSignals: false,
      getProcessInfo: async (pid) => ({ pid, creationTime: "test-process" }),
      ...options
    });
  }

  it("admits four executions and queues the next four", async () => {
    const queue = makeQueue();
    const active = await Promise.all(
      Array.from({ length: 4 }, () => queue.acquire({ provider: "chatgpt" }))
    );
    const waiting = Array.from({ length: 4 }, () => queue.acquire({ provider: "chatgpt" }));

    await vi.waitFor(async () => {
      await expect(queue.inspect()).resolves.toEqual({ active: 4, queued: 4 });
    });
    await expect(queue.acquire({ provider: "gemini" })).rejects.toThrow(
      "execution queue is full (4 active, 4 waiting)"
    );

    await Promise.all(active.map((lease) => lease.release()));
    const promoted = await Promise.all(waiting);
    await Promise.all(promoted.map((lease) => lease.release()));
    await expect(queue.inspect()).resolves.toEqual({ active: 0, queued: 0 });
  });

  it("starts the oldest eligible request without blocking another conversation", async () => {
    const queue = makeQueue({ maxActive: 2 });
    const first = await queue.acquire({ provider: "chatgpt", conversationName: "research" });
    const blocked = queue.acquire({ provider: "chatgpt", conversationName: "research" });
    await vi.waitFor(async () => {
      await expect(queue.inspect()).resolves.toEqual({ active: 1, queued: 1 });
    });
    const independent = await queue.acquire({ provider: "chatgpt", conversationName: "notes" });

    await vi.waitFor(async () => {
      await expect(queue.inspect()).resolves.toEqual({ active: 2, queued: 1 });
    });
    await independent.release();
    await expect(queue.inspect()).resolves.toEqual({ active: 1, queued: 1 });

    await first.release();
    const promoted = await blocked;
    await promoted.release();
  });

  it("treats continue as an exclusive barrier for its provider", async () => {
    const queue = makeQueue({ maxActive: 2 });
    const chat = await queue.acquire({ provider: "chatgpt" });
    const secondChat = await queue.acquire({ provider: "chatgpt" });
    const continued = queue.acquire({ provider: "chatgpt", exclusiveProvider: true });
    await vi.waitFor(async () => {
      await expect(queue.inspect()).resolves.toEqual({ active: 2, queued: 1 });
    });
    const laterChat = queue.acquire({ provider: "chatgpt" });

    await vi.waitFor(async () => {
      await expect(queue.inspect()).resolves.toEqual({ active: 2, queued: 2 });
    });
    await chat.release();
    await expect(queue.inspect()).resolves.toEqual({ active: 1, queued: 2 });
    await secondChat.release();
    const continueLease = await continued;
    await expect(queue.inspect()).resolves.toEqual({ active: 1, queued: 1 });
    await continueLease.release();
    const laterLease = await laterChat;
    await laterLease.release();
  });

  it("removes a request that exceeds the queue wait timeout", async () => {
    const queue = makeQueue({ maxActive: 1, waitTimeoutMs: 30 });
    const active = await queue.acquire({ provider: "chatgpt" });

    await expect(queue.acquire({ provider: "gemini" })).rejects.toThrow(
      "timed out after 1 seconds waiting for an execution slot"
    );
    await expect(queue.inspect()).resolves.toEqual({ active: 1, queued: 0 });
    await active.release();
  });

  it("does not run visible and headless executions at the same time", async () => {
    const queue = makeQueue({ maxActive: 2 });
    const visible = await queue.acquire({ provider: "chatgpt" });
    const headless = queue.acquire({ provider: "gemini", headless: true });

    await vi.waitFor(async () => {
      await expect(queue.inspect()).resolves.toEqual({ active: 1, queued: 1 });
    });
    await visible.release();
    const promoted = await headless;
    await promoted.release();
  });

  it("holds an exclusive browser lease across maintenance without consuming an execution slot", async () => {
    const queue = makeQueue();
    const active = await queue.acquire({ provider: "chatgpt" });

    await expect(queue.acquireBrowserLease({
      headless: false,
      exclusive: true,
      action: "log in"
    })).rejects.toThrow("cannot log in while 1 browser operation is active");

    await active.release();
    const maintenance = await queue.acquireBrowserLease({
      headless: false,
      exclusive: true,
      action: "log in"
    });
    const waiting = queue.acquire({ provider: "gemini" });
    await vi.waitFor(async () => {
      await expect(queue.inspect()).resolves.toEqual({ active: 0, queued: 1 });
    });

    await maintenance.release();
    const promoted = await waiting;
    await promoted.release();
  });

  it("can wait for active executions before an exclusive browser transition", async () => {
    const queue = makeQueue({ waitTimeoutMs: 500 });
    const active = await queue.acquire({ provider: "chatgpt" });
    let acquired = false;
    const maintenancePromise = queue.acquireBrowserLease({
      headless: false,
      exclusive: true,
      waitForIdle: true,
      timeoutMs: 500,
      action: "log in"
    }).then((lease) => {
      acquired = true;
      return lease;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acquired).toBe(false);

    const waiting = queue.acquire({ provider: "gemini" });
    await vi.waitFor(async () => {
      await expect(queue.inspect()).resolves.toEqual({ active: 1, queued: 1 });
    });

    await active.release();
    const maintenance = await maintenancePromise;
    expect(acquired).toBe(true);
    await expect(queue.inspect()).resolves.toEqual({ active: 0, queued: 1 });

    await maintenance.release();
    const promoted = await waiting;
    await promoted.release();
  });

  it("allows same-mode browser reads and blocks incompatible mode transitions atomically", async () => {
    const queue = makeQueue();
    const visible = await queue.acquire({ provider: "chatgpt" });
    const read = await queue.acquireBrowserLease({
      headless: false,
      action: "read from Chrome"
    });

    await expect(queue.acquireBrowserLease({
      headless: true,
      action: "read from Chrome"
    })).rejects.toThrow("incompatible browser mode");

    await visible.release();
    const headlessExecution = queue.acquire({ provider: "gemini", headless: true });
    await vi.waitFor(async () => {
      await expect(queue.inspect()).resolves.toEqual({ active: 0, queued: 1 });
    });

    await read.release();
    const promoted = await headlessExecution;
    await promoted.release();
  });

  it("serializes provider readiness leadership without blocking another provider", async () => {
    const queue = makeQueue({ waitTimeoutMs: 500 });
    const leader = await queue.acquireProviderReadinessLease("chatgpt");
    let followerAcquired = false;
    const follower = queue.acquireProviderReadinessLease("chatgpt").then((lease) => {
      followerAcquired = true;
      return lease;
    });

    const gemini = await queue.acquireProviderReadinessLease("gemini");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(followerAcquired).toBe(false);

    await leader.release();
    const nextLeader = await follower;
    expect(followerAcquired).toBe(true);
    await Promise.all([nextLeader.release(), gemini.release()]);
  });

  it("reclaims a provider readiness guard owned by a dead process", async () => {
    await fs.promises.writeFile(
      getExecutionStatePath(env),
      JSON.stringify({
        version: 1,
        active: [],
        queued: [],
        guards: [{
          id: "dead-readiness",
          pid: 99991,
          processCreationTime: "dead-process",
          processCheckedAt: 0,
          createdAt: 0,
          kind: "provider-readiness",
          provider: "chatgpt"
        }]
      }),
      "utf8"
    );
    const queue = createExecutionQueue(env, {
      pollMs: 5,
      handleSignals: false,
      getProcessInfo: async (pid) => pid === process.pid
        ? { pid, creationTime: "test-process" }
        : undefined
    });

    const lease = await queue.acquireProviderReadinessLease("chatgpt");
    await lease.release();
  });

  it("holds a conversation lease across forget so matching admission cannot race deletion", async () => {
    const queue = makeQueue({ maxActive: 2 });
    const forgetting = await queue.acquireConversationLease("chatgpt", "release");
    const matching = queue.acquire({ provider: "chatgpt", conversationName: "release" });
    const unrelated = await queue.acquire({ provider: "chatgpt", conversationName: "notes" });

    await vi.waitFor(async () => {
      await expect(queue.inspect()).resolves.toEqual({ active: 1, queued: 1 });
    });
    await expect(queue.acquireConversationLease("chatgpt", "release")).rejects.toThrow(
      "active or queued execution"
    );

    await forgetting.release();
    const promoted = await matching;
    await unrelated.release();
    await promoted.release();
  });

  it("removes entries owned by dead processes", async () => {
    await fs.promises.writeFile(
      getExecutionStatePath(env),
      JSON.stringify({
        version: 1,
        active: [entry("dead-active", 99991)],
        queued: [entry("dead-queued", 99992)]
      }),
      "utf8"
    );
    const queue = createExecutionQueue(env, {
      getProcessInfo: async () => undefined
    });

    await expect(queue.inspect()).resolves.toEqual({ active: 0, queued: 0 });
  });

  it("retains a live entry when process metadata is temporarily unavailable", async () => {
    await fs.promises.writeFile(
      getExecutionStatePath(env),
      JSON.stringify({
        version: 1,
        active: [entry("live-but-uninspectable", process.pid)],
        queued: []
      }),
      "utf8"
    );
    const queue = createExecutionQueue(env, {
      getProcessInfo: async () => undefined
    });

    await expect(queue.inspect()).resolves.toEqual({ active: 1, queued: 0 });
  });

  it("releases a lease idempotently", async () => {
    const queue = makeQueue();
    const lease: ExecutionLease = await queue.acquire({ provider: "chatgpt" });

    await lease.release();
    await lease.release();

    await expect(queue.inspect()).resolves.toEqual({ active: 0, queued: 0 });
  });
});

function entry(id: string, pid: number) {
  return {
    id,
    pid,
    processCreationTime: "old-process",
    processCheckedAt: 0,
    provider: "chatgpt",
    exclusiveProvider: false,
    headless: false,
    createdAt: 0,
    activatedAt: 0
  };
}
