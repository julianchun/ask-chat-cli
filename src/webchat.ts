import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { AskFailure, type AskExecutionStage, type AskFailureCode } from "./errors";
import type { ProviderDefinition, ProviderName } from "./providers";

export type AuthState = "signed-in-likely" | "guest" | "login-required" | "blocked" | "unknown";

export interface ProviderPageInspection {
  promptInputVisible: boolean;
  authState: AuthState;
  readyToSend: boolean;
  readyForHeadless: boolean;
}

export interface WaitForResponseOptions {
  timeoutMs: number;
  stableMs?: number;
  pollMs?: number;
  baseline?: AssistantResponseBaseline;
}

export interface AssistantResponseBaseline {
  key?: string;
  text: string;
  count: number;
}

interface AssistantResponseObservation extends AssistantResponseBaseline {
  completionActionReady: boolean;
  busy: boolean;
}

export interface ResponseResult {
  text: string;
  timedOut: boolean;
  conversationUrl?: string;
}

export interface OpenChatPageOptions {
  newSession?: boolean;
}

export interface ProviderAutomation {
  inspectPage(page: Page, timeoutMs?: number): Promise<ProviderPageInspection>;
  attachFiles(page: Page, filePaths: string[]): Promise<void>;
  fillPrompt(page: Page, prompt: string, timeoutMs?: number): Promise<Locator>;
  submitPrompt(page: Page, input?: Locator, timeoutMs?: number): Promise<void>;
  extractLatestAssistantText(page: Page): Promise<string>;
  captureAssistantResponseBaseline(page: Page): Promise<AssistantResponseBaseline>;
  waitForAssistantCompletion(page: Page, options: WaitForResponseOptions): Promise<ResponseResult>;
  stopAssistantGeneration(page: Page): Promise<void>;
}

export interface ProviderAutomationConfig {
  name: ProviderName;
  displayName: string;
  promptInputSelectors: readonly string[];
  sendButtonSelectors: readonly string[];
  stopButtonSelectors: readonly string[];
  assistantResponseSelectors: readonly string[];
  assistantContentSelectors: readonly string[];
  assistantCompletionSelectors: readonly string[];
  assistantBusySelectors: readonly string[];
  fileInputSelectors: readonly string[];
  attachButtonSelectors: readonly string[];
  signInSelectors: readonly string[];
  accountSelectors: readonly string[];
  blockedSelectors: readonly string[];
}

export function createProviderAutomation(config: ProviderAutomationConfig): ProviderAutomation {
  return {
    inspectPage: (page, timeoutMs) => inspectProviderPage(page, config, timeoutMs),
    attachFiles: (page, filePaths) => attachFiles(page, config, filePaths),
    fillPrompt: (page, prompt, timeoutMs) => fillPrompt(page, config, prompt, timeoutMs),
    submitPrompt: (page, input, timeoutMs) => submitPrompt(page, config, input, timeoutMs),
    extractLatestAssistantText: (page) => extractLatestAssistantText(page, config),
    captureAssistantResponseBaseline: (page) => captureAssistantResponseBaseline(page, config),
    waitForAssistantCompletion: (page, options) => waitForAssistantCompletion(page, config, options),
    stopAssistantGeneration: (page) => stopAssistantGeneration(page, config)
  };
}

export function getDefaultContext(browser: Browser): BrowserContext {
  const existing = browser.contexts()[0];
  if (!existing) {
    throw new Error("No Chrome browser context was available over CDP.");
  }
  return existing;
}

export async function openChatPage(
  browser: Browser,
  provider: ProviderDefinition,
  url = provider.homeUrl,
  options: OpenChatPageOptions = {}
): Promise<Page> {
  const context = getDefaultContext(browser);
  const page = options.newSession ? await context.newPage() : selectReusableChatPage(context, provider, url) || (await context.newPage());
  await page.bringToFront();
  const reusingProviderConversation =
    sameUrl(url, provider.homeUrl) && provider.matchesConversationUrl(page.url());
  if (!sameUrl(page.url(), url) && !reusingProviderConversation) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
  await page.bringToFront();
  return page;
}

export async function openWorkerPage(
  browser: Browser,
  provider: ProviderDefinition,
  url = provider.homeUrl
): Promise<Page> {
  const context = getDefaultContext(browser);
  const page = await context.newPage();
  if (!sameUrl(page.url(), url)) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
  return page;
}

