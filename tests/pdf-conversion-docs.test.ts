import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const projectRoot = join(__dirname, "..");

describe("PDF Conversion Documentation", () => {
  describe("User-facing documentation", () => {
    it("should have a PDF conversion guide file", () => {
      const docPath = join(projectRoot, "docs", "pdf-conversion.md");
      expect(existsSync(docPath)).toBe(true);
    });

    it("should explain that PDF-to-EPUB conversion is experimental", () => {
      const docPath = join(projectRoot, "docs", "pdf-conversion.md");
      const content = readFileSync(docPath, "utf-8");
      expect(content.toLowerCase()).toContain("experimental");
    });

    it("should explain that conversion is document-dependent", () => {
      const docPath = join(projectRoot, "docs", "pdf-conversion.md");
      const content = readFileSync(docPath, "utf-8");
      expect(content.toLowerCase()).toMatch(/document[- ]dependent|depends on.*document|varies.*document/);
    });

    it("should state that OCR is not supported", () => {
      const docPath = join(projectRoot, "docs", "pdf-conversion.md");
      const content = readFileSync(docPath, "utf-8");
      expect(content.toLowerCase()).toMatch(/no.*ocr|not.*support.*ocr|ocr.*not.*supported/);
    });

    it("should state that scanned PDFs are not supported", () => {
      const docPath = join(projectRoot, "docs", "pdf-conversion.md");
      const content = readFileSync(docPath, "utf-8");
      expect(content.toLowerCase()).toMatch(/scanned.*pdf|image.*only.*pdf/);
    });

    it("should state that table and figure fidelity is not supported", () => {
      const docPath = join(projectRoot, "docs", "pdf-conversion.md");
      const content = readFileSync(docPath, "utf-8");
      const lowerContent = content.toLowerCase();
      expect(lowerContent).toMatch(/table|figure/);
      expect(lowerContent).toMatch(/not.*support|no.*fidelity|limited/);
    });

    it("should state that exact layout preservation is not supported", () => {
      const docPath = join(projectRoot, "docs", "pdf-conversion.md");
      const content = readFileSync(docPath, "utf-8");
      expect(content.toLowerCase()).toMatch(/layout.*differ|layout.*not.*preserved|formatting.*differ/);
    });

    it("should not imply that all PDFs convert cleanly", () => {
      const docPath = join(projectRoot, "docs", "pdf-conversion.md");
      const content = readFileSync(docPath, "utf-8");
      const lowerContent = content.toLowerCase();
      
      // Should not contain overconfident language
      expect(lowerContent).not.toMatch(/all pdfs.*convert|every pdf.*convert|perfect.*conversion/);
      
      // Should contain qualifying language
      expect(lowerContent).toMatch(/may|might|some|experimental|limited|varies/);
    });
  });

  describe("Maintainer-facing documentation", () => {
    it("should have architecture documentation about the converter", () => {
      const docPath = join(projectRoot, "docs", "architecture", "pdf-converter.md");
      expect(existsSync(docPath)).toBe(true);
    });

    it("should identify the converter interface", () => {
      const docPath = join(projectRoot, "docs", "architecture", "pdf-converter.md");
      const content = readFileSync(docPath, "utf-8");
      expect(content).toContain("ConvertPdfToEpubOptions");
      expect(content).toContain("convertPdfToEpub");
    });

    it("should explain how a Calibre-backed implementation could plug in", () => {
      const docPath = join(projectRoot, "docs", "architecture", "pdf-converter.md");
      const content = readFileSync(docPath, "utf-8");
      const lowerContent = content.toLowerCase();
      expect(lowerContent).toMatch(/calibre/);
      expect(lowerContent).toMatch(/plug.*in|replace|swap|alternative.*implementation/);
    });

    it("should document the converter interface contract", () => {
      const docPath = join(projectRoot, "docs", "architecture", "pdf-converter.md");
      const content = readFileSync(docPath, "utf-8");
      expect(content).toMatch(/pdfBuffer|title|sourceUrl|dataDir/);
    });
  });
});
