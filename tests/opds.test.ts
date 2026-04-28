import { describe, expect, it } from "vitest";
import { renderOpdsAcquisitionFeed, renderOpdsNavigationFeed } from "../server/opds.js";

describe("OPDS rendering", () => {
  it("renders navigation feeds with escaped shelf links", () => {
    const xml = renderOpdsNavigationFeed({
      id: "kindleflow:root",
      title: "KindleFlow & News",
      updated: "2026-04-28T00:00:00.000Z",
      entries: [
        {
          id: "kindleflow:recent",
          title: "Recent <Items>",
          href: "/opds/token/recent.xml"
        }
      ]
    });

    expect(xml).toContain('type="application/atom+xml;profile=opds-catalog;kind=navigation"');
    expect(xml).toContain("KindleFlow &amp; News");
    expect(xml).toContain("Recent &lt;Items&gt;");
  });

  it("renders acquisition feeds with EPUB download links", () => {
    const xml = renderOpdsAcquisitionFeed({
      id: "kindleflow:recent",
      title: "Recent",
      updated: "2026-04-28T00:00:00.000Z",
      entries: [
        {
          id: "library-item-1",
          title: "Newsletter & Issue",
          updated: "2026-04-28T00:00:00.000Z",
          sourceUrl: "https://example.com/p/issue",
          href: "/opds/token/files/newsletter.epub",
          mimeType: "application/epub+zip"
        }
      ]
    });

    expect(xml).toContain('rel="http://opds-spec.org/acquisition"');
    expect(xml).toContain('type="application/epub+zip"');
    expect(xml).toContain("Newsletter &amp; Issue");
    expect(xml).toContain("https://example.com/p/issue");
  });
});
