import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";

/**
 * Slice #10 — Preserve subscription PDF behavior under the conversion model.
 *
 * The PRD (#4) splits PDF handling: manual fetches get the guided analyzer/
 * converter flow (pause on good/mixed verdicts, opt-in EPUB conversion), but
 * subscription deliveries must stay PDF-only in v1 so unattended delivery is
 * predictable. This file locks that contract down with regression tests over
 * the public surface of `pollSubscriptions`.
 *
 * Acceptance criteria covered here (from issue #10):
 *   1. Subscription PDFs continue to save and send as covered PDFs.
 *   2. Subscription PDF delivery is not paused for a manual conversion choice.
 *   3. Subscription PDFs are not automatically converted to EPUB in v1.
 *   4. Tests cover subscription PDF behavior after the analyzer/converter
 *      code exists.
 */

// Mock the mailer so SMTP isn't actually called. We also use the mock as a
// spy to verify that subscription PDFs are sent with .pdf filenames.
const sendFileToKindleMock = vi.fn(
  async (
    _config: unknown,
    _dataDir: string,
    _filename: string,
    _kindleEmail: string
  ): Promise<{ messageId?: string; response?: string }> => ({ messageId: "test-msg", response: "250 OK" })
);
vi.mock("../server/mailer.js", () => ({
  sendFileToKindle: sendFileToKindleMock,
  sendLoginCode: vi.fn(async () => {})
}));

// Mock the PDF converter so we can assert it is NEVER called from the
// subscription path, regardless of analyzer verdict.
const convertPdfToEpubMock = vi.fn(async (): Promise<never> => {
  throw new Error("convertPdfToEpub must not be called from the subscription poller");
});
vi.mock("../server/pdfConverter.js", () => ({
  convertPdfToEpub: convertPdfToEpubMock
}));

const POST_URL = "https://example.com/posts/the-pdf-post";
const FEED_URL = "https://example.com/feed";

async function buildTextHeavyPdf(): Promise<Buffer> {
  // Portrait, text-heavy → analyzer returns "good-epub-candidate" (the verdict
  // that pauses MANUAL fetches). Subscriptions must still deliver.
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]); // US Letter portrait
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText("Article body content ".repeat(60), {
    x: 50,
    y: 700,
    size: 12,
    font,
    maxWidth: 500
  });
  return Buffer.from(await pdfDoc.save());
}

