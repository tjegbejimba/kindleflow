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
      autoSendToKindle: true
    });
  });

  it("stores a per-user Kindle email and dedupes subscriptions", () => {
    const token = store.createLoginToken("reader@example.com", "secret", "secret");
    const session = store.consumeMagicToken(token);
    const user = store.getUserBySession(session);
    expect(user).not.toBeNull();

    store.updateUserProfile(user!.id, { kindleEmail: "reader_123@kindle.com", autoSendToKindle: true });
    const updated = store.getUserBySession(session);
    expect(updated?.kindleEmail).toBe("reader_123@kindle.com");

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
});
