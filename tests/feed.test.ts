import { describe, expect, it } from "vitest";
import { normalizeFeedUrl, parseFeedXml } from "../server/feed.js";

describe("feed helpers", () => {
  it("normalizes Substack URLs to their public feed URL", () => {
    expect(normalizeFeedUrl("https://example.substack.com/")).toBe("https://example.substack.com/feed");
    expect(normalizeFeedUrl("https://example.substack.com/p/a-post")).toBe("https://example.substack.com/feed");
    expect(normalizeFeedUrl("https://example.com/rss.xml")).toBe("https://example.com/rss.xml");
  });

  it("parses RSS posts with title, link, guid, and date", () => {
    const posts = parseFeedXml(`<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Example Newsletter</title>
          <item>
            <title>First Post</title>
            <link>https://example.com/p/first</link>
            <guid>first-guid</guid>
            <pubDate>Mon, 27 Apr 2026 12:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>`);

    expect(posts.feedTitle).toBe("Example Newsletter");
    expect(posts.items).toEqual([
      {
        title: "First Post",
        url: "https://example.com/p/first",
        guid: "first-guid",
        publishedAt: "2026-04-27T12:00:00.000Z"
      }
    ]);
  });
});
