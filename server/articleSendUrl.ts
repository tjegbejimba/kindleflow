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
import { deliverToKindles, parseKindleSelectors, requireKindleTargets } from "./kindleDelivery.js";
import { generateKindleFile, saveKindlePdf } from "./kindleFile.js";
import { sendFileToKindle } from "./mailer.js";
import { type PdfAnalysisVerdict, shouldAutoSendPdf } from "./pdfAnalyzer.js";

export type SendMode = "auto" | "force" | "none";

export interface SendArticleByUrlInput {
  user: UserProfile;
  url: string;
  title?: string;
  sendMode: SendMode;
  /** Kindle ids, emails, or names. Non-empty selects those Kindles and forces a send (unless sendMode is "none"). */
  kindles?: string[];
}

export interface SendArticleByUrlResult {
  kind: "article" | "pdf";
  libraryItemId: string;
  filename: string;
  mimeType: string;
  sourceUrl: string;
  title: string;
  deduped: boolean;
  /** First delivery of the batch, kept for older clients. */
  delivery: KindleDelivery | null;
  deliveries: KindleDelivery[];
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

function isValidSendMode(value: unknown): value is SendMode {
  return value === "auto" || value === "force" || value === "none";
}

export async function sendArticleByUrl(
  deps: SendArticleByUrlDeps,
  input: SendArticleByUrlInput
): Promise<SendArticleByUrlResult> {
  const { store, config, log } = deps;
  const { user, url, title: titleOverride } = input;
  const selectors = (input.kindles ?? []).map((kindle) => kindle.trim()).filter(Boolean);
  const sendMode: SendMode = selectors.length > 0 && input.sendMode !== "none" ? "force" : input.sendMode;

  if (typeof url !== "string" || !url.trim()) {
    const error = new Error("URL is required.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  const forcedTargets =
    sendMode === "force" ? requireKindleTargets({ store, smtp: config.smtp, userId: user.id, selectors }) : undefined;

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

    const deliveries = shouldDeliver
      ? await runDelivery(deps, user, libraryItem, sendMode === "force" ? "manual" : "auto", log, forcedTargets)
      : [];

    return {
      kind: "pdf",
      libraryItemId: libraryItem.id,
      filename: generated.filename,
      mimeType: generated.mimeType,
      sourceUrl: fetched.sourceUrl,
      title: libraryItem.title,
      deduped: false,
      delivery: deliveries[0] ?? null,
      deliveries,
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
  const deliveries = shouldDeliver
    ? await runDelivery(deps, user, libraryItem, sendMode === "force" ? "manual" : "auto", log, forcedTargets)
    : [];

  return {
    kind: "article",
    libraryItemId: libraryItem.id,
    filename: generated.filename,
    mimeType: generated.mimeType,
    sourceUrl: fetched.sourceUrl,
    title: articleTitle,
    deduped: false,
    delivery: deliveries[0] ?? null,
    deliveries
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
    delivery: null,
    deliveries: []
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
  log: FastifyBaseLogger,
  targets = deps.store.resolveKindleTargets(user.id)
): Promise<KindleDelivery[]> {
  return deliverToKindles({
    store: deps.store,
    smtp: deps.config.smtp as SmtpConfig,
    dataDir: deps.config.dataDir,
    log,
    send: deps.sendFileToKindle,
    userId: user.id,
    targets: targets.map((device) => device.email),
    file: { libraryItemId: libraryItem.id, title: libraryItem.title, filename: libraryItem.filename },
    trigger
  });
}

export function registerSendUrlRoute(
  app: FastifyInstance,
  deps: SendArticleByUrlDeps,
  auth: AuthHelpers
): void {
  app.post("/api/articles/send-url", async (request) => {
    const user = auth.requireUser(request);
    const body = (request.body ?? {}) as { url?: unknown; title?: unknown; sendMode?: unknown; kindles?: unknown };
    if (typeof body.url !== "string") {
      const error = new Error("URL is required.");
      Object.assign(error, { statusCode: 400 });
      throw error;
    }
    const sendMode: SendMode = isValidSendMode(body.sendMode) ? body.sendMode : "auto";
    const title = typeof body.title === "string" && body.title.trim() ? body.title : undefined;

    try {
      const result = await sendArticleByUrl(deps, {
        user,
        url: body.url,
        title,
        sendMode,
        kindles: parseKindleSelectors(body.kindles)
      });
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
