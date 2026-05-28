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

  const results = await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        const count = await pollSubscription(store, config, subscription, logger);
        store.markSubscriptionChecked(subscription.id);
        return count;
      } catch (error) {
        logger.warn({ err: error, subscriptionId: subscription.id }, "subscription failed");
        return 0;
      }
    })
  );
  const delivered = results.reduce((sum, count) => sum + count, 0);

  const userIds = new Set(subscriptions.map((subscription) => subscription.userId));
  await Promise.all(
    [...userIds].map((currentUserId) =>
      deleteGeneratedFiles(config.dataDir, store.pruneDeliveredPostsForUser(currentUserId), logger)
    )
  );

  // Clean up expired temporary files
  await cleanupExpiredTemporaryFiles(store, config.dataDir, logger);

  return { checked: subscriptions.length, delivered };
}

async function cleanupExpiredTemporaryFiles(
  store: AuthStore,
  dataDir: string,
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): Promise<void> {
  const expiredFiles = store.listExpiredTemporaryFiles();
  
  if (expiredFiles.length === 0) {
    return;
  }
  
  logger.info({ count: expiredFiles.length }, "cleaning up expired temporary files");
  
  // Delete physical files
  for (const file of expiredFiles) {
    const filePath = path.join(dataDir, file.filename);
    try {
      await unlink(filePath);
    } catch (error) {
      logger.warn({ filename: file.filename, err: error }, "failed to delete temporary file from disk");
    }
  }
  
  // Delete database records
  const deletedCount = store.cleanupExpiredTemporaryFiles();
  logger.info({ count: deletedCount }, "cleaned up expired temporary files from database");
}

async function pollSubscription(
  store: AuthStore,
  config: AppConfig,
  subscription: SubscriptionWithUser,
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): Promise<number> {
  const feed = await fetchFeed(subscription.feedUrl, { substackAuth: config.substackAuth });
  const posts = [...feed.items].reverse();
  let delivered = 0;

  for (let i = 0; i < posts.length; i += 1) {
    const post = posts[i];
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

    // oxlint-disable-next-line react-doctor/async-await-in-loop
    const fetched = await fetchAndExtractArticle(post.url, { substackAuth: config.substackAuth });
    // Subscription PDFs are PDF-only in v1: unattended subscription delivery must not
    // consult fetched.analysis.verdict or call convertPdfToEpub. Manual PDF fetches own
    // the guided conversion flow (analyzer pause + opt-in converter); subscriptions
    // stay predictable and always save+send as covered PDFs. See issue #10 and PRD #4.
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
  await Promise.all(
    filenames.map(async (filename) => {
      const safeFilename = path.basename(filename);
      if (safeFilename !== filename || !isRetainableFilename(safeFilename)) {
        logger.warn({ filename }, "skipping unsafe retained file deletion");
        return;
      }

      const absolutePath = path.resolve(resolvedDataDir, safeFilename);
      if (!absolutePath.startsWith(`${resolvedDataDir}${path.sep}`)) {
        logger.warn({ filename }, "skipping retained file outside data directory");
        return;
      }

      await unlink(absolutePath).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return;
        }
        throw error;
      });
    })
  );
}

function isRetainableFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".epub") || lower.endsWith(".pdf");
}
