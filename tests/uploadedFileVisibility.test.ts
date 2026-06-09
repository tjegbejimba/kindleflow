import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthHelpers } from "../server/auth.js";
import { AuthStore } from "../server/authStore.js";
import { registerLibraryRecentRoute } from "../server/libraryRecentRoute.js";
import { saveUploadedFile } from "../server/fileUpload.js";

describe("uploaded file visibility", () => {
  let testDir: string;
  let store: AuthStore;
  let userId: string;
  let app: FastifyInstance;
  let pat: string;

  beforeEach(async () => {
    testDir = mkdtempSync(path.join(tmpdir(), "kindleflow-upload-visibility-test-"));
    store = new AuthStore(path.join(testDir, "test.db"));
    const user = store.getOrCreateUserByEmail("user@test.local");
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
    rmSync(testDir, { recursive: true, force: true });
  });

  it("uploaded files appear in Recent library", async () => {
    // Arrange: upload a PDF
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    await saveUploadedFile(
      {
        userId,
        fileBuffer: pdfBytes,
        originalFilename: "document.pdf",
        title: "My Upload"
      },
      { dataDir: testDir, store }
    );

    // Act: get Recent library items via API
    const res = await app.inject({
      method: "GET",
      url: "/api/library/recent",
      headers: { authorization: `Bearer ${pat}` }
    });

    // Assert: uploaded file is visible
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{
      id: string;
      title: string;
      type: string;
      mimeType: string;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("My Upload");
    expect(items[0].type).toBe("uploaded_file");
    expect(items[0].mimeType).toBe("application/pdf");
  });

  it("uploaded files appear with correct file info", async () => {
    // Arrange: upload an EPUB
    const epubBytes = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, // ZIP signature
      ...Array(50).fill(0x00)
    ]);

    await saveUploadedFile(
      {
        userId,
        fileBuffer: epubBytes,
        originalFilename: "mybook.epub",
        title: "My Book"
      },
      { dataDir: testDir, store }
    );

    // Act: get items via API
    const res = await app.inject({
      method: "GET",
      url: "/api/library/recent",
      headers: { authorization: `Bearer ${pat}` }
    });

    // Assert: uploaded file data is correct
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{
      title: string;
      mimeType: string;
      filename: string;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("My Book");
    expect(items[0].mimeType).toBe("application/epub+zip");
    expect(items[0].filename).toMatch(/^my-book-[a-z0-9]{8}\.epub$/);
  });

  it("multiple uploads appear in reverse chronological order", async () => {
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    // Upload three files
    await saveUploadedFile(
      { userId, fileBuffer: pdfBytes, originalFilename: "first.pdf", title: "First" },
      { dataDir: testDir, store }
    );

    await saveUploadedFile(
      { userId, fileBuffer: pdfBytes, originalFilename: "second.pdf", title: "Second" },
      { dataDir: testDir, store }
    );

    await saveUploadedFile(
      { userId, fileBuffer: pdfBytes, originalFilename: "third.pdf", title: "Third" },
      { dataDir: testDir, store }
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/library/recent",
      headers: { authorization: `Bearer ${pat}` }
    });

    const items = res.json().items as Array<{ title: string }>;

    expect(items).toHaveLength(3);
    expect(items[0].title).toBe("Third"); // Most recent first
    expect(items[1].title).toBe("Second");
    expect(items[2].title).toBe("First");
  });
});

