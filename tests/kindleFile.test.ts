import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCoverPng } from "../server/coverImage.js";
import { generateKindleFile, saveKindlePdf } from "../server/kindleFile.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("generateKindleFile", () => {
  it("writes an EPUB for an extracted article into the data directory", async () => {
    const file = await generateKindleFile(
      {
        title: "A Clean Kindle Article!",
        contentHtml: "<p>This article becomes an EPUB that can be sent to Kindle.</p>",
        textContent: "This article becomes an EPUB that can be sent to Kindle."
      },
      { dataDir: tempDir, sourceUrl: "https://example.com/articles/clean" }
    );

    expect(file.mimeType).toBe("application/epub+zip");
    expect(file.filename).toMatch(/^a-clean-kindle-article-[a-z0-9]+\.epub$/);
    expect(file.absolutePath.startsWith(tempDir)).toBe(true);

    const bytes = await readFile(file.absolutePath);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(bytes.includes(Buffer.from("cover.png"))).toBe(true);
  });

  it("generates a local PNG cover image for Kindle library thumbnails", () => {
    const cover = generateCoverPng({
      title: "A Clean Kindle Article!",
      sourceUrl: "https://example.com/articles/clean"
    });

    expect(cover.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(cover.includes(Buffer.from("IHDR"))).toBe(true);
    expect(cover.includes(Buffer.from("IDAT"))).toBe(true);
  });

  it("does not embed local files referenced by submitted HTML", async () => {
    const marker = "synthetic-private-file-for-security-regression";
    const privateFile = path.join(tempDir, "private.txt");
    await writeFile(privateFile, marker);

    const file = await generateKindleFile(
      {
        title: "Safe article",
        contentHtml: `<p>Keep this <strong>article</strong>.</p><img src="file://${privateFile}" />`,
        textContent: "Keep this article."
      },
      { dataDir: tempDir }
    );

    const entries = unzipEntries(await readFile(file.absolutePath));
    expect(entries.some((entry) => entry.includes(Buffer.from(marker)))).toBe(false);
    expect(entries.some((entry) => entry.includes(Buffer.from("<strong>article</strong>")))).toBe(true);
    expect(entries.some((entry) => entry.includes(Buffer.from("file://")))).toBe(false);
  });

  it("does not fetch HTTP resources referenced by submitted HTML", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "image/png" });
      response.end(generateCoverPng({ title: "Synthetic internal image" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    try {
      await generateKindleFile(
        {
          title: "Safe article",
          contentHtml: `<p>Keep this article.</p><img src="http://127.0.0.1:${address.port}/private.png" />`,
          textContent: "Keep this article."
        },
        { dataDir: tempDir }
      );
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function unzipEntries(zip: Buffer): Buffer[] {
  const entries: Buffer[] = [];
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const compression = zip.readUInt16LE(offset + 8);
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const bytes = zip.subarray(start, start + size);
    entries.push(compression === 8 ? inflateRawSync(bytes) : bytes);
    offset = start + size;
  }
  return entries;
}

describe("saveKindlePdf", () => {
  it("writes a PDF with a KindleFlow cover page before the original document", async () => {
    const original = await PDFDocument.create();
    original.addPage([320, 480]);
    const pdfBytes = Buffer.from(await original.save());

    const file = await saveKindlePdf({
      buffer: pdfBytes,
      title: "Quarterly Report 2025!",
      dataDir: tempDir,
      sourceUrl: "https://example.com/reports/q4.pdf"
    });

    expect(file.mimeType).toBe("application/pdf");
    expect(file.filename).toMatch(/^quarterly-report-2025-[a-z0-9]+\.pdf$/);
    expect(file.absolutePath.startsWith(tempDir)).toBe(true);

    const written = await readFile(file.absolutePath);
    expect(written.equals(pdfBytes)).toBe(false);

    const saved = await PDFDocument.load(written);
    expect(saved.getPageCount()).toBe(2);
    const [coverPage, originalPage] = saved.getPages();
    expect(coverPage.getWidth()).toBe(450);
    expect(coverPage.getHeight()).toBe(600);
    expect(originalPage.getWidth()).toBe(320);
    expect(originalPage.getHeight()).toBe(480);
  });
});
