import { DEFAULT_PROVIDER_NAME, getProvider, providerRegistry, type ProviderName } from "./providers";

export interface OpenTarget {
  url: string;
  prompt: string;
  openedConversation: boolean;
}

export const CHATGPT_HOME_URL = providerRegistry.chatgpt.homeUrl;

export function isChatGptConversationUrl(value: string | undefined): boolean {
  return providerRegistry.chatgpt.matchesConversationUrl(value);
}

export function isProviderConversationUrl(providerName: ProviderName, value: string | undefined): boolean {
  return getProvider(providerName).matchesConversationUrl(value);
}

export function resolveOpenTarget(
  first: string | undefined,
  rest: string[] = [],
  providerName: ProviderName = DEFAULT_PROVIDER_NAME
): OpenTarget {
  const provider = getProvider(providerName);
  if (provider.matchesConversationUrl(first)) {
    return {
      url: first as string,
      prompt: rest.join(" ").trim(),
      openedConversation: true
    };
  }

  const prompt = [first, ...rest].filter((part): part is string => Boolean(part)).join(" ").trim();
  return {
    url: provider.homeUrl,
    prompt,
    openedConversation: false
  };
}

export function combinePromptAndStdin(prompt: string, stdin: string): string {
  const trimmedPrompt = prompt.trim();
  const trimmedStdin = stdin.trim();

  if (trimmedPrompt && trimmedStdin) {
    return `${trimmedPrompt}\n\n${trimmedStdin}`;
  }

  return trimmedPrompt || trimmedStdin;
}

export function parseTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("--timeout must be a positive integer number of milliseconds");
  }
  return timeout;
}
