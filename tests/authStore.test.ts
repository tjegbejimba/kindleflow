import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../server/authStore.js";

let tempDir: string;
let store: AuthStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-auth-"));
  store = new AuthStore(path.join(tempDir, "kindleflow.sqlite"));
});

afterEach(async () => {
  store.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("AuthStore", () => {
  it("requires an invite code for new users, then verifies login with a magic token", () => {
    expect(() => store.createLoginToken("tj@example.com", undefined, "secret")).toThrow(/invite/i);

    const magicToken = store.createLoginToken("TJ@Example.com", "secret", "secret");
    expect(magicToken).toHaveLength(48);

    const sessionToken = store.consumeMagicToken(magicToken);
    expect(sessionToken).toHaveLength(48);

    const user = store.getUserBySession(sessionToken);
    expect(user).toMatchObject({
      email: "tj@example.com",
      verified: true,
      autoSendToKindle: true,
      subscriptionRetentionDays: 30
    });
  });

  it("supports a configurable session lifetime", async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
    tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-auth-"));
    store = new AuthStore(path.join(tempDir, "kindleflow.sqlite"), { sessionTtlMs: 1 });

    const magicToken = store.createLoginToken("short@example.com", "secret", "secret");
    const sessionToken = store.consumeMagicToken(magicToken);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(store.getUserBySession(sessionToken)).toBeNull();
  });

  it("stores a per-user Kindle email and dedupes subscriptions", () => {
    const token = store.createLoginToken("reader@example.com", "secret", "secret");
    const session = store.consumeMagicToken(token);
    const user = store.getUserBySession(session);
    expect(user).not.toBeNull();

    store.updateUserProfile(user!.id, {
      kindleEmail: "reader_123@kindle.com",
      autoSendToKindle: true,
      subscriptionRetentionDays: 14
    });
    const updated = store.getUserBySession(session);
    expect(updated?.kindleEmail).toBe("reader_123@kindle.com");
    expect(updated?.subscriptionRetentionDays).toBe(14);

    const first = store.addSubscription(user!.id, {
      feedUrl: "https://example.substack.com/feed",
      sourceUrl: "https://example.substack.com",
      title: "Example Substack"
    });
    const second = store.addSubscription(user!.id, {
      feedUrl: "https://example.substack.com/feed",
      sourceUrl: "https://example.substack.com",
      title: "Example Substack"
    });

    expect(second.id).toBe(first.id);
    expect(store.listSubscriptions(user!.id)).toHaveLength(1);
  });

  it("prunes delivered posts older than a user's retention setting", async () => {
    const token = store.createLoginToken("reader@example.com", "secret", "secret");
    const session = store.consumeMagicToken(token);
    const user = store.getUserBySession(session)!;
    store.updateUserProfile(user.id, { subscriptionRetentionDays: 7 });
    const subscription = store.addSubscription(user.id, {
      feedUrl: "https://example.substack.com/feed",
      sourceUrl: "https://example.substack.com",
      title: "Example Substack"
    });

    store.markPostDelivered(subscription.id, {
      url: "https://example.substack.com/p/old",
      guid: "old",
      title: "Old post",
      filename: "old.epub"
    });
    store.markPostDelivered(subscription.id, {
      url: "https://example.substack.com/p/new",
      guid: "new",
      title: "New post",
      filename: "new.epub"
    });
    store.setDeliveredPostAgeForTest("https://example.substack.com/p/old", 10);
    store.setDeliveredPostAgeForTest("https://example.substack.com/p/new", 2);

    expect(store.pruneDeliveredPostsForUser(user.id)).toEqual(["old.epub"]);
    expect(store.hasDeliveredPost(subscription.id, "https://example.substack.com/p/old", "old")).toBe(false);
    expect(store.hasDeliveredPost(subscription.id, "https://example.substack.com/p/new", "new")).toBe(true);
  });

  it("creates OPDS tokens and tracks generated library items", () => {
    const token = store.createLoginToken("reader@example.com", "secret", "secret");
    const session = store.consumeMagicToken(token);
    const user = store.getUserBySession(session)!;
    const subscription = store.addSubscription(user.id, {
      feedUrl: "https://example.substack.com/feed",
      sourceUrl: "https://example.substack.com",
      title: "Example Substack"
    });

    const opdsToken = store.ensureOpdsToken(user.id);
    expect(opdsToken).toHaveLength(48);
    expect(store.getUserByOpdsToken(opdsToken)?.email).toBe("reader@example.com");
    expect(store.ensureOpdsToken(user.id)).toBe(opdsToken);

    const rotatedToken = store.rotateOpdsToken(user.id);
    expect(rotatedToken).not.toBe(opdsToken);
    expect(store.getUserByOpdsToken(opdsToken)).toBeNull();
    expect(store.getUserByOpdsToken(rotatedToken)?.id).toBe(user.id);

    store.addLibraryItem(user.id, {
      type: "article",
      title: "Saved Article",
      sourceUrl: "https://example.com/article",
      filename: "saved-article.epub",
      mimeType: "application/epub+zip"
    });
    store.addLibraryItem(user.id, {
      type: "subscription_post",
      subscriptionId: subscription.id,
      title: "Newsletter Issue",
      sourceUrl: "https://example.substack.com/p/issue",
      filename: "newsletter-issue.epub",
      mimeType: "application/epub+zip"
    });

    expect(store.listRecentLibraryItems(user.id).map((item) => item.title)).toEqual([
      "Newsletter Issue",
      "Saved Article"
    ]);
    expect(store.listLibrarySubscriptions(user.id)).toEqual([
      {
        id: subscription.id,
        title: "Example Substack",
        itemCount: 1
      }
    ]);
    expect(store.getLibraryItemForOpdsToken(rotatedToken, "newsletter-issue.epub")?.title).toBe("Newsletter Issue");
  });

  it("removes expired library items when pruning delivered posts", () => {
    const token = store.createLoginToken("reader@example.com", "secret", "secret");
    const session = store.consumeMagicToken(token);
    const user = store.getUserBySession(session)!;
    store.updateUserProfile(user.id, { subscriptionRetentionDays: 7 });
    const subscription = store.addSubscription(user.id, {
      feedUrl: "https://example.substack.com/feed",
      sourceUrl: "https://example.substack.com",
      title: "Example Substack"
    });

    store.markPostDelivered(subscription.id, {
      url: "https://example.substack.com/p/old",
      guid: "old",
      title: "Old post",
      filename: "old.epub"
    });
    store.addLibraryItem(user.id, {
      type: "subscription_post",
      subscriptionId: subscription.id,
      title: "Old post",
      sourceUrl: "https://example.substack.com/p/old",
      filename: "old.epub",
      mimeType: "application/epub+zip"
    });
    store.setDeliveredPostAgeForTest("https://example.substack.com/p/old", 10);

    expect(store.pruneDeliveredPostsForUser(user.id)).toEqual(["old.epub"]);
    expect(store.listRecentLibraryItems(user.id)).toEqual([]);
  });
});
