import { createReadStream } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type { SmtpConfig } from "./config.js";

export async function sendFileToKindle(
  config: SmtpConfig,
  dataDir: string,
  filename: string,
  kindleEmail: string,
  displayFilename?: string
): Promise<{ messageId?: string; response?: string }> {
  // Validate stored filename (for data directory lookup)
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

  // Validate and sanitize display filename if provided
  let attachmentFilename: string;
  if (displayFilename !== undefined) {
    attachmentFilename = sanitizeDisplayFilename(displayFilename, path.extname(safeFilename));
  } else {
    attachmentFilename = safeFilename;
  }

  const transporter = createTransporter(config);

  const info = await transporter.sendMail({
    from: config.from,
    to: kindleEmail,
    subject: "KindleFlow article",
    text: "Attached is your KindleFlow file.",
    attachments: [
      {
        filename: attachmentFilename,
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

function sanitizeDisplayFilename(displayName: string, extension: string): string {
  // Reject blank or whitespace-only
  if (!displayName || !displayName.trim()) {
    throw new Error("Display filename cannot be blank.");
  }

  // Reject path separators
  if (displayName.includes("/") || displayName.includes("\\") || displayName.includes(path.sep)) {
    throw new Error("Display filename cannot contain path separators.");
  }

  // Reject CR/LF
  if (displayName.includes("\r") || displayName.includes("\n")) {
    throw new Error("Display filename cannot contain CR/LF characters.");
  }

  // Sanitize unsafe characters: replace with underscore
  // Keep alphanumeric, spaces, hyphens, underscores, dots, and basic punctuation
  let sanitized = displayName.replace(/[<>:"|?*\x00-\x1F]/g, "_");

  // Ensure it has the correct extension
  if (!sanitized.toLowerCase().endsWith(extension.toLowerCase())) {
    // Strip any existing extension and add the correct one
    const lastDot = sanitized.lastIndexOf(".");
    if (lastDot > 0) {
      sanitized = sanitized.substring(0, lastDot);
    }
    sanitized = sanitized + extension;
  }

  return sanitized;
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
