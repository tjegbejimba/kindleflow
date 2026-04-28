import type { FastifyBaseLogger } from "fastify";
import type { AuthStore, SubscriptionWithUser } from "./authStore.js";
import type { AppConfig } from "./config.js";
import { fetchAndExtractArticle } from "./articleFetcher.js";
import { fetchFeed } from "./feed.js";
import { generateKindleFile } from "./kindleFile.js";
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

  return { checked: subscriptions.length, delivered };
}

async function pollSubscription(
  store: AuthStore,
  config: AppConfig,
  subscription: SubscriptionWithUser,
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): Promise<number> {
  const feed = await fetchFeed(subscription.feedUrl);
  let delivered = 0;

  for (const post of [...feed.items].reverse()) {
    if (store.hasDeliveredPost(subscription.id, post.url, post.guid)) {
      continue;
    }

    if (!config.smtp || !subscription.kindleEmail || !subscription.autoSendToKindle) {
      logger.info({ subscriptionId: subscription.id, postUrl: post.url }, "new post found but Kindle sending is disabled");
      continue;
    }

    const fetched = await fetchAndExtractArticle(post.url);
    const generated = await generateKindleFile(fetched.article, {
      dataDir: config.dataDir,
      sourceUrl: fetched.sourceUrl
    });

    await sendFileToKindle(config.smtp, config.dataDir, generated.filename, subscription.kindleEmail);
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
