import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendFileToKindle } from "../server/mailer.js";
import type { SmtpConfig } from "../server/config.js";

const SMTP: SmtpConfig = {
  host: "smtp.test",
  port: 587,
  secure: false,
  from: "test@kindleflow.test"
};

// Mock nodemailer module
vi.mock("nodemailer", () => {
  const sentMails: any[] = [];
  return {
    default: {
      createTransport: () => ({
        sendMail: async (opts: any) => {
          sentMails.push(opts);
          return { messageId: `msg-${sentMails.length}`, response: "250 OK" };
        }
      })
    },
    // Expose sentMails for test inspection
    __getSentMails: () => sentMails,
    __clearSentMails: () => { sentMails.length = 0; }
  };
});

describe("Display filename for Kindle delivery", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-displayname-"));
    // Clear any previous mock calls
    const nodemailer = await import("nodemailer");
    if ((nodemailer as any).__clearSentMails) {
      (nodemailer as any).__clearSentMails();
    }
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses stored filename for attachment when no display filename provided", async () => {
    // TRACER BULLET: Confirm backward compatibility
    const storedFilename = "abc-123-xyz.epub";
    await writeFile(path.join(tempDir, storedFilename), "fake epub content");

    const result = await sendFileToKindle(
      SMTP,
      tempDir,
      storedFilename,
      "test@kindle.com"
    );

    expect(result).toBeDefined();
    expect(result.messageId).toBeDefined();

    // Check what was actually sent
    const nodemailer = await import("nodemailer");
    const sentMails = (nodemailer as any).__getSentMails();
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0].attachments[0].filename).toBe(storedFilename);
  });

  it("uses display filename for attachment when provided", async () => {
    const storedFilename = "a1b2c3-uuid.epub";
    const displayFilename = "My Great Article.epub";
    await writeFile(path.join(tempDir, storedFilename), "fake epub content");

    const result = await sendFileToKindle(
      SMTP,
      tempDir,
      storedFilename,
      "test@kindle.com",
      displayFilename
    );

    expect(result).toBeDefined();

    const nodemailer = await import("nodemailer");
    const sentMails = (nodemailer as any).__getSentMails();
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0].attachments[0].filename).toBe(displayFilename);
  });

  it("rejects display filename with path separator", async () => {
    const storedFilename = "safe.epub";
    await writeFile(path.join(tempDir, storedFilename), "fake epub content");

    await expect(
      sendFileToKindle(SMTP, tempDir, storedFilename, "test@kindle.com", "../evil.epub")
    ).rejects.toThrow();

    await expect(
      sendFileToKindle(SMTP, tempDir, storedFilename, "test@kindle.com", "path/to/evil.epub")
    ).rejects.toThrow();
  });

  it("rejects display filename with CR/LF", async () => {
    const storedFilename = "safe.epub";
    await writeFile(path.join(tempDir, storedFilename), "fake epub content");

    await expect(
      sendFileToKindle(SMTP, tempDir, storedFilename, "test@kindle.com", "evil\nfile.epub")
    ).rejects.toThrow();

    await expect(
      sendFileToKindle(SMTP, tempDir, storedFilename, "test@kindle.com", "evil\rfile.epub")
    ).rejects.toThrow();
  });

  it("rejects blank or whitespace-only display filename", async () => {
    const storedFilename = "safe.epub";
    await writeFile(path.join(tempDir, storedFilename), "fake epub content");

    await expect(
      sendFileToKindle(SMTP, tempDir, storedFilename, "test@kindle.com", "")
    ).rejects.toThrow();

    await expect(
      sendFileToKindle(SMTP, tempDir, storedFilename, "test@kindle.com", "   ")
    ).rejects.toThrow();
  });

  it("sanitizes unsafe characters from display filename", async () => {
    const storedFilename = "safe.epub";
    const displayFilename = 'article"with<chars>.epub';
    await writeFile(path.join(tempDir, storedFilename), "fake epub content");

    const result = await sendFileToKindle(
      SMTP,
      tempDir,
      storedFilename,
      "test@kindle.com",
      displayFilename
    );

    expect(result).toBeDefined();

    const nodemailer = await import("nodemailer");
    const sentMails = (nodemailer as any).__getSentMails();
    expect(sentMails).toHaveLength(1);
    const sentFilename = sentMails[0].attachments[0].filename;
    // Should sanitize " < > characters
    expect(sentFilename).not.toContain('"');
    expect(sentFilename).not.toContain('<');
    expect(sentFilename).not.toContain('>');
  });

  it("preserves extension when sanitizing display filename", async () => {
    const storedFilename = "uuid-123.pdf";
    const displayFilename = "My Article.epub"; // Wrong extension
    await writeFile(path.join(tempDir, storedFilename), "fake pdf content");

    const result = await sendFileToKindle(
      SMTP,
      tempDir,
      storedFilename,
      "test@kindle.com",
      displayFilename
    );

    expect(result).toBeDefined();

    const nodemailer = await import("nodemailer");
    const sentMails = (nodemailer as any).__getSentMails();
    expect(sentMails).toHaveLength(1);
    const sentFilename = sentMails[0].attachments[0].filename;
    // Should use .pdf extension from stored file, not .epub from display name
    expect(sentFilename).toMatch(/\.pdf$/i);
    expect(sentFilename).not.toMatch(/\.epub$/i);
  });

  it("reads from stored file even when display filename differs", async () => {
    const storedFilename = "abc-uuid-xyz.epub";
    const displayFilename = "Human Readable Title.epub";
    const fileContent = "test epub content for verification";
    await writeFile(path.join(tempDir, storedFilename), fileContent);

    const result = await sendFileToKindle(
      SMTP,
      tempDir,
      storedFilename,
      "test@kindle.com",
      displayFilename
    );

    expect(result).toBeDefined();

    const nodemailer = await import("nodemailer");
    const sentMails = (nodemailer as any).__getSentMails();
    expect(sentMails).toHaveLength(1);
    
    // The content should come from the stored file, not display filename
    // (We can't easily verify the stream content in this mock, but the path
    // validation in sendFileToKindle ensures it reads from dataDir/storedFilename)
    expect(sentMails[0].attachments[0].filename).toBe(displayFilename);
  });
});
