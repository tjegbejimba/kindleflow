import { PDFParse } from "pdf-parse";
import { generateKindleFile, type GeneratedKindleFile } from "./kindleFile.js";

export interface ConvertPdfToEpubOptions {
  pdfBuffer: Buffer;
  title: string;
  sourceUrl?: string;
  dataDir: string;
}

/**
 * Converts a PDF to EPUB using text-first extraction.
 * 
 * This is an experimental converter that extracts reflowable text from born-digital PDFs
 * and generates an EPUB using KindleFlow's existing EPUB generation path. The output
 * includes a provenance note explaining that the book was converted from PDF and that
 * layout may differ from the original.
 * 
 * Limitations:
 * - Text-first only (no OCR, figures, tables, or layout fidelity)
 * - Best for simple, text-heavy documents
 * - Not suitable for scanned PDFs, multi-column layouts, or complex formatting
 */
export async function convertPdfToEpub(options: ConvertPdfToEpubOptions): Promise<GeneratedKindleFile> {
  // Extract text from PDF
  const parser = new PDFParse({ data: options.pdfBuffer });
  const parsed = await parser.getText();
  const extractedText = parsed.text.trim();
  
  if (!extractedText) {
    throw new Error("No text content could be extracted from this PDF");
  }
  
  // Require minimum text length for meaningful conversion
  if (extractedText.length < 100) {
    throw new Error("This PDF contains insufficient text for meaningful conversion");
  }
  
  // Convert plain text to simple HTML paragraphs
  const paragraphs = extractedText
    .split(/\n\n+/) // Split on double newlines
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => `<p>${escapeHtml(p.replace(/\n/g, " "))}</p>`);
  
  // Prepend provenance note
  const provenanceNote = `<p><em>Note: This book was converted from a PDF. Layout and formatting may differ from the original.</em></p>`;
  const contentHtml = provenanceNote + "\n" + paragraphs.join("\n");
  
  // Generate EPUB using existing KindleFlow EPUB generation path
  return generateKindleFile(
    {
      title: options.title,
      contentHtml,
      textContent: extractedText
    },
    {
      dataDir: options.dataDir,
      sourceUrl: options.sourceUrl
    }
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
