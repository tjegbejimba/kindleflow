import { createReadStream } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type { SmtpConfig } from "./config.js";

export async function sendMagicLink(config: SmtpConfig, email: string, magicLink: string): Promise<void> {
  const transporter = createTransporter(config);
  await transporter.sendMail({
    from: config.from,
    to: email,
    subject: "Your KindleFlow login link",
    text: `Open this link to sign in to KindleFlow:\n\n${magicLink}\n\nThis link expires in 15 minutes.`,
    html: `<p>Open this link to sign in to KindleFlow:</p><p><a href="${escapeHtml(magicLink)}">Sign in to KindleFlow</a></p><p>This link expires in 15 minutes.</p>`
  });
}

export async function sendFileToKindle(
  config: SmtpConfig,
  dataDir: string,
  filename: string,
  kindleEmail: string
): Promise<{ messageId?: string; response?: string }> {
  const safeFilename = path.basename(filename);
  if (safeFilename !== filename || !safeFilename.endsWith(".epub")) {
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
    text: "Attached is your KindleFlow EPUB.",
    attachments: [
      {
        filename: safeFilename,
        content: createReadStream(absolutePath),
        contentType: "application/epub+zip"
      }
    ]
  });

  return {
    messageId: typeof info.messageId === "string" ? info.messageId : undefined,
    response: typeof info.response === "string" ? info.response : undefined
  };
}

function createTransporter(config: SmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
