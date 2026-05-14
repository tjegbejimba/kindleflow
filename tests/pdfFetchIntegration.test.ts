import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";

// Test PDF analysis integration through the articleFetcher public interface

describe("PDF fetch with analysis", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes analysis verdict and reasons for text-heavy PDF", async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    page.drawText("Article content ".repeat(50), {
      x: 50,
      y: 700,
      size: 12,
      font,
      maxWidth: 500
    });
    const pdfBuffer = Buffer.from(await pdfDoc.save());

    mockFetch.mockResolvedValueOnce(
      new Response(pdfBuffer, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="article.pdf"'
        }
      })
    );

    const { fetchAndExtractArticle } = await import("../server/articleFetcher.js");
    const result = await fetchAndExtractArticle("https://example.com/article.pdf");

    expect(result.kind).toBe("pdf");
    if (result.kind !== "pdf") throw new Error("expected pdf");
    
    // Should include analysis data
    expect(result).toHaveProperty("analysis");
    expect(result.analysis.verdict).toBe("good-epub-candidate");
    expect(result.analysis.reasons).toBeInstanceOf(Array);
    expect(result.analysis.reasons.length).toBeGreaterThan(0);
  });

  it("includes landscape verdict for wide PDF", async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([792, 612]); // Landscape
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    page.drawText("Landscape slide", { x: 100, y: 500, size: 24, font });
    const pdfBuffer = Buffer.from(await pdfDoc.save());

    mockFetch.mockResolvedValueOnce(
      new Response(pdfBuffer, {
        headers: { "content-type": "application/pdf" }
      })
    );

    const { fetchAndExtractArticle } = await import("../server/articleFetcher.js");
    const result = await fetchAndExtractArticle("https://example.com/slides.pdf");

    expect(result.kind).toBe("pdf");
    if (result.kind !== "pdf") throw new Error("expected pdf");
    
    expect(result).toHaveProperty("analysis");
    expect(result.analysis.verdict).toBe("better-as-pdf");
  });

  it("includes not-convertible verdict for image-only PDF", async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([612, 792]); // No text
    const pdfBuffer = Buffer.from(await pdfDoc.save());

    mockFetch.mockResolvedValueOnce(
      new Response(pdfBuffer, {
        headers: { "content-type": "application/pdf" }
      })
    );

    const { fetchAndExtractArticle } = await import("../server/articleFetcher.js");
    const result = await fetchAndExtractArticle("https://example.com/scan.pdf");

    expect(result.kind).toBe("pdf");
    if (result.kind !== "pdf") throw new Error("expected pdf");
    
    expect(result).toHaveProperty("analysis");
    expect(result.analysis.verdict).toBe("not-convertible");
  });
});