async function buildLandscapePdf(): Promise<Buffer> {
  // Landscape → analyzer returns "better-as-pdf". Subscriptions deliver this
  // identically; included to show behavior is verdict-agnostic.
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([792, 612]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText("Slide deck content", { x: 100, y: 500, size: 24, font });
  return Buffer.from(await pdfDoc.save());
}

function feedXmlFor(postUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>The PDF Post</title>
      <link>${postUrl}</link>
      <guid>${postUrl}</guid>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>
  </channel>
</rss>`;
}

function makeFetchStub(pdfBuffer: Buffer): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith(FEED_URL)) {
      return new Response(feedXmlFor(POST_URL), {
        headers: { "content-type": "application/rss+xml" }
      });
    }

    if (url.startsWith(POST_URL)) {
      return new Response(new Uint8Array(pdfBuffer), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="the-pdf-post.pdf"'
        }
      });
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  return fetchMock;
}

type PollLogger = Parameters<typeof import("../server/subscriptionPoller.js").pollSubscriptions>[2];

interface Harness {
  tempDir: string;
  dataDir: string;
  store: import("../server/authStore.js").AuthStore;
  userId: string;
  subscriptionId: string;
  config: import("../server/config.js").AppConfig;
  logger: PollLogger;
}

async function setupHarness(): Promise<Harness> {
  const { AuthStore } = await import("../server/authStore.js");

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-sub-pdf-"));
  const dataDir = path.join(tempDir, "data");
  const store = new AuthStore(path.join(tempDir, "kindleflow.sqlite"));

  // Create + verify a user, set their Kindle email, and enable auto-send.
  store.createLoginCode("reader@example.com", "secret", "secret");
  const loginCode = store.createLoginCode("reader@example.com", "__already_invited__", undefined);
  const sessionToken = store.consumeLoginCode("reader@example.com", loginCode);
  const user = store.getUserBySession(sessionToken);
  if (!user) throw new Error("user setup failed");
  store.updateUserProfile(user.id, {
    kindleEmail: "reader@kindle.example.com",
    autoSendToKindle: true
  });

  const subscription = store.addSubscription(user.id, {
    feedUrl: FEED_URL,
    sourceUrl: "https://example.com",
    title: "Example Feed"
  });

  const config: import("../server/config.js").AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    dbPath: path.join(tempDir, "kindleflow.sqlite"),
    inviteCodesFile: path.join(tempDir, "invite-codes.txt"),
    appBaseUrl: "http://localhost",
    cookieSecure: false,
    sessionTtlDays: 30,
    smtp: {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      from: "kindleflow@example.com"
    }
  };

  const logger: PollLogger = {
    info: vi.fn() as unknown as PollLogger["info"],
    warn: vi.fn() as unknown as PollLogger["warn"],
    error: vi.fn() as unknown as PollLogger["error"]
  };

  return { tempDir, dataDir, store, userId: user.id, subscriptionId: subscription.id, config, logger };
}

describe("Subscription PDF behavior under the conversion model", () => {
  let harness: Harness;

  beforeEach(() => {
    sendFileToKindleMock.mockClear();
    convertPdfToEpubMock.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (harness) {
      harness.store.close();
      await rm(harness.tempDir, { recursive: true, force: true });
    }
  });

  it("delivers a good-EPUB-candidate subscription PDF as a covered PDF (no pause, no conversion)", async () => {
    harness = await setupHarness();
    const pdfBuffer = await buildTextHeavyPdf();
    vi.stubGlobal("fetch", makeFetchStub(pdfBuffer));

    const { pollSubscriptions } = await import("../server/subscriptionPoller.js");
    const result = await pollSubscriptions(harness.store, harness.config, harness.logger);

    // (2) Not paused: the post was delivered even though analyzer verdict for
    //     this PDF would be "good-epub-candidate" (which pauses manual fetches).
    expect(result).toEqual({ checked: 1, delivered: 1 });
    expect(harness.store.hasDeliveredPost(harness.subscriptionId, POST_URL, POST_URL)).toBe(true);

    // (1) Saved and sent as a covered PDF.
    const libraryItems = harness.store.listLibraryItemsBySubscription(harness.userId, harness.subscriptionId);
    expect(libraryItems).toHaveLength(1);
    expect(libraryItems[0].mimeType).toBe("application/pdf");
    expect(libraryItems[0].filename).toMatch(/\.pdf$/);

    expect(sendFileToKindleMock).toHaveBeenCalledTimes(1);
    const sentFilename = sendFileToKindleMock.mock.calls[0][2];
    expect(sentFilename).toMatch(/\.pdf$/);
    expect(sentFilename).toBe(libraryItems[0].filename);

    const deliveries = harness.store.listKindleDeliveries(harness.userId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("sent");
    expect(deliveries[0].trigger).toBe("subscription");
    expect(deliveries[0].filename).toMatch(/\.pdf$/);

    // (3) Not converted: converter never invoked, no EPUB library item, no
    //     temporary-file record (the converted-EPUB retention path from
    //     slice #16) was created for this user.
    expect(convertPdfToEpubMock).not.toHaveBeenCalled();
    expect(libraryItems.some((item) => item.mimeType === "application/epub+zip")).toBe(false);
    expect(harness.store.listTemporaryFiles(harness.userId)).toEqual([]);

    // No .epub file was written to disk for this subscription delivery.
    const writtenFiles = await readdir(harness.dataDir);
    expect(writtenFiles.some((name) => name.endsWith(".epub"))).toBe(false);
    expect(writtenFiles.some((name) => name.endsWith(".pdf"))).toBe(true);
  });

  it("delivers a landscape (better-as-pdf) subscription PDF identically — behavior is verdict-agnostic", async () => {
    harness = await setupHarness();
    const pdfBuffer = await buildLandscapePdf();
    vi.stubGlobal("fetch", makeFetchStub(pdfBuffer));

    const { pollSubscriptions } = await import("../server/subscriptionPoller.js");
    const result = await pollSubscriptions(harness.store, harness.config, harness.logger);

    expect(result).toEqual({ checked: 1, delivered: 1 });

    const libraryItems = harness.store.listLibraryItemsBySubscription(harness.userId, harness.subscriptionId);
    expect(libraryItems).toHaveLength(1);
    expect(libraryItems[0].mimeType).toBe("application/pdf");

    expect(sendFileToKindleMock).toHaveBeenCalledTimes(1);
    expect(sendFileToKindleMock.mock.calls[0][2]).toMatch(/\.pdf$/);

    expect(convertPdfToEpubMock).not.toHaveBeenCalled();
    expect(harness.store.listTemporaryFiles(harness.userId)).toEqual([]);
  });
});