function selectReusableChatPage(
  context: BrowserContext,
  provider: ProviderDefinition,
  url: string,
  preferredUrl?: string
): Page | undefined {
  const pages = context.pages();
  const preferredPage = preferredUrl && pages.find((page) => sameUrl(page.url(), preferredUrl));
  if (preferredPage) {
    return preferredPage;
  }
  if (sameUrl(url, provider.homeUrl)) {
    return (
      pages.find((page) => provider.matchesConversationUrl(page.url())) ||
      pages.find((page) => sameUrl(page.url(), url)) ||
      pages.find((page) => provider.matchesPageUrl(page.url())) ||
      pages.find(isBlankPage)
    );
  }

  return pages.find((page) => sameUrl(page.url(), url)) || pages.find((page) => provider.matchesPageUrl(page.url())) || pages.find(isBlankPage);
}

function sameUrl(current: string, target: string): boolean {
  try {
    const currentUrl = new URL(current);
    const targetUrl = new URL(target);
    currentUrl.hash = "";
    targetUrl.hash = "";
    return currentUrl.href === targetUrl.href;
  } catch {
    return current === target;
  }
}

function isBlankPage(page: Page): boolean {
  return page.url() === "about:blank" || page.url() === "chrome://newtab/";
}

export function selectCurrentPage(
  browser: Browser,
  provider: ProviderDefinition,
  preferredUrl?: string
): Page {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const providerPages = pages.filter((page) => provider.matchesPageUrl(page.url()));
  const page =
    (preferredUrl && providerPages.find((candidate) => sameUrl(candidate.url(), preferredUrl))) ||
    providerPages.find((candidate) => provider.matchesConversationUrl(candidate.url())) ||
    providerPages.at(0);
  if (!page) {
    throw new Error(`No open ${provider.displayName} page was found. Run \`ask login --provider ${provider.name}\` first.`);
  }

  return page;
}

async function findPromptInput(
  page: Page,
  provider: ProviderAutomationConfig,
  timeoutMs = 30_000
): Promise<Locator> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of provider.promptInputSelectors) {
      const locator = page.locator(selector).last();
      try {
        if ((await locator.count()) > 0 && await locator.isVisible()) {
          return locator;
        }
      } catch {
        // The provider may be replacing the input while the page initializes.
      }
    }

    const textbox = page.getByRole("textbox").last();
    try {
      if ((await textbox.count()) > 0 && await textbox.isVisible()) {
        return textbox;
      }
    } catch {
      // Keep polling until the shared deadline.
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs > 0) {
      await page.waitForTimeout(Math.min(100, remainingMs));
    }
  }

  throw providerFailure(
    provider,
    "PROMPT_INPUT_NOT_FOUND",
    "prompt.find",
    `Could not find a visible ${provider.displayName} message box within ${timeoutMs}ms.`,
    `Run \`ask status --provider ${provider.name} --verbose\`.`,
    true
  );
}

async function hasPromptInput(
  page: Page,
  provider: ProviderAutomationConfig,
  timeoutMs = 3_000
): Promise<boolean> {
  const startedAt = Date.now();
  for (const selector of provider.promptInputSelectors) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      return false;
    }

    const locator = page.locator(selector).last();
    try {
      await locator.waitFor({ state: "visible", timeout: Math.min(remainingMs, 750) });
      return true;
    } catch {
      // Keep status checks quick and conservative.
    }
  }

  return false;
}

async function hasAnyVisible(page: Page, selectors: readonly string[], timeoutMs = 1_000): Promise<boolean> {
  const startedAt = Date.now();
  for (const selector of selectors) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return false;
    }

    const locator = page.locator(selector).last();
    try {
      await locator.waitFor({ state: "visible", timeout: Math.min(remainingMs, 500) });
      return true;
    } catch {
      // Try the next provider-specific signal.
    }
  }

  return false;
}

async function hasAnyAttached(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    try {
      if ((await page.locator(selector).count()) > 0) {
        return true;
      }
    } catch {
      // Try the next provider-specific signal.
    }
  }

  return false;
}

async function inspectProviderPage(
  page: Page,
  provider: ProviderAutomationConfig,
  timeoutMs = 3_000
): Promise<ProviderPageInspection> {
  const promptInputVisible = await hasPromptInput(page, provider, timeoutMs);
  let pageTitle = "";
  try {
    pageTitle = await page.title();
  } catch {
    // Some test and transitional pages do not expose a title yet.
  }
  const blocked =
    /just a moment/i.test(pageTitle) ||
    await hasAnyVisible(page, provider.blockedSelectors, 1_000);
  const signIn = await hasAnyVisible(page, provider.signInSelectors, 1_000);
  const account = await hasAnyAttached(page, provider.accountSelectors);

  let authState: AuthState = "unknown";
  if (blocked) {
    authState = "blocked";
  } else if (account && !signIn) {
    authState = "signed-in-likely";
  } else if (signIn && promptInputVisible) {
    authState = "guest";
  } else if (signIn) {
    authState = "login-required";
  }

  return {
    promptInputVisible,
    authState,
    readyToSend: promptInputVisible,
    readyForHeadless: promptInputVisible && authState === "signed-in-likely"
  };
}

