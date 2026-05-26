import { createReadStream } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type { SmtpConfig } from "./config.js";

export async function sendFileToKindle(
  config: SmtpConfig,
  dataDir: string,
  filename: string,
  kindleEmail: string
): Promise<{ messageId?: string; response?: string }> {
  const safeFilename = path.basename(filename);
  if (safeFilename !== filename) {
    throw new Error("Invalid generated file name.");
  }
  const contentType = mimeTypeForFilename(safeFilename);
  if (!contentType) {
    throw new Error("Invalid generated file name.");
  }

  const resolvedDataDir = path.resolve(dataDir);
  const absolutePath = path.resolve(resolvedDataDir, safeFilename);
  if (!absolutePath.startsWith(`${resolvedDataDir}${path.sep}`)) {
    throw new Error("Generated file path escaped the data directory.");
  }

  const transporter = createTransporter(config);

  const info = await transporter.sendMail({
    from: config.from,
    to: kindleEmail,
    subject: "KindleFlow article",
    text: "Attached is your KindleFlow file.",
    attachments: [
      {
        filename: safeFilename,
        content: createReadStream(absolutePath),
        contentType
      }
    ]
  });

  return {
    messageId: typeof info.messageId === "string" ? info.messageId : undefined,
    response: typeof info.response === "string" ? info.response : undefined
  };
}

function mimeTypeForFilename(filename: string): string | undefined {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".epub")) {
    return "application/epub+zip";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  return undefined;
}

function createTransporter(config: SmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined
  });
}
