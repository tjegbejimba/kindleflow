import { describe, expect, it } from "vitest";
import { visibleGeneratedFileAfterDelivery, type GeneratedFileForVisibility } from "../client/src/generatedFileVisibility.js";

const baseFile: GeneratedFileForVisibility = {
  filename: "article.epub",
  mimeType: "application/epub+zip",
  downloadUrl: "/files/article.epub",
  sentToKindle: false
};

describe("generated file visibility", () => {
  it("hides a generated EPUB once it has been sent to Kindle", () => {
    expect(visibleGeneratedFileAfterDelivery({ ...baseFile, sentToKindle: true })).toBeNull();
  });

  it("keeps an unsent generated EPUB visible so it can be downloaded or sent", () => {
    expect(visibleGeneratedFileAfterDelivery(baseFile)).toEqual(baseFile);
  });

  it("does not hide sent PDFs from the PDF import flow", () => {
    const pdfFile: GeneratedFileForVisibility = {
      ...baseFile,
      filename: "document.pdf",
      mimeType: "application/pdf",
      downloadUrl: "/files/document.pdf",
      sentToKindle: true
    };

    expect(visibleGeneratedFileAfterDelivery(pdfFile)).toEqual(pdfFile);
  });
});