const IMAGE_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".heic", ".heif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"
]);

const MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

async function attachFiles(
  page: Page,
  provider: ProviderAutomationConfig,
  filePaths: string[]
): Promise<void> {
  if (filePaths.length === 0) {
    return;
  }

  const resolvedPaths = filePaths.map((filePath) => path.resolve(filePath));
  for (const filePath of resolvedPaths) {
    if (!fs.existsSync(filePath)) {
      throw providerFailure(
        provider,
        "ATTACHMENT_INVALID",
        "attachment.upload",
        `Attachment file does not exist: ${filePath}`,
        "Check the attachment path, then try again.",
        false
      );
    }
    if (!fs.statSync(filePath).isFile()) {
      throw providerFailure(
        provider,
        "ATTACHMENT_INVALID",
        "attachment.upload",
        `Attachment path is not a regular file: ${filePath}`,
        "Choose a regular file instead of a directory, then try again.",
        false
      );
    }
  }

  const fileInputs = page.locator(provider.fileInputSelectors.join(", "));
  const compatibleInput = await selectCompatibleFileInput(fileInputs, resolvedPaths);
  if (compatibleInput) {
    try {
      if (compatibleInput.multiple || resolvedPaths.length === 1) {
        await compatibleInput.locator.setInputFiles(resolvedPaths);
        await page.waitForTimeout(750);
      } else {
        for (const filePath of resolvedPaths) {
          await compatibleInput.locator.setInputFiles(filePath);
          await page.waitForTimeout(750);
        }
      }
    } catch (error) {
      throw attachmentUploadError(provider, error);
    }
    return;
  }

  const attachButton = page.locator(provider.attachButtonSelectors.join(", ")).last();

  if ((await attachButton.count()) === 0) {
    throw providerFailure(
      provider,
      "ATTACHMENT_UPLOAD_FAILED",
      "attachment.upload",
      `Could not find a compatible file input or attach button for ${provider.displayName} attachment upload.`,
      `Run \`ask status --provider ${provider.name} --verbose\`.`,
      true
    );
  }

  try {
    const fileChooser = await openFileChooser(page, attachButton);
    if (fileChooser.isMultiple() || resolvedPaths.length === 1) {
      await fileChooser.setFiles(resolvedPaths);
      await page.waitForTimeout(750);
    } else {
      await fileChooser.setFiles(resolvedPaths[0]);
      await page.waitForTimeout(750);
      for (const filePath of resolvedPaths.slice(1)) {
        const nextChooser = await openFileChooser(page, attachButton);
        await nextChooser.setFiles(filePath);
        await page.waitForTimeout(750);
      }
    }
  } catch (error) {
    throw attachmentUploadError(provider, error);
  }
}

async function selectCompatibleFileInput(
  inputs: Locator,
  filePaths: string[]
): Promise<{ locator: Locator; multiple: boolean } | undefined> {
  const candidates: Array<{ locator: Locator; multiple: boolean; unrestricted: boolean }> = [];
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    const locator = inputs.nth(index);
    const accept = (await locator.getAttribute("accept"))?.trim() || "";
    if (!acceptsAllFiles(accept, filePaths)) {
      continue;
    }
    candidates.push({
      locator,
      multiple: (await locator.getAttribute("multiple")) !== null,
      unrestricted: isUnrestrictedAccept(accept)
    });
  }

  candidates.sort((left, right) => Number(right.unrestricted) - Number(left.unrestricted));
  return candidates[0];
}

function acceptsAllFiles(accept: string, filePaths: string[]): boolean {
  if (isUnrestrictedAccept(accept)) {
    return true;
  }
  const acceptedTypes = accept.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return filePaths.every((filePath) => acceptedTypes.some((acceptedType) => matchesAcceptedType(filePath, acceptedType)));
}

function isUnrestrictedAccept(accept: string): boolean {
  const normalized = accept.trim();
  return normalized === "" || normalized.split(",").some((value) => value.trim() === "*/*");
}

