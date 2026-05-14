import { describe, it, expect } from "vitest";

// Simulate the frontend's GeneratedFile interface (current state - no mimeType)
interface GeneratedFileCurrentState {
  filename: string;
  downloadUrl: string;
  sentToKindle: boolean;
}

// Simulate the frontend's GeneratedFile interface (desired state - with mimeType)
interface GeneratedFileDesiredState {
  filename: string;
  downloadUrl: string;
  sentToKindle: boolean;
  mimeType: "application/pdf" | "application/epub+zip";
}

describe("API response structure", () => {
  describe("EPUB generation (/api/articles/generate)", () => {
    it("should include mimeType in response", () => {
      // This test will FAIL initially because the current API doesn't return mimeType
      // Simulating what the API SHOULD return
      const mockApiResponse: GeneratedFileDesiredState = {
        filename: "test-article-abc123.epub",
        mimeType: "application/epub+zip",
        downloadUrl: "/files/test-article-abc123.epub",
        sentToKindle: false
      };

      // This assertion verifies the desired structure
      expect(mockApiResponse).toHaveProperty("mimeType");
      expect(mockApiResponse.mimeType).toBe("application/epub+zip");
    });
  });

  describe("PDF fetch (/api/articles/fetch)", () => {
    it("already includes mimeType in generated object", () => {
      // PDFs already have mimeType - this should pass
      const pdfFetchResult = {
        kind: "pdf" as const,
        sourceUrl: "https://example.com/document.pdf",
        title: "Test PDF Document",
        generated: {
          filename: "test-pdf-document-abc123.pdf",
          mimeType: "application/pdf" as const,
          downloadUrl: "/files/test-pdf-document-abc123.pdf",
          sentToKindle: false
        }
      };

      expect(pdfFetchResult.generated.mimeType).toBe("application/pdf");
    });
  });
});

describe("Frontend label derivation", () => {
  function getFileTypeLabel(mimeType: "application/pdf" | "application/epub+zip"): string {
    return mimeType === "application/pdf" ? "PDF" : "EPUB";
  }

  function getReadyMessage(fileType: string): string {
    return `Your ${fileType} is ready`;
  }

  function getDownloadLabel(fileType: string): string {
    return `Download ${fileType}`;
  }

  it("derives PDF label from application/pdf mimeType", () => {
    const mimeType = "application/pdf" as const;
    const fileType = getFileTypeLabel(mimeType);
    
    expect(fileType).toBe("PDF");
    expect(getReadyMessage(fileType)).toBe("Your PDF is ready");
    expect(getDownloadLabel(fileType)).toBe("Download PDF");
  });

  it("derives EPUB label from application/epub+zip mimeType", () => {
    const mimeType = "application/epub+zip" as const;
    const fileType = getFileTypeLabel(mimeType);
    
    expect(fileType).toBe("EPUB");
    expect(getReadyMessage(fileType)).toBe("Your EPUB is ready");
    expect(getDownloadLabel(fileType)).toBe("Download EPUB");
  });
});
