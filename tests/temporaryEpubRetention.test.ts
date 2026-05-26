import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../server/authStore.js";
import { saveKindlePdf } from "../server/kindleFile.js";
import { convertPdfToEpub } from "../server/pdfConverter.js";

let tempDir: string;
let store: AuthStore;
let userId: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-"));
  const dbPath = path.join(tempDir, "test.db");
  store = new AuthStore(dbPath);
  
  // Create a test user
  userId = store.getOrCreateUserByEmail("test@example.com").id;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Temporary EPUB retention", () => {
  describe("original PDF preservation", () => {
    it("keeps the original PDF library item after conversion", async () => {
      // TRACER BULLET: Prove conversion does not remove original PDF
      
      // Create a simple text PDF
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      const textContent = `Sample PDF Content
      
This is a test document with sufficient text content for EPUB conversion.

Multiple paragraphs ensure we have enough text to pass the minimum threshold for meaningful conversion.

A third paragraph adds even more content to thoroughly test the system.`.trim();
      
      page.drawText(textContent, {
        x: 50,
        y: 700,
        size: 12,
        font,
        maxWidth: 500
      });
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      
      // Save PDF to library
      const savedPdf = await saveKindlePdf({
        buffer: pdfBuffer,
        title: "Test Document",
        dataDir: tempDir
      });
      
      const pdfLibraryItem = store.addLibraryItem(userId, {
        type: "article",
        title: "Test Document",
        sourceUrl: "https://example.com/test.pdf",
        filename: savedPdf.filename,
        mimeType: "application/pdf"
      });
      
      // Verify PDF is in library before conversion
      const beforeItems = store.listRecentLibraryItems(userId);
      expect(beforeItems).toHaveLength(1);
      expect(beforeItems[0].id).toBe(pdfLibraryItem.id);
      expect(beforeItems[0].mimeType).toBe("application/pdf");
      
      // Convert PDF to EPUB
      await convertPdfToEpub({
        pdfBuffer,
        title: "Test Document",
        sourceUrl: "https://example.com/test.pdf",
        dataDir: tempDir
      });
      
      // Verify original PDF library item still exists
      const afterItems = store.listRecentLibraryItems(userId);
      const pdfItem = afterItems.find(item => item.id === pdfLibraryItem.id);
      
      expect(pdfItem).toBeDefined();
      expect(pdfItem?.mimeType).toBe("application/pdf");
      expect(pdfItem?.filename).toBe(savedPdf.filename);
    });
  });
  
  describe("temporary EPUB tracking", () => {
    it("marks converted EPUB as temporary with 24-hour retention", async () => {
      // Create a simple text PDF
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      const textContent = `Sample PDF Content
      
This is a test document with sufficient text content for EPUB conversion.

Multiple paragraphs ensure we have enough text to pass the minimum threshold for meaningful conversion.

A third paragraph adds even more content to thoroughly test the system.`.trim();
      
      page.drawText(textContent, {
        x: 50,
        y: 700,
        size: 12,
        font,
        maxWidth: 500
      });
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      
      // Save PDF to library
      const savedPdf = await saveKindlePdf({
        buffer: pdfBuffer,
        title: "Test Document",
        dataDir: tempDir
      });
      
      const pdfLibraryItem = store.addLibraryItem(userId, {
        type: "article",
        title: "Test Document",
        sourceUrl: "https://example.com/test.pdf",
        filename: savedPdf.filename,
        mimeType: "application/pdf"
      });
      
      // Convert PDF to EPUB
      const generated = await convertPdfToEpub({
        pdfBuffer,
        title: "Test Document",
        sourceUrl: "https://example.com/test.pdf",
        dataDir: tempDir
      });
      
      // Track as temporary file (new behavior)
      const now = new Date();
      const retentionHours = 24;
      const expiresAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000);
      
      store.addTemporaryFile({
        userId,
        sourceLibraryItemId: pdfLibraryItem.id,
        filename: generated.filename,
        mimeType: generated.mimeType,
        retentionHours
      });
      
      // Verify temporary file is tracked
      const tempFiles = store.listTemporaryFiles(userId);
      expect(tempFiles).toHaveLength(1);
      expect(tempFiles[0].filename).toBe(generated.filename);
      expect(tempFiles[0].mimeType).toBe("application/epub+zip");
      expect(tempFiles[0].sourceLibraryItemId).toBe(pdfLibraryItem.id);
      
      // Verify expiry time is approximately 24 hours from now
      const expiresAtParsed = new Date(tempFiles[0].expiresAt);
      const timeDiffMs = Math.abs(expiresAtParsed.getTime() - expiresAt.getTime());
      expect(timeDiffMs).toBeLessThan(1000); // Within 1 second
      
      // Verify converted EPUB is NOT in permanent library
      const libraryItems = store.listRecentLibraryItems(userId);
      const epubInLibrary = libraryItems.some(item => item.filename === generated.filename);
      expect(epubInLibrary).toBe(false);
    });
  });
  
  describe("temporary file cleanup", () => {
    it("removes expired temporary files", async () => {
      // Create a simple text PDF
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      const textContent = `Sample PDF Content
      
This is a test document with sufficient text content for EPUB conversion.

Multiple paragraphs ensure we have enough text to pass the minimum threshold for meaningful conversion.

A third paragraph adds even more content to thoroughly test the system.`.trim();
      
      page.drawText(textContent, {
        x: 50,
        y: 700,
        size: 12,
        font,
        maxWidth: 500
      });
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      
      // Save PDF to library
      const savedPdf = await saveKindlePdf({
        buffer: pdfBuffer,
        title: "Test Document",
        dataDir: tempDir
      });
      
      const pdfLibraryItem = store.addLibraryItem(userId, {
        type: "article",
        title: "Test Document",
        sourceUrl: "https://example.com/test.pdf",
        filename: savedPdf.filename,
        mimeType: "application/pdf"
      });
      
      // Convert PDF to EPUB
      const generated = await convertPdfToEpub({
        pdfBuffer,
        title: "Test Document",
        sourceUrl: "https://example.com/test.pdf",
        dataDir: tempDir
      });
      
      // Add an expired temporary file (retention of -1 hours = already expired)
      store.addTemporaryFile({
        userId,
        sourceLibraryItemId: pdfLibraryItem.id,
        filename: generated.filename,
        mimeType: generated.mimeType,
        retentionHours: -1 // Already expired
      });
      
      // Verify file exists before cleanup
      const beforeCleanup = store.listTemporaryFiles(userId);
      expect(beforeCleanup).toHaveLength(1);
      
      // Run cleanup (database only)
      const cleanedCount = store.cleanupExpiredTemporaryFiles();
      
      // Verify expired file was removed from database
      const afterCleanup = store.listTemporaryFiles(userId);
      expect(afterCleanup).toHaveLength(0);
      expect(cleanedCount).toBe(1);
      
      // Note: Physical file deletion is tested separately in integration tests
      // since it requires filesystem mocking or actual file system interaction
    });
    
    it("preserves non-expired temporary files during cleanup", async () => {
      // Create a simple text PDF
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      const textContent = `Sample PDF Content
      
This is a test document with sufficient text content for EPUB conversion.

Multiple paragraphs ensure we have enough text to pass the minimum threshold for meaningful conversion.

A third paragraph adds even more content to thoroughly test the system.`.trim();
      
      page.drawText(textContent, {
        x: 50,
        y: 700,
        size: 12,
        font,
        maxWidth: 500
      });
      
      const pdfBuffer = Buffer.from(await pdfDoc.save());
      
      // Save PDF to library
      const savedPdf = await saveKindlePdf({
        buffer: pdfBuffer,
        title: "Test Document",
        dataDir: tempDir
      });
      
      const pdfLibraryItem = store.addLibraryItem(userId, {
        type: "article",
        title: "Test Document",
        sourceUrl: "https://example.com/test.pdf",
        filename: savedPdf.filename,
        mimeType: "application/pdf"
      });
      
      // Convert PDF to EPUB
      const generated = await convertPdfToEpub({
        pdfBuffer,
        title: "Test Document",
        sourceUrl: "https://example.com/test.pdf",
        dataDir: tempDir
      });
      
      // Add a non-expired temporary file (24 hours from now)
      store.addTemporaryFile({
        userId,
        sourceLibraryItemId: pdfLibraryItem.id,
        filename: generated.filename,
        mimeType: generated.mimeType,
        retentionHours: 24
      });
      
      // Verify file exists before cleanup
      const beforeCleanup = store.listTemporaryFiles(userId);
      expect(beforeCleanup).toHaveLength(1);
      
      // Run cleanup
      const cleanedCount = store.cleanupExpiredTemporaryFiles();
      
      // Verify non-expired file was NOT removed
      const afterCleanup = store.listTemporaryFiles(userId);
      expect(afterCleanup).toHaveLength(1);
      expect(cleanedCount).toBe(0);
    });
  });
});
