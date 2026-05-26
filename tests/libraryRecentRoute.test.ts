import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthHelpers } from "../server/auth.js";
import { AuthStore } from "../server/authStore.js";
import { registerLibraryRecentRoute } from "../server/libraryRecentRoute.js";

let tempDir: string;
let store: AuthStore;
let app: FastifyInstance;
let userId: string;
let pat: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-library-"));
  store = new AuthStore(path.join(tempDir, "db.sqlite"));
  const user = store.getOrCreateUserByEmail("tj@example.com");
  userId = user.id;
  pat = store.createApiToken(userId, "cli").token;

  app = Fastify();
  const auth = createAuthHelpers(store);
  registerLibraryRecentRoute(app, store, auth);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  store.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("GET /api/library/recent", () => {
  it("returns recent items with their latest delivery, including items without deliveries", async () => {
    const item1 = store.addLibraryItem(userId, {
      type: "article",
      title: "Without",
      sourceUrl: "https://ex/1",
      filename: "without.epub",
      mimeType: "application/epub+zip"
    });
    const item2 = store.addLibraryItem(userId, {
      type: "article",
      title: "With",
      sourceUrl: "https://ex/2",
      filename: "with.epub",
      mimeType: "application/epub+zip"
    });
    const delivery = store.createKindleDelivery(userId, {
      libraryItemId: item2.id,
      title: item2.title,
      filename: item2.filename,
      kindleEmail: "tj@kindle.com",
      trigger: "manual"
    });
    store.recordKindleDeliveryResult(delivery.id, { status: "sent", messageId: "m1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/library/recent",
      headers: { authorization: `Bearer ${pat}` }
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{
      id: string;
      title: string;
      latestDelivery: { status: string } | null;
    }>;
    expect(items.map((i) => i.title)).toEqual(["With", "Without"]);
    expect(items[0].latestDelivery?.status).toBe("sent");
    expect(items[1].latestDelivery).toBeNull();
    // Make sure ids line up
    expect(items[0].id).toBe(item2.id);
    expect(items[1].id).toBe(item1.id);
  });

  it("honours ?limit=", async () => {
    for (let i = 0; i < 5; i += 1) {
      store.addLibraryItem(userId, {
        type: "article",
        title: `Item ${i}`,
        sourceUrl: `https://ex/${i}`,
        filename: `i${i}.epub`,
        mimeType: "application/epub+zip"
      });
    }
    const res = await app.inject({
      method: "GET",
      url: "/api/library/recent?limit=2",
      headers: { authorization: `Bearer ${pat}` }
    });
    expect(res.json().items).toHaveLength(2);
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/library/recent" });
    expect(res.statusCode).toBe(401);
  });
});
