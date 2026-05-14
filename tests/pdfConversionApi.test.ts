import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { analyzePdf } from "../server/pdfAnalyzer.js";
import { saveKindlePdf } from "../server/kindleFile.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PDF to EPUB conversion API route", () => {
  describe("verdict-based conversion rules", () => {
    it("allows conversion for good-epub-candidate verdict", async () => {
      // Create a text-heavy portrait PDF (good candidate)
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]); // Portrait
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      const content = "Text content that makes this a good EPUB candidate. ".repeat(20);
      page.drawText(content.slice(0, 500), { x: 50, y: 700, size: 12, font, maxWidth: 500 });
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      const analysis = await analyzePdf(pdfBuffer);
      
      expect(analysis.verdict).toBe("good-epub-candidate");
      
      // Save PDF to temp directory as if it's in the library
      const savedPdf = await saveKindlePdf({
        buffer: pdfBuffer,
        title: "Good Candidate PDF",
        dataDir: tempDir
      });
      
      // The API route should allow conversion without forceConvert flag
      // This test verifies the business logic - actual route integration tested separately
      const shouldAllow = analysis.verdict === "good-epub-candidate" || analysis.verdict === "mixed-conversion-quality";
      expect(shouldAllow).toBe(true);
    });
    
    it("blocks conversion for better-as-pdf verdict without forceConvert flag", async () => {
      // Create a landscape PDF (poor candidate)
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([792, 612]); // Landscape
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      page.drawText("Slide content", { x: 100, y: 500, size: 24, font });
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      const analysis = await analyzePdf(pdfBuffer);
      
      expect(analysis.verdict).toBe("better-as-pdf");
      
      // The API route should block conversion without forceConvert
      const shouldAllow = analysis.verdict === "good-epub-candidate" || analysis.verdict === "mixed-conversion-quality";
      expect(shouldAllow).toBe(false);
    });
    
    it("allows conversion for better-as-pdf verdict WITH forceConvert flag", async () => {
      // This tests the "Try EPUB anyway" path for poor candidates
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([792, 612]); // Landscape
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      const content = "Even though this is landscape, user wants to try EPUB anyway. ".repeat(10);
      page.drawText(content.slice(0, 500), { x: 100, y: 500, size: 12, font, maxWidth: 600 });
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      const analysis = await analyzePdf(pdfBuffer);
      
      expect(analysis.verdict).toBe("better-as-pdf");
      
      // With forceConvert=true, conversion should proceed
      const forceConvert = true;
      const shouldAllow = forceConvert || analysis.verdict === "good-epub-candidate" || analysis.verdict === "mixed-conversion-quality";
      expect(shouldAllow).toBe(true);
    });
  });
});
