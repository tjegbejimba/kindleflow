import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
});

describe("saveKindlePdf", () => {
  it("writes a PDF buffer to the data directory with a slugified filename", async () => {
    const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("Hello Kindle.\n%%EOF\n")]);
    const file = await saveKindlePdf({
      buffer: pdfBytes,
      title: "Quarterly Report 2025!",
      dataDir: tempDir
    });

    expect(file.mimeType).toBe("application/pdf");
    expect(file.filename).toMatch(/^quarterly-report-2025-[a-z0-9]+\.pdf$/);
    expect(file.absolutePath.startsWith(tempDir)).toBe(true);

    const written = await readFile(file.absolutePath);
    expect(written.equals(pdfBytes)).toBe(true);
  });
});