function matchesAcceptedType(filePath: string, acceptedType: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if (acceptedType.startsWith(".")) {
    return extension === acceptedType;
  }
  if (acceptedType === "image/*") {
    return IMAGE_EXTENSIONS.has(extension);
  }
  const mimeType = MIME_TYPES_BY_EXTENSION[extension];
  if (!mimeType) {
    return false;
  }
  if (acceptedType.endsWith("/*")) {
    return mimeType.startsWith(acceptedType.slice(0, -1));
  }
  return mimeType === acceptedType;
}

async function openFileChooser(page: Page, attachButton: Locator) {
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10_000 }),
    attachButton.click()
  ]);
  return fileChooser;
}

function attachmentUploadError(provider: ProviderAutomationConfig, error: unknown): Error {
  if (error instanceof AskFailure) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return providerFailure(
    provider,
    "ATTACHMENT_UPLOAD_FAILED",
    "attachment.upload",
    `${provider.displayName} could not attach the requested file${detail ? `: ${detail}` : "."}`,
    "Check that the file type is supported and try again.",
    true,
    error
  );
}

async function fillPrompt(
  page: Page,
  provider: ProviderAutomationConfig,
  prompt: string,
  timeoutMs = 30_000
): Promise<Locator> {
  const input = await findPromptInput(page, provider, timeoutMs);
  await input.click();
  try {
    await input.fill(prompt);
  } catch {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.insertText(prompt);
  }
  return input;
}

async function submitPrompt(
  page: Page,
  provider: ProviderAutomationConfig,
  input?: Locator,
  timeoutMs = 30_000
): Promise<void> {
  const startedAt = Date.now();
  do {
    let visibleSendButtonFound = false;
    for (const selector of provider.sendButtonSelectors) {
      const button = page.locator(selector).last();
      try {
        if ((await button.count()) > 0 && (await button.isVisible())) {
          visibleSendButtonFound = true;
          if (await button.isEnabled()) {
            await button.click();
            return;
          }
        }
      } catch {
        // Try the next send affordance.
      }
    }

    if (!visibleSendButtonFound) {
      break;
    }
    await page.waitForTimeout(250);
  } while (Date.now() - startedAt < timeoutMs);

  if (Date.now() - startedAt >= timeoutMs) {
    throw providerFailure(
      provider,
      "PROMPT_SUBMIT_FAILED",
      "prompt.submit",
      `${provider.displayName} send button remained disabled while attachments were processing.`,
      "Wait for attachments to finish processing, then try again.",
      true
    );
  }

  if (input) {
    await input.press("Enter");
    return;
  }

  await page.keyboard.press("Enter");
}

function providerFailure(
  provider: ProviderAutomationConfig,
  code: AskFailureCode,
  stage: AskExecutionStage,
  message: string,
  hint: string,
  retryable: boolean,
  cause?: unknown
): AskFailure {
  return new AskFailure({
    code,
    stage,
    provider: provider.name,
    providerDisplayName: provider.displayName,
    message,
    retryable,
    hint,
    cause
  });
}

async function extractLatestAssistantText(page: Page, provider: ProviderAutomationConfig): Promise<string> {
  return page.evaluate(
    ({ responseSelectors, contentSelectors }) => {
      const normalize = (value: string | null | undefined) =>
        (value || "")
          .replace(/\r\n/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

      const candidates = responseSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector))
      );

      for (const node of candidates.reverse()) {
        const nodeText = normalize(node.innerText || node.textContent);
        if (nodeText) {
          return nodeText;
        }

        const content = contentSelectors
          .map((selector) => node.querySelector<HTMLElement>(selector))
          .find((element): element is HTMLElement => Boolean(element));
        const text = normalize(content?.innerText || content?.textContent);
        if (text) {
          return text;
        }
      }

      return "";
    },
    {
      responseSelectors: [...provider.assistantResponseSelectors],
      contentSelectors: [...provider.assistantContentSelectors]
    }
  );
}

