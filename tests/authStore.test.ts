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
  it("JIT-creates a user from an email with verified=true", () => {
    const user = store.getOrCreateUserByEmail("TJ@Example.com");
    expect(user.email).toBe("tj@example.com");
    expect(user.verified).toBe(true);
    expect(user.autoSendToKindle).toBe(true);
    expect(user.subscriptionRetentionDays).toBe(30);
  });

  it("returns the same user on a repeat lookup", () => {
    const first = store.getOrCreateUserByEmail("reader@example.com");
    const second = store.getOrCreateUserByEmail("reader@example.com");
    expect(second.id).toBe(first.id);
  });

  it("populates a missing display name on subsequent lookup but never overwrites", () => {
    const initial = store.getOrCreateUserByEmail("reader@example.com");
    expect(initial.displayName).toBeUndefined();

    const named = store.getOrCreateUserByEmail("reader@example.com", "Reader One");
    expect(named.displayName).toBe("Reader One");

    const renamed = store.getOrCreateUserByEmail("reader@example.com", "Different Name");
    expect(renamed.displayName).toBe("Reader One");
  });

  it("rejects malformed emails", () => {
    expect(() => store.getOrCreateUserByEmail("not-an-email")).toThrow(/valid email/i);
    expect(() => store.getOrCreateUserByEmail("")).toThrow();
  });

  it("stores a per-user Kindle email and dedupes subscriptions", () => {
    const user = store.getOrCreateUserByEmail("reader@example.com");

    store.updateUserProfile(user.id, {
      kindleEmail: "reader_123@kindle.com",
      autoSendToKindle: true,
      subscriptionRetentionDays: 14
    });
    const updated = store.getUserById(user.id);
    expect(updated?.kindleEmail).toBe("reader_123@kindle.com");
    expect(updated?.subscriptionRetentionDays).toBe(14);

    const first = store.addSubscription(user.id, {
      feedUrl: "https://example.substack.com/feed",
      sourceUrl: "https://example.substack.com",
      title: "Example Substack"
    });
    const second = store.addSubscription(user.id, {
      feedUrl: "https://example.substack.com/feed",
      sourceUrl: "https://example.substack.com",
      title: "Example Substack"
    });

    expect(second.id).toBe(first.id);
    expect(store.listSubscriptions(user.id)).toHaveLength(1);
  });

  it("prunes delivered posts older than a user's retention setting", () => {
    const user = store.getOrCreateUserByEmail("reader@example.com");
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
    const user = store.getOrCreateUserByEmail("reader@example.com");
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
    expect(store.getLatestLibraryItem(user.id)?.title).toBe("Newsletter Issue");
    expect(store.getLibraryItemForUserByFilename(user.id, "saved-article.epub")?.title).toBe("Saved Article");
  });

  it("records Kindle delivery attempts and retry results", () => {
    const user = store.getOrCreateUserByEmail("reader@example.com");
    const item = store.addLibraryItem(user.id, {
      type: "article",
      title: "Saved Article",
      sourceUrl: "https://example.com/article",
      filename: "saved-article.epub",
      mimeType: "application/epub+zip"
    });

    const failed = store.createKindleDelivery(user.id, {
      libraryItemId: item.id,
      title: item.title,
      filename: item.filename,
      kindleEmail: "reader_123@kindle.com",
      trigger: "manual"
    });
    expect(failed.status).toBe("pending");

    const failedResult = store.recordKindleDeliveryResult(failed.id, {
      status: "failed",
      error: "SMTP rejected the message"
    });
    expect(failedResult).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "SMTP rejected the message"
    });

    const retry = store.createKindleDelivery(user.id, {
      libraryItemId: item.id,
      title: item.title,
      filename: item.filename,
      kindleEmail: "reader_123@kindle.com",
      trigger: "retry"
    });
    const sentResult = store.recordKindleDeliveryResult(retry.id, {
      status: "sent",
      messageId: "message-1",
      response: "250 OK"
    });

    expect(sentResult).toMatchObject({
      status: "sent",
      attempts: 1,
      messageId: "message-1",
      response: "250 OK"
    });
    expect(store.listKindleDeliveries(user.id).map((delivery) => delivery.status)).toEqual(["sent", "failed"]);
    expect(store.getKindleDeliveryForUser(user.id, failed.id)?.error).toBe("SMTP rejected the message");
  });

  it("removes expired library items when pruning delivered posts", () => {
    const user = store.getOrCreateUserByEmail("reader@example.com");
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

  it("mints, lists, validates, and revokes API tokens", () => {
    const user = store.getOrCreateUserByEmail("reader@example.com");

    const minted = store.createApiToken(user.id, "Laptop CLI");
    expect(minted.token).toMatch(/^kf_pat_[A-Za-z0-9_-]{40,}$/);
    expect(minted.name).toBe("Laptop CLI");

    expect(store.getUserByApiToken(minted.token)?.id).toBe(user.id);
    expect(store.getUserByApiToken("kf_pat_bogus")).toBeNull();
    expect(store.getUserByApiToken("sk-not-our-prefix")).toBeNull();
    expect(store.getUserByApiToken(undefined)).toBeNull();

    expect(store.listApiTokens(user.id).map((t) => t.name)).toEqual(["Laptop CLI"]);

    store.touchApiToken(minted.token);
    expect(store.listApiTokens(user.id)[0].lastUsedAt).toBeTruthy();

    expect(store.revokeApiToken(user.id, minted.id)).toBe(true);
    expect(store.revokeApiToken(user.id, minted.id)).toBe(false);
    expect(store.getUserByApiToken(minted.token)).toBeNull();
    expect(store.listApiTokens(user.id)).toEqual([]);

    expect(() => store.createApiToken(user.id, "  ")).toThrow(/name is required/i);
    expect(() => store.createApiToken(user.id, "x".repeat(200))).toThrow(/100 characters/i);
  });

  it("looks up library items by source URL for dedupe", () => {
    const user = store.getOrCreateUserByEmail("reader@example.com");
    store.addLibraryItem(user.id, {
      type: "article",
      title: "Saved",
      sourceUrl: "https://example.com/post",
      filename: "saved-post.epub",
      mimeType: "application/epub+zip"
    });

    expect(store.getLibraryItemForUserBySourceUrl(user.id, "https://example.com/post")?.filename).toBe(
      "saved-post.epub"
    );
    expect(store.getLibraryItemForUserBySourceUrl(user.id, "https://example.com/other")).toBeNull();
  });

  it("returns recent library items with their latest delivery", () => {
    const user = store.getOrCreateUserByEmail("reader@example.com");
    const item = store.addLibraryItem(user.id, {
      type: "article",
      title: "With Delivery",
      sourceUrl: "https://example.com/a",
      filename: "a.epub",
      mimeType: "application/epub+zip"
    });
    store.addLibraryItem(user.id, {
      type: "article",
      title: "No Delivery",
      sourceUrl: "https://example.com/b",
      filename: "b.epub",
      mimeType: "application/epub+zip"
    });

    const failed = store.createKindleDelivery(user.id, {
      libraryItemId: item.id,
      title: item.title,
      filename: item.filename,
      kindleEmail: "reader@kindle.com",
      trigger: "manual"
    });
    store.recordKindleDeliveryResult(failed.id, { status: "failed", error: "smtp" });
    const retry = store.createKindleDelivery(user.id, {
      libraryItemId: item.id,
      title: item.title,
      filename: item.filename,
      kindleEmail: "reader@kindle.com",
      trigger: "retry"
    });
    store.recordKindleDeliveryResult(retry.id, { status: "sent", messageId: "m1" });

    const recent = store.listRecentLibraryItemsWithDelivery(user.id);
    expect(recent.map((r) => r.title)).toEqual(["No Delivery", "With Delivery"]);
    expect(recent[0].latestDelivery).toBeNull();
    expect(recent[1].latestDelivery?.status).toBe("sent");
    expect(recent[1].latestDelivery?.id).toBe(retry.id);
  });

  it("api_tokens migration is idempotent on an existing DB", () => {
    const user = store.getOrCreateUserByEmail("reader@example.com");
    const minted = store.createApiToken(user.id, "first");
    store.close();

    // Reopen the same DB — migration must be idempotent.
    store = new AuthStore(path.join(tempDir, "kindleflow.sqlite"));
    expect(store.getUserByApiToken(minted.token)?.id).toBe(user.id);
    const minted2 = store.createApiToken(user.id, "second");
    expect(minted2.token).not.toBe(minted.token);
    expect(store.listApiTokens(user.id).map((t) => t.name).sort()).toEqual(["first", "second"]);
  });
});
