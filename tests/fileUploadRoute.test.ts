import Fastify, { type FastifyInstance } from "fastify";
import FormData from "form-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthHelpers } from "../server/auth.js";
import { AuthStore } from "../server/authStore.js";
import { registerFileUploadRoute } from "../server/fileUploadRoute.js";

let testDir: string;
let store: AuthStore;
let app: FastifyInstance;
let userId: string;
let pat: string;

beforeEach(async () => {
  testDir = mkdtempSync(path.join(tmpdir(), "kindleflow-file-upload-route-"));
  store = new AuthStore(path.join(testDir, "test.db"));
  const user = store.getOrCreateUserByEmail("user@test.local");
  userId = user.id;
  pat = store.createApiToken(userId, "web").token;

  app = Fastify();
  const auth = createAuthHelpers(store);
  await registerFileUploadRoute(app, testDir, store, auth);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  store.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("POST /api/files/upload", () => {
  it("uploads a PDF with multipart form data", async () => {
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    const form = new FormData();
    form.append("file", pdfBytes, {
      filename: "document.pdf",
      contentType: "application/pdf"
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      headers: {
        authorization: `Bearer ${pat}`,
        ...form.getHeaders()
      },
      payload: form
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.libraryItemId).toBeDefined();
    expect(body.title).toBe("document");
    expect(body.storedFilename).toMatch(/^document-[a-z0-9]{8}\.pdf$/);
    expect(body.mimeType).toBe("application/pdf");
  });

  it("allows title override via form field", async () => {
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    const form = new FormData();
    form.append("file", pdfBytes, {
      filename: "original.pdf",
      contentType: "application/pdf"
    });
    form.append("title", "My Custom Title");

    const res = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      headers: {
        authorization: `Bearer ${pat}`,
        ...form.getHeaders()
      },
      payload: form
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe("My Custom Title");
    expect(body.storedFilename).toMatch(/^my-custom-title-[a-z0-9]{8}\.pdf$/);
  });

  it("rejects unauthenticated requests", async () => {
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    const form = new FormData();
    form.append("file", pdfBytes, {
      filename: "document.pdf",
      contentType: "application/pdf"
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      headers: {
        ...form.getHeaders()
      },
      payload: form
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects files over 50 MB", async () => {
    const largeBuffer = Buffer.alloc(51 * 1024 * 1024);
    largeBuffer.write("%PDF-1.4");

    const form = new FormData();
    form.append("file", largeBuffer, {
      filename: "huge.pdf",
      contentType: "application/pdf"
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      headers: {
        authorization: `Bearer ${pat}`,
        ...form.getHeaders()
      },
      payload: form
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects non-PDF/EPUB files", async () => {
    const txtBytes = Buffer.from("Just some text");

    const form = new FormData();
    form.append("file", txtBytes, {
      filename: "document.txt",
      contentType: "text/plain"
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      headers: {
        authorization: `Bearer ${pat}`,
        ...form.getHeaders()
      },
      payload: form
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("PDF and EPUB");
  });
});

