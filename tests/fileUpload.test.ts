import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../server/authStore.js";
import { saveUploadedFile, type SaveUploadedFileInput } from "../server/fileUpload.js";

describe("file upload", () => {
  let testDir: string;
  let store: AuthStore;
  let userId: string;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "kindleflow-upload-test-"));
    store = new AuthStore(path.join(testDir, "test.db"));
    const user = store.getOrCreateUserByEmail("uploader@test.local");
    userId = user.id;
  });

  afterEach(() => {
    store.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("uploads a valid PDF and creates a library item", async () => {
    // Arrange: create a minimal valid PDF
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    const input: SaveUploadedFileInput = {
      userId,
      fileBuffer: pdfBytes,
      originalFilename: "mydocument.pdf",
      title: undefined
    };

    // Act
    const result = await saveUploadedFile(input, { dataDir: testDir, store });

    // Assert: file is saved with safe unique filename
    expect(result.storedFilename).toMatch(/^[a-z0-9-]+-[a-z0-9]{8}\.pdf$/);
    expect(result.title).toBe("mydocument");

    // Assert: bytes are preserved exactly
    const savedBytes = readFileSync(path.join(testDir, result.storedFilename));
    expect(savedBytes.equals(pdfBytes)).toBe(true);

    // Assert: library item created
    const libraryItem = store.getLibraryItem(result.libraryItemId);
    expect(libraryItem).toBeDefined();
    expect(libraryItem!.userId).toBe(userId);
    expect(libraryItem!.type).toBe("uploaded_file");
    expect(libraryItem!.title).toBe("mydocument");
    expect(libraryItem!.filename).toBe(result.storedFilename);
    expect(libraryItem!.mimeType).toBe("application/pdf");
    expect(libraryItem!.sourceUrl).toBeUndefined();
  });

  it("allows title override", async () => {
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    const result = await saveUploadedFile(
      {
        userId,
        fileBuffer: pdfBytes,
        originalFilename: "original.pdf",
        title: "Custom Title"
      },
      { dataDir: testDir, store }
    );

    expect(result.title).toBe("Custom Title");
    expect(result.storedFilename).toMatch(/^custom-title-[a-z0-9]{8}\.pdf$/);
  });

  it("uploads a valid EPUB and creates a library item", async () => {
    // Create a minimal ZIP (which is what EPUB is)
    // ZIP magic bytes: PK\x03\x04
    const epubBytes = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, // ZIP signature
      ...Array(50).fill(0x00) // Padding
    ]);

    const result = await saveUploadedFile(
      {
        userId,
        fileBuffer: epubBytes,
        originalFilename: "mybook.epub",
        title: undefined
      },
      { dataDir: testDir, store }
    );

    expect(result.storedFilename).toMatch(/^mybook-[a-z0-9]{8}\.epub$/);
    expect(result.mimeType).toBe("application/epub+zip");

    const libraryItem = store.getLibraryItem(result.libraryItemId);
    expect(libraryItem!.mimeType).toBe("application/epub+zip");
  });

  it("rejects files over 50 MB", async () => {
    const largeBuffer = Buffer.alloc(51 * 1024 * 1024);
    largeBuffer.write("%PDF-1.4");

    await expect(
      saveUploadedFile(
        {
          userId,
          fileBuffer: largeBuffer,
          originalFilename: "huge.pdf",
          title: undefined
        },
        { dataDir: testDir, store }
      )
    ).rejects.toThrow(/50 MB/);
  });

  it("rejects non-PDF/EPUB files", async () => {
    const txtBytes = Buffer.from("Just some text");

    await expect(
      saveUploadedFile(
        {
          userId,
          fileBuffer: txtBytes,
          originalFilename: "document.txt",
          title: undefined
        },
        { dataDir: testDir, store }
      )
    ).rejects.toThrow(/PDF and EPUB/);
  });

  it("rejects PDF with wrong magic bytes", async () => {
    const fakePdf = Buffer.from("NOT A PDF");

    await expect(
      saveUploadedFile(
        {
          userId,
          fileBuffer: fakePdf,
          originalFilename: "fake.pdf",
          title: undefined
        },
        { dataDir: testDir, store }
      )
    ).rejects.toThrow(/PDF and EPUB/);
  });

  it("rejects EPUB with wrong magic bytes", async () => {
    const fakeEpub = Buffer.from("NOT A ZIP");

    await expect(
      saveUploadedFile(
        {
          userId,
          fileBuffer: fakeEpub,
          originalFilename: "fake.epub",
          title: undefined
        },
        { dataDir: testDir, store }
      )
    ).rejects.toThrow(/PDF and EPUB/);
  });

  it("sanitizes filenames safely", async () => {
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF"
    );

    const result = await saveUploadedFile(
      {
        userId,
        fileBuffer: pdfBytes,
        originalFilename: "../../../etc/passwd.pdf",
        title: "My Document <>&\"'"
      },
      { dataDir: testDir, store }
    );

    // Should not contain path traversal or special chars
    expect(result.storedFilename).not.toContain("..");
    expect(result.storedFilename).not.toContain("/");
    expect(result.storedFilename).toMatch(/^my-document-[a-z0-9]{8}\.pdf$/);
  });
});

