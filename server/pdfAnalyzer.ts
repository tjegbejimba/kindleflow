import { PDFDocument } from "pdf-lib";

export type PdfAnalysisVerdict =
  | "good-epub-candidate"
  | "mixed-conversion-quality"
  | "better-as-pdf"
  | "not-convertible"
  | "analysis-unavailable";

export interface PdfAnalysis {
  verdict: PdfAnalysisVerdict;
  reasons: string[];
}

const SAMPLE_PAGE_LIMIT = 10; // Bounded sampling - don't parse huge PDFs exhaustively
const ANALYSIS_TIMEOUT_MS = 3000; // 3 second timeout for safety

/**
 * Analyzes a PDF to determine if it's a good candidate for EPUB conversion.
 * Uses bounded page sampling and timeouts for safety.
 */
export async function analyzePdf(pdfBuffer: Buffer): Promise<PdfAnalysis> {
  try {
    // Race between analysis and timeout
    return await Promise.race([
      performAnalysis(pdfBuffer),
      timeoutFallback(ANALYSIS_TIMEOUT_MS)
    ]);
  } catch (error) {
    // Any error falls back gracefully - PDF import should not fail
    return {
      verdict: "analysis-unavailable",
      reasons: ["PDF analysis could not be completed"]
    };
  }
}

async function performAnalysis(pdfBuffer: Buffer): Promise<PdfAnalysis> {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pageCount = pdfDoc.getPageCount();
  const pagesToSample = Math.min(pageCount, SAMPLE_PAGE_LIMIT);
  
  // Sample pages evenly distributed through document
  const sampleIndices = distributeSamples(pageCount, pagesToSample);
  const pages = sampleIndices.map(i => pdfDoc.getPage(i));
  
  // Analyze page characteristics
  const hasText = await hasExtractableText(pdfDoc, sampleIndices);
  const avgPageSize = calculateAveragePageSize(pages);
  const isLandscape = avgPageSize.width > avgPageSize.height * 1.2; // 20% wider threshold
  
  // Determine verdict based on signals
  if (!hasText) {
    return {
      verdict: "not-convertible",
      reasons: ["This PDF appears to contain mostly images without readable text"]
    };
  }
  
  if (isLandscape) {
    return {
      verdict: "better-as-pdf",
      reasons: ["This PDF uses landscape layout which works best as PDF on Kindle"]
    };
  }
  
  // Default to good candidate for now (text-heavy, portrait)
  return {
    verdict: "good-epub-candidate",
    reasons: ["This PDF contains readable text suitable for conversion"]
  };
}

async function hasExtractableText(pdfDoc: PDFDocument, sampleIndices: number[]): Promise<boolean> {
  // pdf-lib doesn't provide text extraction, so we use a heuristic:
  // Check if document has embedded fonts (indicates text content)
  const embeddedFonts = pdfDoc.context.enumerateIndirectObjects()
    .filter(([_, obj]) => obj.toString().includes("/Font") || obj.toString().includes("/Type/Font"))
    .length;
  
  return embeddedFonts > 0;
}

function calculateAveragePageSize(pages: ReturnType<PDFDocument["getPage"]>[]): { width: number; height: number } {
  let totalWidth = 0;
  let totalHeight = 0;
  
  for (const page of pages) {
    const { width, height } = page.getSize();
    totalWidth += width;
    totalHeight += height;
  }
  
  return {
    width: totalWidth / pages.length,
    height: totalHeight / pages.length
  };
}

function distributeSamples(total: number, sampleCount: number): number[] {
  if (sampleCount >= total) {
    return Array.from({ length: total }, (_, i) => i);
  }
  
  const step = total / sampleCount;
  return Array.from({ length: sampleCount }, (_, i) => Math.floor(i * step));
}

async function timeoutFallback(ms: number): Promise<PdfAnalysis> {
  await new Promise(resolve => setTimeout(resolve, ms));
  return {
    verdict: "analysis-unavailable",
    reasons: ["PDF analysis timed out"]
  };
}

/**
 * Determines if a PDF should auto-send based on analysis verdict.
 * Good and mixed EPUB candidates should pause for user choice.
 * All others (better-as-pdf, not-convertible, analysis-unavailable) continue with auto-send.
 * 
 * Note: This check applies to manual PDF fetches only. Subscription PDFs bypass this
 * check and always auto-send to maintain predictable unattended delivery.
 */
export function shouldAutoSendPdf(verdict: PdfAnalysisVerdict): boolean {
  // Good and mixed candidates should pause for user choice
  if (verdict === "good-epub-candidate" || verdict === "mixed-conversion-quality") {
    return false;
  }
  // All others continue with auto-send
  return true;
}
