import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { analyzePdf } from "../server/pdfAnalyzer.js";

describe("PDF analyzer", () => {
  describe("good EPUB candidate detection", () => {
    it("identifies text-heavy born-digital PDF as good EPUB candidate", async () => {
      // Create a simple text-heavy PDF
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]); // Standard letter size portrait
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      // Add substantial text content (simulates article-like PDF)
      const textContent = "This is a text-heavy document with readable content. ".repeat(50);
      page.drawText(textContent.slice(0, 500), {
        x: 50,
        y: 700,
        size: 12,
        font,
        color: rgb(0, 0, 0),
        maxWidth: 500
      });
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      const analysis = await analyzePdf(pdfBuffer);
      
      expect(analysis.verdict).toBe("good-epub-candidate");
      expect(analysis.reasons).toBeInstanceOf(Array);
      expect(analysis.reasons.length).toBeGreaterThan(0);
      expect(analysis.reasons.length).toBeLessThanOrEqual(2);
      // Reasons should be plain English, not raw scores
      expect(analysis.reasons[0]).toMatch(/text|readable|content/i);
    });
  });

  describe("landscape PDF detection", () => {
    it("identifies landscape PDF as better-as-pdf", async () => {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([792, 612]); // Landscape (width > height)
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      page.drawText("Landscape slide content", {
        x: 100,
        y: 500,
        size: 24,
        font
      });
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      const analysis = await analyzePdf(pdfBuffer);
      
      expect(analysis.verdict).toBe("better-as-pdf");
      expect(analysis.reasons).toBeInstanceOf(Array);
      expect(analysis.reasons.length).toBeGreaterThan(0);
      expect(analysis.reasons[0]).toMatch(/landscape|layout/i);
    });
  });

  describe("image-only PDF detection", () => {
    it("identifies PDF without extractable text as not-convertible", async () => {
      const pdfDoc = await PDFDocument.create();
      // Add page but no text (no embedded fonts = likely scanned/image-only)
      pdfDoc.addPage([612, 792]);
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      const analysis = await analyzePdf(pdfBuffer);
      
      expect(analysis.verdict).toBe("not-convertible");
      expect(analysis.reasons).toBeInstanceOf(Array);
      expect(analysis.reasons.length).toBeGreaterThan(0);
      expect(analysis.reasons[0]).toMatch(/image|without.*text/i);
    });
  });

  describe("analysis failure fallback", () => {
    it("returns analysis-unavailable for corrupt PDF without failing", async () => {
      const corruptBuffer = Buffer.from("This is not a valid PDF");
      const analysis = await analyzePdf(corruptBuffer);
      
      expect(analysis.verdict).toBe("analysis-unavailable");
      expect(analysis.reasons).toBeInstanceOf(Array);
      expect(analysis.reasons.length).toBeGreaterThan(0);
      expect(analysis.reasons[0]).toMatch(/could not be completed|unavailable/i);
    });

    it("uses bounded sampling (does not hang on huge PDFs)", async () => {
      // Create PDF with many pages
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      for (let i = 0; i < 50; i++) {
        const page = pdfDoc.addPage([612, 792]);
        page.drawText(`Page ${i + 1}`, { x: 50, y: 700, size: 12, font });
      }
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      const startTime = Date.now();
      const analysis = await analyzePdf(pdfBuffer);
      const duration = Date.now() - startTime;
      
      // Should complete quickly (bounded sampling, not exhaustive)
      expect(duration).toBeLessThan(5000);
      expect(analysis.verdict).toBeDefined();
    });
  });
});