async function inspectLatestAssistantResponse(
  page: Page,
  provider: ProviderAutomationConfig
): Promise<AssistantResponseObservation> {
  return page.evaluate(
    ({ responseSelectors, contentSelectors, completionSelectors, busySelectors }) => {
      const normalize = (value: string | null | undefined) =>
        (value || "")
          .replace(/\r\n/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      const visible = (element: Element) => {
        const htmlElement = element as HTMLElement;
        return Boolean(htmlElement.offsetWidth || htmlElement.offsetHeight || htmlElement.getClientRects().length);
      };

      const allCandidates = Array.from(
        document.querySelectorAll<HTMLElement>(responseSelectors.join(", "))
      );
      const candidates = allCandidates.filter(
        (node) => !allCandidates.some((other) => other !== node && other.contains(node))
      );
      const node = candidates.at(-1);
      if (!node) {
        return { text: "", count: 0, completionActionReady: false, busy: false };
      }

      const turn = node.closest<HTMLElement>("section[data-turn-id]") || node;
      const indexedResponse = node.matches("[data-response-index]")
        ? node
        : node.querySelector<HTMLElement>("[data-response-index]");
      const key =
        node.getAttribute("data-message-id") ||
        turn.getAttribute("data-turn-id") ||
        indexedResponse?.getAttribute("data-response-index") ||
        `${node.tagName.toLowerCase()}:${candidates.length - 1}`;
      const content = contentSelectors
        .map((selector) => node.matches(selector) ? node : node.querySelector<HTMLElement>(selector))
        .find((element): element is HTMLElement => Boolean(element));
      const completionActionReady = completionSelectors.some((selector) =>
        Array.from(turn.querySelectorAll<HTMLElement>(selector)).some(
          (element) => visible(element) && !(element as HTMLButtonElement).disabled
        )
      );
      const busy = busySelectors.some((selector) =>
        Array.from(turn.querySelectorAll<HTMLElement>(selector)).some(visible)
      );

      return {
        key,
        text: normalize(content?.innerText || content?.textContent || node.innerText || node.textContent),
        count: candidates.length,
        completionActionReady,
        busy
      };
    },
    {
      responseSelectors: [...provider.assistantResponseSelectors],
      contentSelectors: [...provider.assistantContentSelectors],
      completionSelectors: [...provider.assistantCompletionSelectors],
      busySelectors: [...provider.assistantBusySelectors]
    }
  );
}

async function captureAssistantResponseBaseline(
  page: Page,
  provider: ProviderAutomationConfig
): Promise<AssistantResponseBaseline> {
  const observation = await inspectLatestAssistantResponse(page, provider);
  return { key: observation.key, text: observation.text, count: observation.count };
}

async function isStreaming(page: Page, provider: ProviderAutomationConfig): Promise<boolean> {
  for (const selector of provider.stopButtonSelectors) {
    try {
      const locator = page.locator(selector).last();
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        return true;
      }
    } catch {
      // Try the next stop affordance.
    }
  }

  return false;
}

async function stopAssistantGeneration(page: Page, provider: ProviderAutomationConfig): Promise<void> {
  for (const selector of provider.stopButtonSelectors) {
    try {
      const button = page.locator(selector).last();
      if ((await button.count()) > 0 && (await button.isVisible()) && (await button.isEnabled())) {
        await button.click();
        return;
      }
    } catch {
      // Stopping is best effort; closing the execution tab is the final cleanup.
    }
  }
}

async function waitForAssistantCompletion(
  page: Page,
  provider: ProviderAutomationConfig,
  options: WaitForResponseOptions
): Promise<ResponseResult> {
  const stableMs = options.stableMs ?? 4_000;
  const pollMs = options.pollMs ?? 500;
  const settleMs = provider.assistantCompletionSelectors.length > 0 ? Math.min(stableMs, 1_000) : stableMs;
  const startedAt = Date.now();
  let latestText = "";
  let lastChangeAt = Date.now();
  let sawNewResponse = !options.baseline;

  while (Date.now() - startedAt < options.timeoutMs) {
    const observation = await inspectLatestAssistantResponse(page, provider);
    const baseline = options.baseline;
    if (
      !sawNewResponse &&
      observation.text &&
      baseline &&
      (observation.count > baseline.count ||
        observation.key !== baseline.key ||
        observation.text !== baseline.text)
    ) {
      sawNewResponse = true;
      lastChangeAt = Date.now();
    }

    const text = sawNewResponse ? observation.text : "";
    const streaming = await isStreaming(page, provider) || observation.busy;

    if (text && text !== latestText) {
      latestText = text;
      lastChangeAt = Date.now();
    }

    const stableForMs = Date.now() - lastChangeAt;
    const hasCompletionContract = provider.assistantCompletionSelectors.length > 0;
    const providerReportsComplete = !hasCompletionContract || observation.completionActionReady;
    if (
      latestText &&
      !isTransientAssistantText(latestText) &&
      providerReportsComplete &&
      stableForMs >= settleMs &&
      !streaming
    ) {
      return { text: latestText, timedOut: false };
    }

    await page.waitForTimeout(pollMs);
  }

  return { text: latestText, timedOut: true };
}

function isTransientAssistantText(text: string): boolean {
  return /^(thinking|thinking\.{1,3}|思考中|正在思考)[…\.]*$/iu.test(text.trim());
}
