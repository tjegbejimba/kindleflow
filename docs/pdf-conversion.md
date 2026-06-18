# PDF-to-EPUB Conversion

KindleFlow includes an **experimental** PDF-to-EPUB converter for text-heavy documents. Conversion quality is **document-dependent** — some PDFs convert well, while others may produce poor or unusable results.

## When to use conversion

PDF-to-EPUB conversion works best for:

- **Born-digital PDFs** with reflowable text (e.g., simple articles, reports, essays)
- **Single-column layouts** with minimal formatting
- **Text-first documents** without heavy reliance on images, tables, or diagrams

## Current limitations

The v1 converter is **text-first only** and has significant limitations:

### Not supported in v1:

- **OCR not supported** — Scanned PDFs or image-only pages cannot be converted
- **Scanned PDFs** — Documents consisting of scanned images will fail or produce empty output
- **Tables and figures** — These elements are not preserved with fidelity; tables may become unreadable text
- **Multi-column layouts** — Text extraction may scramble reading order in academic papers or newspapers
- **Exact layout preservation** — The EPUB output is reflowable and will differ from the PDF's fixed layout
- **Complex formatting** — Headers, footers, footnotes, and advanced typography are lost

## What to expect

When you convert a PDF to EPUB:

1. **Conversion is experimental** — Results vary based on the PDF's internal structure
2. **Text-only output** — Only plain text paragraphs are extracted
3. **Provenance note included** — The EPUB will contain a note explaining it was converted from PDF
4. **Layout may differ** — The reflowable EPUB will not match the PDF's original appearance
5. **Some PDFs won't convert** — If text extraction fails, you'll receive an error message

**Important:** The converter makes a best effort to extract readable text, but cannot guarantee high-fidelity conversion for every document type. Results vary significantly depending on the PDF's structure and complexity.

## Choosing between PDF and EPUB

When you fetch a PDF manually, KindleFlow may analyze it and provide a recommendation:

- **"Good EPUB candidate"** — Simple, text-heavy PDFs that should convert reasonably well
- **"Mixed conversion quality"** — PDFs that may convert, but with potential issues
- **"Better as PDF"** — Documents that are better sent as-is (e.g., slide decks, diagrams)
- **"Not convertible"** — Scanned or image-only PDFs that cannot be converted

These recommendations help you make an informed choice, but even "good" candidates may have conversion issues depending on their internal structure.

## Future improvements

The converter interface is designed to support future enhancements, including:

- **Calibre-backed conversion** — A more robust converter using Calibre's PDF tools
- **Better table and figure handling** — Improved preservation of complex elements
- **Layout detection** — Smarter handling of multi-column and academic formats

For maintainer documentation on the converter architecture and extension points, see [docs/architecture/pdf-converter.md](architecture/pdf-converter.md).
