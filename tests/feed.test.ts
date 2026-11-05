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
  it.each([undefined, "1"])("cancels oversized streams before parsing, with Content-Length %s", async (length) => {
    let reads = 0;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      pull(controller) {
        reads += 1;
        controller.enqueue(new TextEncoder().encode("not XML!"));
        if (reads === 3) controller.close();
      },
      cancel
    }, { highWaterMark: 0 }), { headers: length ? { "content-length": length } : {} });
    const text = vi.spyOn(response, "text");
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(fetchFeed("https://feed.example/rss", { maxBytes: 12 })).rejects.toThrow(/feed payload is too large/i);
    expect(reads).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(text).not.toHaveBeenCalled();
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    const cancel = vi.fn();
    let sent = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        if (sent) controller.close();
        else controller.enqueue(new TextEncoder().encode("ééé"));
        sent = true;
      },
      cancel
    }, { highWaterMark: 0 }))));

    await expect(fetchFeed("https://feed.example/rss", { maxBytes: 5 })).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    rss,
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>Example feed</title><entry><title>Post</title><link href="https://feed.example/post"/></entry></feed>'
  ])("accepts valid feeds exactly at the byte limit across split UTF-8 chunks", async (xml) => {
    const bytes = new TextEncoder().encode(xml.replace("Post", "Café"));
    const split = bytes.indexOf(0xc3) + 1;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      }
    }));
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const result = await fetchFeed("https://feed.example/rss", { maxBytes: bytes.byteLength });
    expect(result.feedTitle).toBe("Example feed");
    expect(result.items[0]).toMatchObject({ title: "Café", url: "https://feed.example/post" });
    expect(response.body?.locked).toBe(false);
  });

  it("fetches initial HTTP feeds without credentials", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      return new Response(rss);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchFeed("http://newsletter.substack.com/", {
      substackAuth: { cookie: "substack.sid=synthetic-reader", additionalCookieHosts: [] }
    })).feedTitle).toBe("Example feed");
  });

  it("rejects a credential-bearing downgrade before fetching its destination", async () => {
    const redirect = new Response("Redirect body", {
      status: 307, headers: { location: "http://newsletter.substack.com/feed" }
    });
    const cancel = vi.spyOn(redirect.body!, "cancel");
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect).mockResolvedValueOnce(new Response(rss));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFeed("https://newsletter.substack.com/", {
      substackAuth: { cookie: "substack.sid=synthetic-reader", additionalCookieHosts: [] }
    })).rejects.toThrow(/HTTPS to HTTP/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("continues uncredentialed HTTP redirects without attaching cookies", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://feed.example/rss" } }))
      .mockResolvedValueOnce(new Response(rss));
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchFeed("https://feed.example/rss")).feedTitle).toBe("Example feed");
    expect(new Headers(fetchMock.mock.calls[1][1].headers).has("cookie")).toBe(false);
  });

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
