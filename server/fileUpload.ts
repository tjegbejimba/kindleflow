import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthStore, KindleDelivery, LibraryItemMimeType } from "./authStore.js";
import type { SmtpConfig } from "./config.js";
import { sendFileToKindle } from "./mailer.js";

export interface SaveUploadedFileInput {
  userId: string;
  fileBuffer: Buffer;
  originalFilename: string;
  title?: string;
}

export interface SaveUploadedFileOptions {
  dataDir: string;
  store: AuthStore;
}

export interface SaveUploadedFileResult {
  libraryItemId: string;
  storedFilename: string;
  title: string;
  mimeType: LibraryItemMimeType;
}

export interface SendUploadedFileOptions {
  dataDir: string;
  store: AuthStore;
  smtp?: SmtpConfig;
  kindleEmail?: string;
}

export interface SendUploadedFileResult {
  libraryItemId: string;
  storedFilename: string;
  title: string;
  mimeType: LibraryItemMimeType;
  delivery: KindleDelivery | null;
}

export async function saveUploadedFile(
  input: SaveUploadedFileInput,
  options: SaveUploadedFileOptions
): Promise<SaveUploadedFileResult> {
  // Validate file type
  const mimeType = detectMimeType(input.originalFilename, input.fileBuffer);
  if (!mimeType) {
    throw new Error("Only PDF and EPUB files are supported.");
  }

  // Validate file size (50 MB limit)
  const MAX_SIZE = 50 * 1024 * 1024;
  if (input.fileBuffer.length > MAX_SIZE) {
    throw new Error("File size exceeds 50 MB limit.");
  }

  // Determine title
  const title = input.title || extractFilenameWithoutExtension(input.originalFilename);

  // Generate safe unique filename
  const id = randomUUID().slice(0, 8);
  const extension = mimeType === "application/pdf" ? ".pdf" : ".epub";
  const storedFilename = `${slugify(title)}-${id}${extension}`;

  // Ensure data directory exists
  const dataDir = path.resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true });

  // Validate path is within data directory
  const absolutePath = path.resolve(dataDir, storedFilename);
  if (!absolutePath.startsWith(`${dataDir}${path.sep}`)) {
    throw new Error("File path escaped the data directory.");
  }

  // Write file with exact bytes
  await writeFile(absolutePath, input.fileBuffer);

  // Create library item
  const libraryItem = options.store.addLibraryItem(input.userId, {
    type: "uploaded_file",
    title,
    filename: storedFilename,
    mimeType,
    sourceUrl: undefined
  });

  return {
    libraryItemId: libraryItem.id,
    storedFilename,
    title,
    mimeType
  };
}

function detectMimeType(filename: string, buffer: Buffer): LibraryItemMimeType | null {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".pdf")) {
    // Verify PDF magic bytes
    if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "%PDF") {
      return "application/pdf";
    }
    return null;
  }

  if (lower.endsWith(".epub")) {
    // EPUB is a ZIP file - check ZIP magic bytes
    if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
      return "application/epub+zip";
    }
    return null;
  }

  return null;
}

function extractFilenameWithoutExtension(filename: string): string {
  const basename = path.basename(filename);
  const lastDot = basename.lastIndexOf(".");
  if (lastDot === -1) {
    return basename;
  }
  return basename.slice(0, lastDot);
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "upload";
}

export async function sendUploadedFile(
  input: SaveUploadedFileInput,
  options: SendUploadedFileOptions
): Promise<SendUploadedFileResult> {
  // First, save the file
  const saved = await saveUploadedFile(input, options);

  // Decide whether to attempt delivery
  const shouldDeliver = Boolean(options.smtp && options.kindleEmail);

  if (!shouldDeliver) {
    return {
      ...saved,
      delivery: null
    };
  }

  // Create delivery record
  const delivery = options.store.createKindleDelivery(input.userId, {
    libraryItemId: saved.libraryItemId,
    title: saved.title,
    filename: saved.storedFilename,
    kindleEmail: options.kindleEmail!,
    trigger: "upload"
  });

  // Attempt to send
  try {
    const result = await sendFileToKindle(
      options.smtp!,
      options.dataDir,
      saved.storedFilename,
      options.kindleEmail!,
      saved.title + path.extname(saved.storedFilename)
    );

    const sentDelivery = options.store.recordKindleDeliveryResult(delivery.id, {
      status: "sent",
      messageId: result.messageId,
      response: result.response
    });

    return {
      ...saved,
      delivery: sentDelivery
    };
  } catch (error) {
    const failedDelivery = options.store.recordKindleDeliveryResult(delivery.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Upload delivery failed."
    });

    return {
      ...saved,
      delivery: failedDelivery
    };
  }
}
