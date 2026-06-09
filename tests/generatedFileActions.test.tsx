import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { GeneratedFileActions, type GeneratedFileActionFile } from "../client/src/GeneratedFileActions.js";

const epubFile: GeneratedFileActionFile = {
  filename: "article.epub",
  mimeType: "application/epub+zip",
  downloadUrl: "/files/article.epub",
  sentToKindle: false
};

describe("generated file actions", () => {
  it("can render the generated EPUB card collapsed while keeping the ready summary visible", () => {
    const markup = renderToStaticMarkup(
      <GeneratedFileActions
        file={epubFile}
        fileTypeLabel="EPUB"
        canSendToKindle={true}
        isBusy={false}
        isExpanded={false}
        onExpandedChange={vi.fn()}
        onSendToKindle={vi.fn()}
        sendButtonLabel="Send to Kindle"
      />
    );
    const dom = new JSDOM(markup);

    const card = dom.window.document.querySelector("details");
    expect(card?.hasAttribute("open")).toBe(false);
    expect(card?.querySelector("summary")?.textContent).toContain("Your EPUB is ready");
    expect(card?.querySelector("summary")?.textContent).toContain("Show actions");
  });
});
