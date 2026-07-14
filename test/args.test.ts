import { describe, expect, it } from "vitest";
import { combinePromptAndStdin, isChatGptConversationUrl, isProviderConversationUrl, parseTimeout, resolveOpenTarget } from "../src/args";

describe("args", () => {
  it("detects ChatGPT conversation URLs", () => {
    expect(isChatGptConversationUrl("https://chatgpt.com/c/abc123")).toBe(true);
    expect(isChatGptConversationUrl("https://chatgpt.com/")).toBe(false);
    expect(isChatGptConversationUrl("https://example.com/c/abc123")).toBe(false);
    expect(isChatGptConversationUrl("not a url")).toBe(false);
  });

  it("detects provider-specific conversation URLs", () => {
    expect(isProviderConversationUrl("gemini", "https://gemini.google.com/app/abc123")).toBe(true);
    expect(isProviderConversationUrl("gemini", "https://gemini.google.com/app")).toBe(false);
    expect(isProviderConversationUrl("gemini", "https://chatgpt.com/c/abc123")).toBe(false);
  });

  it("resolves open targets", () => {
    expect(resolveOpenTarget("https://chatgpt.com/c/abc123", ["continue", "this"])).toEqual({
      url: "https://chatgpt.com/c/abc123",
      prompt: "continue this",
      openedConversation: true
    });

    expect(resolveOpenTarget("Plan", ["this", "diff"])).toEqual({
      url: "https://chatgpt.com/",
      prompt: "Plan this diff",
      openedConversation: false
    });
  });

  it("resolves Gemini open targets", () => {
    expect(resolveOpenTarget("https://gemini.google.com/app/abc123", ["continue"], "gemini")).toEqual({
      url: "https://gemini.google.com/app/abc123",
      prompt: "continue",
      openedConversation: true
    });

    expect(resolveOpenTarget("Plan", ["this"], "gemini")).toEqual({
      url: "https://gemini.google.com/app",
      prompt: "Plan this",
      openedConversation: false
    });
  });

  it("combines positional prompts and stdin", () => {
    expect(combinePromptAndStdin("Plan this", "diff text")).toBe("Plan this\n\ndiff text");
    expect(combinePromptAndStdin("Plan this", "")).toBe("Plan this");
    expect(combinePromptAndStdin("", "diff text")).toBe("diff text");
  });

  it("parses positive integer timeouts", () => {
    expect(parseTimeout("600000")).toBe(600000);
    expect(() => parseTimeout("0")).toThrow("--timeout");
    expect(() => parseTimeout("abc")).toThrow("--timeout");
  });
});
