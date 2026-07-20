import fs from "node:fs";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { getAskHome } from "./config";
import type { ProviderDefinition, ProviderName } from "./providers";

interface ConversationStateV1 {
  version: 1;
  urls: Partial<Record<ProviderName, string>>;
}

interface StoredNamedConversation {
  url: string;
  updatedAt: string;
}

interface ConversationStateV2 {
  version: 2;
  lastUrls: Partial<Record<ProviderName, string>>;
  named: Partial<Record<ProviderName, Record<string, StoredNamedConversation>>>;
}

export interface NamedConversation extends StoredNamedConversation {
  name: string;
  provider: ProviderName;
}

function emptyState(): ConversationStateV2 {
  return { version: 2, lastUrls: {}, named: {} };
}

function getConversationStatePath(env: NodeJS.ProcessEnv): string {
  return path.join(getAskHome(env), "conversations.json");
}

function getConversationLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(getAskHome(env), "conversations.lock");
}

export function normalizeConversationName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(
      "Conversation names must be 1-64 characters and contain only lowercase letters, numbers, dots, underscores, or hyphens."
    );
  }
  return name;
}

export interface ConversationResolution {
  newSession: boolean | undefined;
  url: string;
  preferredUrl?: string;
  conversationName?: string;
}

export interface ConversationContinuity {
  resolve(
    browser: Browser,
    provider: ProviderDefinition,
    request: {
      requestedUrl: string;
      newSession?: boolean;
      conversationName?: string;
      onContinuationUnavailable?: () => void;
    }
  ): Promise<ConversationResolution>;
  preferredUrl(provider: ProviderDefinition): Promise<string | undefined>;
  remember(provider: ProviderDefinition, page: Page, conversationName?: string): Promise<void>;
  list(provider?: ProviderName): Promise<NamedConversation[]>;
  forget(provider: ProviderName, name: string): Promise<boolean>;
}

export function createConversationContinuity(env: NodeJS.ProcessEnv = process.env): ConversationContinuity {
  return {
    resolve: (browser, provider, request) => resolveConversation(browser, provider, env, request),
    preferredUrl: async (provider) => {
      const savedUrl = await readLastConversationUrl(env, provider.name);
      return savedUrl && provider.matchesConversationUrl(savedUrl) ? savedUrl : undefined;
    },
    remember: async (provider, page, conversationName) => {
      const url = page.url();
      if (provider.matchesConversationUrl(url)) {
        await rememberConversationUrl(env, provider.name, url, conversationName);
      }
    },
    list: (provider) => listNamedConversations(env, provider),
    forget: (provider, name) => forgetNamedConversation(env, provider, name)
  };
}

async function resolveConversation(
  browser: Browser,
  provider: ProviderDefinition,
  env: NodeJS.ProcessEnv,
  request: {
    requestedUrl: string;
    newSession?: boolean;
    conversationName?: string;
    onContinuationUnavailable?: () => void;
  }
): Promise<ConversationResolution> {
  const savedUrl = await readLastConversationUrl(env, provider.name);
  const preferredUrl = savedUrl && provider.matchesConversationUrl(savedUrl) ? savedUrl : undefined;
  const conversationName = request.conversationName
    ? normalizeConversationName(request.conversationName)
    : undefined;

  if (conversationName) {
    if (request.newSession !== true && provider.matchesConversationUrl(request.requestedUrl)) {
      return { newSession: false, url: request.requestedUrl, preferredUrl, conversationName };
    }

    if (request.newSession !== true) {
      const namedUrl = await readNamedConversationUrl(env, provider.name, conversationName);
      if (namedUrl && provider.matchesConversationUrl(namedUrl)) {
        return { newSession: false, url: namedUrl, preferredUrl: namedUrl, conversationName };
      }
    }

    return {
      newSession: true,
      url: provider.matchesConversationUrl(request.requestedUrl) ? provider.homeUrl : request.requestedUrl,
      preferredUrl,
      conversationName
    };
  }

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

async function readConversationState(env: NodeJS.ProcessEnv): Promise<ConversationStateV2> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(getConversationStatePath(env), "utf8")) as
      | Partial<ConversationStateV1>
      | Partial<ConversationStateV2>;
    if (parsed.version === 2) {
      const state = parsed as Partial<ConversationStateV2>;
      return {
        version: 2,
        lastUrls: state.lastUrls && typeof state.lastUrls === "object" ? state.lastUrls : {},
        named: state.named && typeof state.named === "object" ? state.named : {}
      };
    }
    if (parsed.version === 1) {
      const state = parsed as Partial<ConversationStateV1>;
      return {
        version: 2,
        lastUrls: state.urls && typeof state.urls === "object" ? state.urls : {},
        named: {}
      };
    }
  } catch {
    // Missing or invalid state starts empty.
  }
  return emptyState();
}

export async function readLastConversationUrl(
  env: NodeJS.ProcessEnv,
  provider: ProviderName
): Promise<string | undefined> {
  return (await readConversationState(env)).lastUrls[provider];
}

export async function readNamedConversationUrl(
  env: NodeJS.ProcessEnv,
  provider: ProviderName,
  name: string
): Promise<string | undefined> {
  const entry = (await readConversationState(env)).named[provider]?.[normalizeConversationName(name)];
  return entry && typeof entry.url === "string" ? entry.url : undefined;
}

export async function writeLastConversationUrl(
  env: NodeJS.ProcessEnv,
  provider: ProviderName,
  url: string
): Promise<void> {
  await updateConversationState(env, (state) => {
    state.lastUrls[provider] = url;
  });
}

async function rememberConversationUrl(
  env: NodeJS.ProcessEnv,
  provider: ProviderName,
  url: string,
  conversationName?: string
): Promise<void> {
  await updateConversationState(env, (state) => {
    state.lastUrls[provider] = url;
    if (conversationName) {
      const name = normalizeConversationName(conversationName);
      const entries = state.named[provider] || {};
      const existingAlias = Object.entries(entries).find(
        ([entryName, entry]) => entryName !== name && entry.url === url
      );
      if (existingAlias) {
        throw new Error(
          `Conversation URL is already named "${existingAlias[0]}" for ${provider}; one URL cannot have multiple names.`
        );
      }
      entries[name] = { url, updatedAt: new Date().toISOString() };
      state.named[provider] = entries;
    }
  });
}

export async function listNamedConversations(
  env: NodeJS.ProcessEnv,
  provider?: ProviderName
): Promise<NamedConversation[]> {
  const state = await readConversationState(env);
  const providers: ProviderName[] = provider ? [provider] : ["chatgpt", "gemini"];
  return providers
    .flatMap((providerName) => Object.entries(state.named[providerName] || {}).map(([name, entry]) => ({
      name,
      provider: providerName,
      url: entry.url,
      updatedAt: entry.updatedAt
    })))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function forgetNamedConversation(
  env: NodeJS.ProcessEnv,
  provider: ProviderName,
  name: string
): Promise<boolean> {
  let removed = false;
  await updateConversationState(env, (state) => {
    const entries = state.named[provider];
    const normalizedName = normalizeConversationName(name);
    if (entries && Object.prototype.hasOwnProperty.call(entries, normalizedName)) {
      delete entries[normalizedName];
      removed = true;
    }
  });
  return removed;
}

async function updateConversationState(
  env: NodeJS.ProcessEnv,
  update: (state: ConversationStateV2) => void
): Promise<void> {
  await withConversationStateLock(env, async () => {
    const statePath = getConversationStatePath(env);
    const state = await readConversationState(env);
    update(state);
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
