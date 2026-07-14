import fs from "node:fs";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { getAskHome } from "./config";
import type { ProviderDefinition, ProviderName } from "./providers";

interface ConversationState {
  version: 1;
  urls: Partial<Record<ProviderName, string>>;
}

function getConversationStatePath(env: NodeJS.ProcessEnv): string {
  return path.join(getAskHome(env), "conversations.json");
}

function getConversationLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(getAskHome(env), "conversations.lock");
}

export interface ConversationResolution {
  newSession: boolean | undefined;
  url: string;
  preferredUrl?: string;
}

export interface ConversationContinuity {
  resolve(
    browser: Browser,
    provider: ProviderDefinition,
    request: {
      requestedUrl: string;
      newSession?: boolean;
      onContinuationUnavailable?: () => void;
    }
  ): Promise<ConversationResolution>;
  preferredUrl(provider: ProviderDefinition): Promise<string | undefined>;
  remember(provider: ProviderDefinition, page: Page): Promise<void>;
}

export function createConversationContinuity(env: NodeJS.ProcessEnv = process.env): ConversationContinuity {
  return {
    resolve: (browser, provider, request) => resolveConversation(browser, provider, env, request),
    preferredUrl: async (provider) => {
      const savedUrl = await readLastConversationUrl(env, provider.name);
      return savedUrl && provider.matchesConversationUrl(savedUrl) ? savedUrl : undefined;
    },
    remember: async (provider, page) => {
      const url = page.url();
      if (provider.matchesConversationUrl(url)) {
        await writeLastConversationUrl(env, provider.name, url);
      }
    }
  };
}

async function resolveConversation(
  browser: Browser,
  provider: ProviderDefinition,
  env: NodeJS.ProcessEnv,
  request: {
    requestedUrl: string;
    newSession?: boolean;
    onContinuationUnavailable?: () => void;
  }
): Promise<ConversationResolution> {
  const savedUrl = await readLastConversationUrl(env, provider.name);
  const preferredUrl = savedUrl && provider.matchesConversationUrl(savedUrl) ? savedUrl : undefined;

  if (request.newSession !== false) {
    return { newSession: request.newSession, url: request.requestedUrl, preferredUrl };
  }

  if (provider.matchesConversationUrl(request.requestedUrl)) {
    return { newSession: false, url: request.requestedUrl, preferredUrl };
  }

  if (preferredUrl) {
    return { newSession: false, url: preferredUrl, preferredUrl };
  }

  const conversationPages = browser.contexts().flatMap((context) =>
    context.pages().filter((page) => provider.matchesConversationUrl(page.url()))
  );
  for (const page of conversationPages) {
    try {
      if (await page.evaluate(() => document.visibilityState === "visible")) {
        return { newSession: false, url: page.url(), preferredUrl: page.url() };
      }
    } catch {
      // Try another restored conversation page.
    }
  }
  if (conversationPages.length > 0) {
    return { newSession: false, url: conversationPages[0].url(), preferredUrl: conversationPages[0].url() };
  }

  request.onContinuationUnavailable?.();
  return { newSession: true, url: provider.homeUrl };
}

export async function readLastConversationUrl(
  env: NodeJS.ProcessEnv,
  provider: ProviderName
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(getConversationStatePath(env), "utf8")
    ) as Partial<ConversationState>;
    const url = parsed.version === 1 ? parsed.urls?.[provider] : undefined;
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function writeLastConversationUrl(
  env: NodeJS.ProcessEnv,
  provider: ProviderName,
  url: string
): Promise<void> {
  await withConversationStateLock(env, async () => {
    const statePath = getConversationStatePath(env);
    let urls: Partial<Record<ProviderName, string>> = {};
    try {
      const parsed = JSON.parse(await fs.promises.readFile(statePath, "utf8")) as Partial<ConversationState>;
      if (parsed.version === 1 && parsed.urls && typeof parsed.urls === "object") {
        urls = parsed.urls;
      }
    } catch {
      // Start a new state file.
    }

    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(
        temporaryPath,
        `${JSON.stringify({ version: 1, urls: { ...urls, [provider]: url } }, null, 2)}\n`,
        "utf8"
      );
      await fs.promises.rename(temporaryPath, statePath);
    } finally {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });
}

async function withConversationStateLock<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const lockPath = getConversationLockPath(env);
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 2_000;
  let handle: fs.promises.FileHandle | undefined;

  while (!handle) {
    try {
      handle = await fs.promises.open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) {
          await fs.promises.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting to update conversation state.");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
  }
}
