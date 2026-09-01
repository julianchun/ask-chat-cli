import { describe, expect, it } from "vitest";
import { parseProviderName, providerRegistry, resolveProviderName } from "../src/providers";

describe("providers", () => {
  it("parses valid provider names", () => {
    expect(parseProviderName("chatgpt")).toBe("chatgpt");
    expect(parseProviderName("gemini")).toBe("gemini");
  });

  it("rejects invalid provider names with a clear message", () => {
    expect(() => parseProviderName("claude")).toThrow('Unsupported provider "claude"');
    expect(() => parseProviderName("claude")).toThrow("chatgpt, gemini");
  });

  it("uses ASK_PROVIDER as the provider default", () => {
    expect(resolveProviderName(undefined, { ASK_PROVIDER: "gemini" } as NodeJS.ProcessEnv)).toBe("gemini");
  });

  it("lets explicit provider names override ASK_PROVIDER", () => {
    expect(resolveProviderName("chatgpt", { ASK_PROVIDER: "gemini" } as NodeJS.ProcessEnv)).toBe("chatgpt");
  });

  it("keeps provider page details behind the automation seam", () => {
    for (const provider of Object.values(providerRegistry)) {
      expect(provider).not.toHaveProperty("promptInputSelectors");
      expect(provider).not.toHaveProperty("assistantCompletionSelectors");
      expect(provider.automation).toMatchObject({
        inspectPage: expect.any(Function),
        fillPrompt: expect.any(Function),
        submitPrompt: expect.any(Function),
        waitForAssistantCompletion: expect.any(Function)
      });
    }
  });

  it("enables the evidence-driven execution adapter for every send-capable provider", () => {
    for (const [providerName, provider] of Object.entries(providerRegistry)) {
      expect(provider.execution).toMatchObject({
        provider: providerName,
        matchesConversationUrl: expect.any(Function),
        discoverCapabilities: expect.any(Function),
        attachAndVerify: expect.any(Function),
        fillAndVerifyDraft: expect.any(Function),
        preselectDispatch: expect.any(Function),
        observeSubmission: expect.any(Function),
        waitForResponse: expect.any(Function)
      });
    }
  });
});
