import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, type UserProfile } from "../server/authStore.js";
import type { SmtpConfig } from "../server/config.js";

// Mock nodemailer module
vi.mock("nodemailer", () => {
  const sentMails: any[] = [];
  return {
    default: {
      createTransport: () => ({
        sendMail: async (opts: any) => {
          // Consume the stream to prevent unhandled errors
          if (opts.attachments?.[0]?.content?.read) {
            const stream = opts.attachments[0].content as Readable;
            stream.on("error", () => {}); // Suppress stream errors
            stream.resume(); // Drain the stream
          }
          sentMails.push(opts);
          return { messageId: `msg-${sentMails.length}`, response: "250 OK" };
        }
      })
    },
    __getSentMails: () => sentMails,
    __clearSentMails: () => {
      sentMails.length = 0;
    }
  };
});

const SMTP: SmtpConfig = {
  host: "smtp.test",
  port: 587,
  secure: false,
  from: "test@kindleflow.test"
};

describe("upload delivery", () => {
  let testDir: string;
  let store: AuthStore;
  let user: UserProfile;

  beforeEach(async () => {
    testDir = mkdtempSync(path.join(tmpdir(), "kindleflow-upload-delivery-test-"));
    store = new AuthStore(path.join(testDir, "test.db"));
    user = store.getOrCreateUserByEmail("uploader@test.local");
    store.updateUserProfile(user.id, { kindleEmail: "test@kindle.com", autoSendToKindle: false });
    user = store.getUserById(user.id)!;

    // Clear mock
    const nodemailer = await import("nodemailer");
    if ((nodemailer as any).__clearSentMails) {
      (nodemailer as any).__clearSentMails();
    }
  });

  afterEach(() => {
    store.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates delivery attempt when SMTP and Kindle email are configured", async () => {
    // TRACER BULLET: Confirm upload can trigger delivery
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    // We need a function that orchestrates upload + delivery
    // For now, this will fail because the function doesn't exist yet
    const { sendUploadedFile } = await import("../server/fileUpload.js");

    const result = await sendUploadedFile(
      {
        userId: user.id,
        fileBuffer: pdfBytes,
        originalFilename: "document.pdf",
        title: "My Document"
      },
      {
        dataDir: testDir,
        store,
        smtp: SMTP,
        kindleEmail: user.kindleEmail!
      }
    );

    // Should have created library item
    expect(result.libraryItemId).toBeDefined();
    expect(result.title).toBe("My Document");

    // Should have attempted delivery
    expect(result.delivery).toBeDefined();
    expect(result.delivery!.trigger).toBe("upload");
    expect(result.delivery!.status).toBe("sent");
    expect(result.delivery!.libraryItemId).toBe(result.libraryItemId);

    // Verify email was sent
    const nodemailer = await import("nodemailer");
    const sentMails = (nodemailer as any).__getSentMails();
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0].to).toBe("test@kindle.com");
  });

  it("records delivery failure without deleting the uploaded file", async () => {
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    // Mock sendFileToKindle to throw an error
    const { sendUploadedFile } = await import("../server/fileUpload.js");
    const mailer = await import("../server/mailer.js");
    vi.spyOn(mailer, "sendFileToKindle").mockRejectedValueOnce(new Error("SMTP connection failed"));

    const result = await sendUploadedFile(
      {
        userId: user.id,
        fileBuffer: pdfBytes,
        originalFilename: "document.pdf",
        title: "Failed Upload"
      },
      {
        dataDir: testDir,
        store,
        smtp: SMTP,
        kindleEmail: user.kindleEmail!
      }
    );

    // Library item should still exist
    expect(result.libraryItemId).toBeDefined();
    const libraryItem = store.getLibraryItem(result.libraryItemId);
    expect(libraryItem).toBeDefined();
    expect(libraryItem!.title).toBe("Failed Upload");

    // File should still exist on disk
    const filePath = path.join(testDir, result.storedFilename);
    expect(readFileSync(filePath).equals(pdfBytes)).toBe(true);

    // Delivery should be marked as failed
    expect(result.delivery).toBeDefined();
    expect(result.delivery!.status).toBe("failed");
    expect(result.delivery!.error).toContain("SMTP connection failed");
  });

  it("skips delivery when SMTP is not configured", async () => {
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    const { sendUploadedFile } = await import("../server/fileUpload.js");

    const result = await sendUploadedFile(
      {
        userId: user.id,
        fileBuffer: pdfBytes,
        originalFilename: "document.pdf",
        title: "No SMTP"
      },
      {
        dataDir: testDir,
        store,
        smtp: undefined,
        kindleEmail: user.kindleEmail
      }
    );

    // Library item should be created
    expect(result.libraryItemId).toBeDefined();
    expect(result.title).toBe("No SMTP");

    // No delivery should be attempted
    expect(result.delivery).toBeNull();

    // File should still exist
    const libraryItem = store.getLibraryItem(result.libraryItemId);
    expect(libraryItem).toBeDefined();
  });

  it("skips delivery when Kindle email is not configured", async () => {
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    const { sendUploadedFile } = await import("../server/fileUpload.js");

    const result = await sendUploadedFile(
      {
        userId: user.id,
        fileBuffer: pdfBytes,
        originalFilename: "document.pdf",
        title: "No Kindle"
      },
      {
        dataDir: testDir,
        store,
        smtp: SMTP,
        kindleEmail: undefined
      }
    );

    // Library item should be created
    expect(result.libraryItemId).toBeDefined();
    expect(result.title).toBe("No Kindle");

    // No delivery should be attempted
    expect(result.delivery).toBeNull();
  });
});
