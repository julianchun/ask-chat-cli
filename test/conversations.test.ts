import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import {
  createConversationContinuity,
  forgetNamedConversation,
  listNamedConversations,
  readLastConversationUrl,
  readNamedConversationUrl,
  writeLastConversationUrl
} from "../src/conversations";
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

  it("creates, resumes, resets, lists, and forgets named conversations", async () => {
    const continuity = createConversationContinuity(env);
    const provider = providerRegistry.chatgpt;
    const browser = { contexts: () => [{ pages: () => [] }] } as unknown as Browser;
    const page = { url: () => "https://chatgpt.com/c/release" };

    await expect(continuity.resolve(browser, provider, {
      requestedUrl: provider.homeUrl,
      newSession: false,
      conversationName: "Release-Notes"
    })).resolves.toMatchObject({
      newSession: true,
      url: provider.homeUrl,
      conversationName: "release-notes"
    });

    await continuity.remember(provider, page as never, "release-notes");
    await expect(readNamedConversationUrl(env, "chatgpt", "release-notes")).resolves.toBe(
      "https://chatgpt.com/c/release"
    );
    await expect(continuity.resolve(browser, provider, {
      requestedUrl: provider.homeUrl,
      newSession: false,
      conversationName: "release-notes"
    })).resolves.toMatchObject({
      newSession: false,
      url: "https://chatgpt.com/c/release",
      conversationName: "release-notes"
    });
    await expect(continuity.resolve(browser, provider, {
      requestedUrl: provider.homeUrl,
      newSession: true,
      conversationName: "release-notes"
    })).resolves.toMatchObject({ newSession: true, url: provider.homeUrl });

    await expect(listNamedConversations(env, "chatgpt")).resolves.toEqual([
      expect.objectContaining({
        provider: "chatgpt",
        name: "release-notes",
        url: "https://chatgpt.com/c/release"
      })
    ]);
    await expect(forgetNamedConversation(env, "chatgpt", "release-notes")).resolves.toBe(true);
    await expect(readNamedConversationUrl(env, "chatgpt", "release-notes")).resolves.toBeUndefined();
  });

  it("migrates version 1 state when writing a named conversation", async () => {
    await fs.promises.writeFile(
      path.join(askHome, "conversations.json"),
      JSON.stringify({ version: 1, urls: { chatgpt: "https://chatgpt.com/c/legacy" } }),
      "utf8"
    );
    const continuity = createConversationContinuity(env);
    const page = { url: () => "https://gemini.google.com/app/research" };

    await continuity.remember(providerRegistry.gemini, page as never, "research");

    await expect(readLastConversationUrl(env, "chatgpt")).resolves.toBe("https://chatgpt.com/c/legacy");
    await expect(readNamedConversationUrl(env, "gemini", "research")).resolves.toBe(
      "https://gemini.google.com/app/research"
    );
    const state = JSON.parse(await fs.promises.readFile(path.join(askHome, "conversations.json"), "utf8"));
    expect(state.version).toBe(2);
  });

  it("keeps named conversations scoped by provider during concurrent writes", async () => {
    const continuity = createConversationContinuity(env);
    await Promise.all([
      continuity.remember(providerRegistry.chatgpt, { url: () => "https://chatgpt.com/c/shared" } as never, "shared"),
      continuity.remember(providerRegistry.gemini, { url: () => "https://gemini.google.com/app/shared" } as never, "shared")
    ]);

    await expect(readNamedConversationUrl(env, "chatgpt", "shared")).resolves.toBe("https://chatgpt.com/c/shared");
    await expect(readNamedConversationUrl(env, "gemini", "shared")).resolves.toBe("https://gemini.google.com/app/shared");
  });

  it("does not bind a name until the page has a valid provider conversation URL", async () => {
    const continuity = createConversationContinuity(env);

    await continuity.remember(
      providerRegistry.chatgpt,
      { url: () => "https://chatgpt.com/" } as never,
      "not-ready"
    );

    await expect(readNamedConversationUrl(env, "chatgpt", "not-ready")).resolves.toBeUndefined();
  });

  it("rejects two names for the same provider conversation URL", async () => {
    const continuity = createConversationContinuity(env);
    const page = { url: () => "https://chatgpt.com/c/shared" } as never;

    await continuity.remember(providerRegistry.chatgpt, page, "research");

    await expect(continuity.remember(providerRegistry.chatgpt, page, "notes")).rejects.toThrow(
      'already named "research"'
    );
    await expect(readNamedConversationUrl(env, "chatgpt", "notes")).resolves.toBeUndefined();
  });
});
