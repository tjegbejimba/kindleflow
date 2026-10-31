import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeed, normalizeFeedUrl, parseFeedXml } from "../server/feed.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }])
}));

const rss = "<rss><channel><title>Example feed</title><item><title>Post</title><link>https://feed.example/post</link></item></channel></rss>";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("fetchFeed", () => {
  it.each(["http://127.0.0.1/private", "http://100.104.13.117:5000/", "file:///private"])(
    "blocks a redirect to %s before requesting it",
    async (location) => {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 302, headers: { location } })
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(fetchFeed("https://feed.example/rss")).rejects.toThrow(/not allowed|Only HTTP/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    }
  );

  it("follows validated relative redirects and removes cookies on unrelated hosts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/next" } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://feed.example/rss" } }))
      .mockResolvedValueOnce(new Response(rss, { headers: { "content-type": "application/rss+xml" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchFeed("https://newsletter.substack.com/", {
      substackAuth: { cookie: "substack.sid=synthetic-reader", additionalCookieHosts: [] }
    });

    expect(result.feedTitle).toBe("Example feed");
    expect(result.feedUrl).toBe("https://feed.example/rss");
    expect(fetchMock.mock.calls.map(([url]) => url.toString())).toEqual([
      "https://newsletter.substack.com/feed",
      "https://newsletter.substack.com/next",
      "https://feed.example/rss"
    ]);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("cookie")).toBe("substack.sid=synthetic-reader");
    expect(new Headers(fetchMock.mock.calls[2][1].headers).has("cookie")).toBe(false);
  });

  it("bounds redirect loops and rejects missing destinations", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFeed("https://feed.example/rss")).rejects.toThrow(/too many times/);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    fetchMock.mockResolvedValue(new Response(null, { status: 302 }));
    await expect(fetchFeed("https://feed.example/rss")).rejects.toThrow(/Location/);
  });
});
