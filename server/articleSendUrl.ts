import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { fetchAndExtractArticle, type FetchArticleOptions, type FetchArticleResult } from "./articleFetcher.js";
import {
  type AuthHelpers
} from "./auth.js";
import {
  type AuthStore,
  type KindleDelivery,
  type LibraryItem,
  type UserProfile
} from "./authStore.js";
import { type AppConfig, type SmtpConfig } from "./config.js";
import { generateKindleFile, saveKindlePdf } from "./kindleFile.js";
import { sendFileToKindle } from "./mailer.js";
import { type PdfAnalysisVerdict, shouldAutoSendPdf } from "./pdfAnalyzer.js";

export type SendMode = "auto" | "force" | "none";

export interface SendArticleByUrlInput {
  user: UserProfile;
  url: string;
  title?: string;
  sendMode: SendMode;
}

export interface SendArticleByUrlResult {
  kind: "article" | "pdf";
  libraryItemId: string;
  filename: string;
  mimeType: string;
  sourceUrl: string;
  title: string;
  deduped: boolean;
  delivery: KindleDelivery | null;
  pdfVerdict?: PdfAnalysisVerdict;
}

export interface SendArticleByUrlDeps {
  store: AuthStore;
  config: AppConfig;
  log: FastifyBaseLogger;
  fetchAndExtractArticle: (url: string, options?: FetchArticleOptions) => Promise<FetchArticleResult>;
  generateKindleFile: typeof generateKindleFile;
  saveKindlePdf: typeof saveKindlePdf;
  sendFileToKindle: typeof sendFileToKindle;
}

export function isValidSendMode(value: unknown): value is SendMode {
  return value === "auto" || value === "force" || value === "none";
}

