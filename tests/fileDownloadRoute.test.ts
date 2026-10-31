import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthHelpers } from "../server/auth.js";
import { AuthStore } from "../server/authStore.js";
import { registerFileDownloadRoute } from "../server/fileDownloadRoute.js";

let dataDir: string;
let app: FastifyInstance;
let store: AuthStore;
let userId: string;

const userHeaders = { "x-auth-request-email": "owner@example.com", "x-auth-request-proxy-secret": "test-proxy-secret" };
const otherHeaders = { ...userHeaders, "x-auth-request-email": "other@example.com" };

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-download-"));
  store = new AuthStore(path.join(dataDir, "kindleflow.sqlite"));
  userId = store.getOrCreateUserByEmail(userHeaders["x-auth-request-email"]).id;
  await writeFile(path.join(dataDir, "article.epub"), "synthetic EPUB");
  store.addLibraryItem(userId, { type: "article", title: "Article", filename: "article.epub", mimeType: "application/epub+zip" });
  app = Fastify();
  await registerFileDownloadRoute(app, dataDir, store, createAuthHelpers(store, { trustedProxySecret: "test-proxy-secret" }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("GET /files/:filename", () => {
  it("requires authentication, including for HEAD", async () => {
    for (const method of ["GET", "HEAD"] as const) {
      const response = await app.inject({ method, url: "/files/article.epub" });
      expect(response.statusCode).toBe(401);
    }
    const spoofed = await app.inject({ url: "/files/article.epub", headers: { "x-auth-request-email": "owner@example.com" } });
    expect(spoofed.statusCode).toBe(401);
  });

  it("only serves the authenticated owner's documents, without shared caching", async () => {
    const response = await app.inject({ url: "/files/article.epub", headers: userHeaders });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("synthetic EPUB");
    expect(response.headers["content-type"]).toBe("application/epub+zip");
    expect(response.headers["cache-control"]).toBe("private, no-store");

    const other = await app.inject({ url: "/files/article.epub", headers: otherHeaders });
    expect(other.statusCode).toBe(404);
  });

  it.each(["kindleflow.sqlite", "kindleflow.sqlite-wal", ".env", "untracked.pdf", "nested%2Farticle.epub"])(
    "does not expose %s to an authenticated user",
    async (filename) => {
      if (filename === "untracked.pdf") await writeFile(path.join(dataDir, filename), "untracked private file");
      const response = await app.inject({ url: `/files/${filename}`, headers: userHeaders });
      expect(response.statusCode).toBe(404);
    }
  );

  it("preserves bearer-token access and converted temporary-file ownership", async () => {
    const token = store.createApiToken(userId, "test").token;
    const source = store.getLibraryItemForUserByFilename(userId, "article.epub")!;
    store.addTemporaryFile({
      userId,
      sourceLibraryItemId: source.id,
      filename: "converted.epub",
      mimeType: "application/epub+zip",
      retentionHours: 24
    });
    await writeFile(path.join(dataDir, "converted.epub"), "synthetic converted EPUB");

    const response = await app.inject({ url: "/files/converted.epub", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("synthetic converted EPUB");
    const other = await app.inject({ url: "/files/converted.epub", headers: otherHeaders });
    expect(other.statusCode).toBe(404);
  });
});
