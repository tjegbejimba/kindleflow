import { unlink } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { AuthStore, SubscriptionWithUser } from "./authStore.js";
import type { AppConfig } from "./config.js";
import { fetchAndExtractArticle } from "./articleFetcher.js";
import { fetchFeed } from "./feed.js";
import { generateKindleFile, saveKindlePdf } from "./kindleFile.js";
import { sendFileToKindle } from "./mailer.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function startDailySubscriptionPoller(store: AuthStore, config: AppConfig, logger: FastifyBaseLogger): void {
  setInterval(() => {
    pollSubscriptions(store, config, logger).catch((error: unknown) => {
      logger.error({ err: error }, "subscription poll failed");
    });
  }, ONE_DAY_MS).unref();
}

export async function pollSubscriptions(
  store: AuthStore,
  config: AppConfig,
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
  userId?: string
): Promise<{ checked: number; delivered: number }> {
  const subscriptions = store
    .listActiveSubscriptionsWithUsers()
    .filter((subscription) => !userId || subscription.userId === userId);

  let delivered = 0;

  for (const subscription of subscriptions) {
    try {
      delivered += await pollSubscription(store, config, subscription, logger);
      store.markSubscriptionChecked(subscription.id);
    } catch (error) {
      logger.warn({ err: error, subscriptionId: subscription.id }, "subscription failed");
    }
  }

  const userIds = new Set(subscriptions.map((subscription) => subscription.userId));
  for (const currentUserId of userIds) {
    await deleteGeneratedFiles(config.dataDir, store.pruneDeliveredPostsForUser(currentUserId), logger);
  }

  return { checked: subscriptions.length, delivered };
}

async function pollSubscription(
  store: AuthStore,
  config: AppConfig,
  subscription: SubscriptionWithUser,
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): Promise<number> {
  const feed = await fetchFeed(subscription.feedUrl, { substackAuth: config.substackAuth });
  let delivered = 0;

  for (const post of [...feed.items].reverse()) {
    if (isOlderThanRetention(post.publishedAt, subscription.subscriptionRetentionDays)) {
      continue;
    }

    if (store.hasDeliveredPost(subscription.id, post.url, post.guid)) {
      continue;
    }

    if (!config.smtp || !subscription.kindleEmail || !subscription.autoSendToKindle) {
      logger.info({ subscriptionId: subscription.id, postUrl: post.url }, "new post found but Kindle sending is disabled");
      continue;
    }

    const fetched = await fetchAndExtractArticle(post.url, { substackAuth: config.substackAuth });
    const generated =
      fetched.kind === "pdf"
        ? await saveKindlePdf({
            buffer: fetched.pdfBuffer,
            title: fetched.title,
            dataDir: config.dataDir,
            sourceUrl: fetched.sourceUrl
          })
        : await generateKindleFile(fetched.article, {
            dataDir: config.dataDir,
            sourceUrl: fetched.sourceUrl
          });
    const itemTitle = fetched.kind === "pdf" ? fetched.title : fetched.article.title;

    const libraryItem = store.addLibraryItem(subscription.userId, {
      type: "subscription_post",
      subscriptionId: subscription.id,
      title: itemTitle,
      sourceUrl: fetched.sourceUrl,
      filename: generated.filename,
      mimeType: generated.mimeType
    });
    const delivery = store.createKindleDelivery(subscription.userId, {
      libraryItemId: libraryItem.id,
      title: libraryItem.title,
      filename: libraryItem.filename,
      kindleEmail: subscription.kindleEmail,
      trigger: "subscription"
    });

    try {
      const result = await sendFileToKindle(config.smtp, config.dataDir, generated.filename, subscription.kindleEmail);
      store.recordKindleDeliveryResult(delivery.id, {
        status: "sent",
        messageId: result.messageId,
        response: result.response
      });
    } catch (error) {
      store.recordKindleDeliveryResult(delivery.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Kindle delivery failed."
      });
      throw error;
    }
    store.markPostDelivered(subscription.id, {
      url: post.url,
      guid: post.guid,
      title: post.title,
      filename: generated.filename
    });
    delivered += 1;
  }

  return delivered;
}

function isOlderThanRetention(publishedAt: string | undefined, retentionDays: number): boolean {
  if (!publishedAt) {
    return false;
  }

  const publishedTime = Date.parse(publishedAt);
  if (Number.isNaN(publishedTime)) {
    return false;
  }

  return publishedTime < Date.now() - retentionDays * ONE_DAY_MS;
}

async function deleteGeneratedFiles(
  dataDir: string,
  filenames: string[],
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): Promise<void> {
  const resolvedDataDir = path.resolve(dataDir);
  for (const filename of filenames) {
    const safeFilename = path.basename(filename);
    if (safeFilename !== filename || !isRetainableFilename(safeFilename)) {
      logger.warn({ filename }, "skipping unsafe retained file deletion");
      continue;
    }

    const absolutePath = path.resolve(resolvedDataDir, safeFilename);
    if (!absolutePath.startsWith(`${resolvedDataDir}${path.sep}`)) {
      logger.warn({ filename }, "skipping retained file outside data directory");
      continue;
    }

    await unlink(absolutePath).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    });
  }
}

function isRetainableFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".epub") || lower.endsWith(".pdf");
}
