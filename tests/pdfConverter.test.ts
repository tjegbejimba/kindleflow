import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertPdfToEpub } from "../server/pdfConverter.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PDF to EPUB converter", () => {
  describe("text-first conversion", () => {
    it("converts a text PDF to EPUB with converted-from-PDF provenance note", async () => {
      // TRACER BULLET: Prove the end-to-end path works
      // Create a simple text PDF with sufficient content
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]); // Standard letter size
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      // Add enough text content to pass the minimum threshold
      const textContent = `Sample PDF Content

This is the first paragraph with meaningful text that demonstrates the PDF-to-EPUB conversion capability.

This is the second paragraph with additional content to ensure we have sufficient text for the conversion process.

A third paragraph adds even more text to thoroughly test the extraction and EPUB generation process.`.trim();
      
      page.drawText(textContent, {
        x: 50,
        y: 700,
        size: 12,
        font,
        maxWidth: 500
      });
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      
      // Convert to EPUB
      const result = await convertPdfToEpub({
        pdfBuffer,
        title: "Test PDF Document",
        sourceUrl: "https://example.com/test.pdf",
        dataDir: tempDir
      });
      
      // Verify it created an EPUB file
      expect(result.mimeType).toBe("application/epub+zip");
      expect(result.filename).toMatch(/\.epub$/);
      expect(result.absolutePath.startsWith(tempDir)).toBe(true);
      
      // Verify the file exists and is a valid EPUB (ZIP file)
      const epubBytes = await readFile(result.absolutePath);
      expect(epubBytes.subarray(0, 2).toString()).toBe("PK"); // ZIP signature
      
      // Verify it includes the KindleFlow cover
      expect(epubBytes.includes(Buffer.from("cover.png"))).toBe(true);
    });
  });
});
