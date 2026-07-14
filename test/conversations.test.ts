import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { createConversationContinuity, readLastConversationUrl, writeLastConversationUrl } from "../src/conversations";
import { providerRegistry } from "../src/providers";

describe("conversation state", () => {
  let askHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    askHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-conversations-"));
    env = { ASK_HOME: askHome } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    await fs.promises.rm(askHome, { recursive: true, force: true });
  });

  it("stores the last conversation separately for each provider", async () => {
    await writeLastConversationUrl(env, "chatgpt", "https://chatgpt.com/c/chat");
    await writeLastConversationUrl(env, "gemini", "https://gemini.google.com/app/gemini");

    await expect(readLastConversationUrl(env, "chatgpt")).resolves.toBe("https://chatgpt.com/c/chat");
    await expect(readLastConversationUrl(env, "gemini")).resolves.toBe("https://gemini.google.com/app/gemini");
  });

  it("returns undefined when no conversation state exists", async () => {
    await expect(readLastConversationUrl(env, "chatgpt")).resolves.toBeUndefined();
  });

  it("preserves both providers when state writes overlap", async () => {
    await Promise.all([
      writeLastConversationUrl(env, "chatgpt", "https://chatgpt.com/c/chat"),
      writeLastConversationUrl(env, "gemini", "https://gemini.google.com/app/gemini")
    ]);

    await expect(readLastConversationUrl(env, "chatgpt")).resolves.toBe("https://chatgpt.com/c/chat");
    await expect(readLastConversationUrl(env, "gemini")).resolves.toBe("https://gemini.google.com/app/gemini");
  });

  it("resolves requested, saved, restored, and fallback conversations in order", async () => {
    const continuity = createConversationContinuity(env);
    const provider = providerRegistry.chatgpt;
    const restoredPage = {
      url: () => "https://chatgpt.com/c/restored",
      evaluate: async () => true
    };
    const browser = {
      contexts: () => [{ pages: () => [restoredPage] }]
    } as unknown as Browser;

    await writeLastConversationUrl(env, "chatgpt", "https://chatgpt.com/c/saved");
    await expect(continuity.resolve(browser, provider, {
      requestedUrl: "https://chatgpt.com/c/requested",
      newSession: false
    })).resolves.toMatchObject({ url: "https://chatgpt.com/c/requested", newSession: false });
    await expect(continuity.resolve(browser, provider, {
      requestedUrl: provider.homeUrl,
      newSession: false
    })).resolves.toMatchObject({ url: "https://chatgpt.com/c/saved", preferredUrl: "https://chatgpt.com/c/saved" });

    await fs.promises.rm(path.join(askHome, "conversations.json"));
    await expect(continuity.resolve(browser, provider, {
      requestedUrl: provider.homeUrl,
      newSession: false
    })).resolves.toMatchObject({ url: "https://chatgpt.com/c/restored", newSession: false });

    const unavailable: string[] = [];
    const emptyBrowser = { contexts: () => [{ pages: () => [] }] } as unknown as Browser;
    await expect(continuity.resolve(emptyBrowser, provider, {
      requestedUrl: provider.homeUrl,
      newSession: false,
      onContinuationUnavailable: () => unavailable.push("called")
    })).resolves.toEqual({ newSession: true, url: provider.homeUrl });
    expect(unavailable).toEqual(["called"]);
  });
});
