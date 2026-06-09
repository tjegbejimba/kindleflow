import Fastify, { type FastifyInstance } from "fastify";
import FormData from "form-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthHelpers } from "../server/auth.js";
import { AuthStore } from "../server/authStore.js";
import type { SmtpConfig } from "../server/config.js";
import { registerFileUploadRoute } from "../server/fileUploadRoute.js";

// Mock nodemailer
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (opts: any) => {
        // Consume the stream to prevent unhandled errors
        if (opts.attachments?.[0]?.content?.read) {
          const stream = opts.attachments[0].content as Readable;
          stream.on("error", () => {}); // Suppress stream errors
          stream.resume(); // Drain the stream
        }
        return { messageId: "test-msg", response: "250 OK" };
      }
    })
  }
}));

const SMTP: SmtpConfig = {
  host: "smtp.test",
  port: 587,
  secure: false,
  from: "test@kindleflow.test"
};

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
  await registerFileUploadRoute(app, testDir, store, auth, SMTP);
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

  it("returns delivery status when SMTP and Kindle email are configured", async () => {
    // Update user with Kindle email
    store.updateUserProfile(userId, { kindleEmail: "test@kindle.com" });

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
    expect(body.delivery).toBeDefined();
    expect(body.delivery.status).toBe("sent");
    expect(body.delivery.trigger).toBe("upload");
  });

  it("returns null delivery when SMTP is not configured", async () => {
    // Create app without SMTP
    await app.close();
    app = Fastify();
    const auth = createAuthHelpers(store);
    await registerFileUploadRoute(app, testDir, store, auth, undefined);
    await app.ready();

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
    expect(body.delivery).toBeNull();
  });
});

