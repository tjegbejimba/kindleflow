# PDF Converter Architecture

## Overview

KindleFlow's PDF-to-EPUB converter is designed as a **pluggable module** with a simple interface. The v1 implementation is text-first and experimental, but the architecture allows for future improvements including a Calibre-backed implementation.

## Current implementation

### Interface

The converter exposes a single function with a small, stable interface:

```typescript
export interface ConvertPdfToEpubOptions {
  pdfBuffer: Buffer;      // The PDF file content
  title: string;          // Document title for EPUB metadata
  sourceUrl?: string;     // Optional source URL for provenance
  dataDir: string;        // Directory for EPUB output
}

export async function convertPdfToEpub(
  options: ConvertPdfToEpubOptions
): Promise<GeneratedKindleFile>
```

### Return type

The function returns a `GeneratedKindleFile` from the existing EPUB generation path, ensuring consistent behavior with article EPUBs:

```typescript
interface GeneratedKindleFile {
  filePath: string;           // Absolute path to generated EPUB
  mimeType: "application/epub+zip";
  sizeBytes: number;
}
```

### Current implementation approach

The v1 converter (`server/pdfConverter.ts`) uses:

1. **PDF-parse library** — Extracts plain text from born-digital PDFs
2. **Text-first extraction** — Converts PDF text to simple HTML paragraphs
3. **Existing EPUB generator** — Reuses `generateKindleFile()` for consistent output
4. **Provenance note** — Includes a note explaining the EPUB was converted from PDF

### Limitations of v1

- **No OCR** — Cannot handle scanned PDFs or image-only pages
- **No layout preservation** — Fixed-layout PDFs become reflowable text
- **No table/figure fidelity** — Complex elements are lost or garbled
- **Basic text extraction** — No semantic understanding of document structure

## Plugging in a Calibre-backed implementation

### Why Calibre?

[Calibre](https://calibre-ebook.com/) is a mature ebook library manager with robust PDF-to-EPUB conversion. A Calibre-backed converter could provide:

- **Better layout detection** — Handle multi-column academic papers
- **Improved table/figure handling** — Preserve more complex elements
- **OCR support** — Process scanned PDFs (with Calibre's OCR plugins)
- **Smarter text extraction** — Use Calibre's years of PDF heuristics

### Extension point: Alternative implementations

To swap in a Calibre-backed converter:

1. **Install Calibre** on the KindleFlow server (Docker image or host)
2. **Create `server/pdfConverterCalibre.ts`** that implements the same interface:

```typescript
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKindleFile, type GeneratedKindleFile } from "./kindleFile.js";

export async function convertPdfToEpub(
  options: ConvertPdfToEpubOptions
): Promise<GeneratedKindleFile> {
  // Write PDF to temp file
  const tempPdfPath = join(tmpdir(), `input-${Date.now()}.pdf`);
  await writeFile(tempPdfPath, options.pdfBuffer);
  
  // Call `ebook-convert` CLI
  const tempEpubPath = join(tmpdir(), `output-${Date.now()}.epub`);
  await runCalibreConvert(tempPdfPath, tempEpubPath, options.title);
  
  // Read Calibre's EPUB output and pass to KindleFlow's EPUB wrapper
  const calibreEpubBuffer = await readFile(tempEpubPath);
  
  // Clean up temp files
  await Promise.all([unlink(tempPdfPath), unlink(tempEpubPath)]);
  
  // Return wrapped EPUB (adds KindleFlow cover + provenance)
  return wrapCalibreEpub(calibreEpubBuffer, options);
}

async function runCalibreConvert(
  inputPath: string,
  outputPath: string,
  title: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ebook-convert", [
      inputPath,
      outputPath,
      "--title", title,
      "--enable-heuristics",
      "--pdf-hyphenate"
    ]);
    
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Calibre conversion failed with code ${code}`));
    });
  });
}
```

3. **Replace the import** in routes that call the converter:

```typescript
// Before:
import { convertPdfToEpub } from "./pdfConverter.js";

// After:
import { convertPdfToEpub } from "./pdfConverterCalibre.js";
```

### Interface contract

Any alternative converter implementation must:

1. **Accept** `ConvertPdfToEpubOptions` with `pdfBuffer`, `title`, `sourceUrl?`, `dataDir`
2. **Return** a `Promise<GeneratedKindleFile>` with `filePath`, `mimeType`, `sizeBytes`
3. **Throw** an error if conversion fails (e.g., `throw new Error("Conversion failed")`)
4. **Include a provenance note** explaining the EPUB was converted from PDF
5. **Use `generateKindleFile()`** or ensure output matches KindleFlow EPUB conventions (cover page, metadata)

### Configuration

To make the converter pluggable via config:

```typescript
// server/config.ts
export interface Config {
  // ... existing fields
  pdfConverter: "text-first" | "calibre";
}

// server/pdfConverter.ts (wrapper)
import { convertPdfToEpub as convertTextFirst } from "./pdfConverterTextFirst.js";
import { convertPdfToEpub as convertCalibre } from "./pdfConverterCalibre.js";
import { getConfig } from "./config.js";

export async function convertPdfToEpub(
  options: ConvertPdfToEpubOptions
): Promise<GeneratedKindleFile> {
  const config = getConfig();
  
  if (config.pdfConverter === "calibre") {
    return convertCalibre(options);
  }
  
  return convertTextFirst(options);
}
```

## Testing considerations

When implementing a Calibre-backed converter:

1. **Mock Calibre calls in tests** — Don't require Calibre installed in CI
2. **Provide fixture EPUBs** — Test the wrapper logic without spawning processes
3. **Test timeout handling** — Calibre can hang on malformed PDFs
4. **Test error cases** — Ensure graceful failures for unsupported PDFs

Example test structure:

```typescript
describe("Calibre PDF converter", () => {
  it("should call ebook-convert with correct arguments", async () => {
    // Mock spawn to capture CLI args
    // Assert correct paths, title, flags
  });
  
  it("should throw on conversion failure", async () => {
    // Mock spawn to return non-zero exit code
    // Assert error thrown
  });
  
  it("should wrap Calibre EPUB with KindleFlow cover", async () => {
    // Provide fixture Calibre EPUB
    // Assert output includes KindleFlow cover page
  });
});
```

## Summary

The PDF converter interface is intentionally small and stable:

- **Input:** PDF buffer + metadata
- **Output:** Generated EPUB file
- **Error handling:** Throw on failure

This design allows swapping the v1 text-first converter with a Calibre-backed implementation without changing route handlers, UI logic, or delivery behavior. Future improvements can plug in behind the same interface.