export async function sendArticleByUrl(
  deps: SendArticleByUrlDeps,
  input: SendArticleByUrlInput
): Promise<SendArticleByUrlResult> {
  const { store, config, log } = deps;
  const { user, url, title: titleOverride, sendMode } = input;

  if (typeof url !== "string" || !url.trim()) {
    const error = new Error("URL is required.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  if (sendMode === "force" && !config.smtp) {
    const error = new Error("Kindle email delivery is not configured.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }
  if (sendMode === "force" && !user.kindleEmail) {
    const error = new Error("Add your Kindle email address before sending files.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  // Pre-fetch dedupe: cheap exact-match against the raw URL.
  const existingByRaw = store.getLibraryItemForUserBySourceUrl(user.id, url);
  if (existingByRaw) {
    return toDedupedResult(existingByRaw);
  }

  const fetched = await deps.fetchAndExtractArticle(url, { substackAuth: config.substackAuth });

  // Post-fetch dedupe: canonical resolved URL after redirects.
  if (fetched.sourceUrl !== url) {
    const existingByCanonical = store.getLibraryItemForUserBySourceUrl(user.id, fetched.sourceUrl);
    if (existingByCanonical) {
      return toDedupedResult(existingByCanonical);
    }
  }

  if (fetched.kind === "pdf") {
    const generated = await deps.saveKindlePdf({
      buffer: fetched.pdfBuffer,
      title: titleOverride ?? fetched.title,
      dataDir: config.dataDir,
      sourceUrl: fetched.sourceUrl
    });
    const libraryItem = store.addLibraryItem(user.id, {
      type: "article",
      title: titleOverride ?? fetched.title,
      sourceUrl: fetched.sourceUrl,
      filename: generated.filename,
      mimeType: generated.mimeType
    });

    const shouldDeliver = decideDelivery({
      sendMode,
      user,
      config,
      autoSendCandidate: shouldAutoSendPdf(fetched.analysis.verdict)
    });

    const delivery = shouldDeliver
      ? await runDelivery(deps, user, libraryItem, sendMode === "force" ? "manual" : "auto", log)
      : null;

    return {
      kind: "pdf",
      libraryItemId: libraryItem.id,
      filename: generated.filename,
      mimeType: generated.mimeType,
      sourceUrl: fetched.sourceUrl,
      title: libraryItem.title,
      deduped: false,
      delivery,
      pdfVerdict: fetched.analysis.verdict
    };
  }

  const articleTitle = titleOverride ?? fetched.article.title;
  const generated = await deps.generateKindleFile(
    {
      title: articleTitle,
      contentHtml: fetched.article.contentHtml,
      textContent: fetched.article.textContent
    },
    {
      dataDir: config.dataDir,
      sourceUrl: fetched.sourceUrl
    }
  );
  const libraryItem = store.addLibraryItem(user.id, {
    type: "article",
    title: articleTitle,
    sourceUrl: fetched.sourceUrl,
    filename: generated.filename,
    mimeType: generated.mimeType
  });

  const shouldDeliver = decideDelivery({ sendMode, user, config, autoSendCandidate: true });
  const delivery = shouldDeliver
    ? await runDelivery(deps, user, libraryItem, sendMode === "force" ? "manual" : "auto", log)
    : null;

  return {
    kind: "article",
    libraryItemId: libraryItem.id,
    filename: generated.filename,
    mimeType: generated.mimeType,
    sourceUrl: fetched.sourceUrl,
    title: articleTitle,
    deduped: false,
    delivery
  };
}

function toDedupedResult(item: LibraryItem): SendArticleByUrlResult {
  return {
    kind: item.mimeType === "application/pdf" ? "pdf" : "article",
    libraryItemId: item.id,
    filename: item.filename,
    mimeType: item.mimeType,
    sourceUrl: item.sourceUrl ?? "",
    title: item.title,
    deduped: true,
    delivery: null
  };
}

function decideDelivery(args: {
  sendMode: SendMode;
  user: UserProfile;
  config: AppConfig;
  autoSendCandidate: boolean;
}): boolean {
  if (args.sendMode === "none") return false;
  if (!args.config.smtp || !args.user.kindleEmail) return false;
  if (args.sendMode === "force") return true;
  // auto
  return Boolean(args.user.autoSendToKindle) && args.autoSendCandidate;
}

async function runDelivery(
  deps: SendArticleByUrlDeps,
  user: UserProfile,
  libraryItem: LibraryItem,
  trigger: KindleDelivery["trigger"],
  log: FastifyBaseLogger
): Promise<KindleDelivery> {
  const smtp = deps.config.smtp as SmtpConfig;
  const kindleEmail = user.kindleEmail as string;
  const delivery = deps.store.createKindleDelivery(user.id, {
    libraryItemId: libraryItem.id,
    title: libraryItem.title,
    filename: libraryItem.filename,
    kindleEmail,
    trigger
  });
  try {
    const result = await deps.sendFileToKindle(smtp, deps.config.dataDir, delivery.filename, kindleEmail);
    return deps.store.recordKindleDeliveryResult(delivery.id, {
      status: "sent",
      messageId: result.messageId,
      response: result.response
    });
  } catch (error) {
    const failed = deps.store.recordKindleDeliveryResult(delivery.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Kindle delivery failed."
    });
    log.warn({ err: error, deliveryId: delivery.id }, "kindle delivery failed");
    return failed;
  }
}

export function registerSendUrlRoute(
  app: FastifyInstance,
  deps: SendArticleByUrlDeps,
  auth: AuthHelpers
): void {
  app.post("/api/articles/send-url", async (request) => {
    const user = auth.requireUser(request);
    const body = (request.body ?? {}) as { url?: unknown; title?: unknown; sendMode?: unknown };
    if (typeof body.url !== "string") {
      const error = new Error("URL is required.");
      Object.assign(error, { statusCode: 400 });
      throw error;
    }
    const sendMode: SendMode = isValidSendMode(body.sendMode) ? body.sendMode : "auto";
    const title = typeof body.title === "string" && body.title.trim() ? body.title : undefined;

    try {
      const result = await sendArticleByUrl(deps, { user, url: body.url, title, sendMode });
      return result;
    } catch (err) {
      if (err instanceof Error && (err as { statusCode?: number }).statusCode) {
        throw err;
      }
      const message = err instanceof Error ? err.message : "Article import failed.";
      const error = new Error(message);
      Object.assign(error, { statusCode: 422, code: "IMPORT_FAILED" });
      throw error;
    }
  });
}
