import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { PdfAnalysisVerdict } from "../server/pdfAnalyzer.js";
import { shouldAutoSendPdf } from "../server/pdfAnalyzer.js";

// Test auto-send pause behavior for PDFs based on analysis verdict

describe("PDF auto-send pause on analysis verdict", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("continues auto-send for better-as-pdf verdict when auto-send enabled", async () => {
    // This is the tracer bullet - tests that current safe behavior is preserved
    const verdict: PdfAnalysisVerdict = "better-as-pdf";
    
    // Verify the decision logic
    expect(shouldAutoSendPdf(verdict)).toBe(true);
  });

  it("pauses auto-send for good-epub-candidate verdict when auto-send enabled", async () => {
    const verdict: PdfAnalysisVerdict = "good-epub-candidate";
    
    // Verify the decision logic - should NOT auto-send
    expect(shouldAutoSendPdf(verdict)).toBe(false);
  });

  it("pauses auto-send for mixed-conversion-quality verdict when auto-send enabled", async () => {
    const verdict: PdfAnalysisVerdict = "mixed-conversion-quality";
    
    // Verify the decision logic - should NOT auto-send
    expect(shouldAutoSendPdf(verdict)).toBe(false);
  });

  it("continues auto-send for not-convertible verdict when auto-send enabled", async () => {
    const verdict: PdfAnalysisVerdict = "not-convertible";
    
    // Verify the decision logic - should auto-send
    expect(shouldAutoSendPdf(verdict)).toBe(true);
  });

  it("continues auto-send for analysis-unavailable verdict when auto-send enabled", async () => {
    const verdict: PdfAnalysisVerdict = "analysis-unavailable";
    
    // Verify the decision logic - should auto-send (safe fallback)
    expect(shouldAutoSendPdf(verdict)).toBe(true);
  });
});
