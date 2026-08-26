import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeliveryAmbiguityPersistenceError,
  getDeliveryAmbiguityDirectory,
  listDeliveryAmbiguityMarkers,
  recordDeliveryAmbiguity
} from "../src/delivery-ambiguity";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("delivery ambiguity persistence", () => {
  it("writes a privacy-safe atomic record without prompt or page content", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-delivery-marker-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    const prompt = "private prompt body must never be persisted";
    try {
      const marker = await recordDeliveryAmbiguity({
        env,
        provider: "chatgpt",
        knownConversationUrl: "https://chatgpt.com/c/known-conversation",
        timeoutMs: 1_000,
        resolveTargetId: async () => "cdp-target-1",
        resolveSessionGeneration: async () => "session-generation-1"
      });
      expect(marker).toMatchObject({
        version: 1,
        provider: "chatgpt",
        targetId: "cdp-target-1",
        conversationUrl: "https://chatgpt.com/c/known-conversation",
        sessionGeneration: "session-generation-1"
      });
      const records = await listDeliveryAmbiguityMarkers(env);
      expect(records).toHaveLength(1);
      const files = await fs.promises.readdir(getDeliveryAmbiguityDirectory(env));
      const contents = await fs.promises.readFile(
        path.join(getDeliveryAmbiguityDirectory(env), files[0]!),
        "utf8"
      );
      expect(contents).not.toContain(prompt);
      expect(JSON.parse(contents)).toEqual({
        version: 1,
        provider: "chatgpt",
        targetId: "cdp-target-1",
        conversationUrl: "https://chatgpt.com/c/known-conversation",
        sessionGeneration: "session-generation-1",
        createdAt: expect.any(String)
      });
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });

  it("fails closed when marker publication cannot be completed", async () => {
    const askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-delivery-marker-fail-"));
    const env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(((filePath: fs.PathLike, flags: string | number) => {
      if (String(filePath).includes("delivery-ambiguities")) {
        return Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
      }
      return Reflect.apply(originalOpen, fs.promises, [filePath, flags]);
    }) as typeof fs.promises.open);
    try {
      await expect(recordDeliveryAmbiguity({
        env,
        provider: "gemini",
        timeoutMs: 1_000,
        resolveTargetId: async () => "cdp-target-2",
        resolveSessionGeneration: async () => "session-generation-2"
      })).rejects.toBeInstanceOf(DeliveryAmbiguityPersistenceError);
    } finally {
      await fs.promises.rm(askHome, { recursive: true, force: true });
    }
  });
});
