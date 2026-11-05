import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAndExtractArticle } from "../server/articleFetcher.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }])
}));

const readableArticleHtml = `
  <!doctype html>
  <html>
    <head><title>Paid Substack Post</title></head>
    <body>
      <article>
        <h1>Paid Substack Post</h1>
        <p>This full premium article body is long enough for readability extraction.</p>
        <p>It should only be returned by the upstream site when KindleFlow sends the configured cookie.</p>
      </article>
    </body>
  </html>
`;

describe("fetchAndExtractArticle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches initial HTTP article URLs without credentials", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      return new Response(readableArticleHtml, { headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchAndExtractArticle("http://newsletter.substack.com/p/post", {
      substackAuth: { cookie: "substack.sid=synthetic-reader", additionalCookieHosts: [] }
    })).kind).toBe("article");
  });

  it("rejects a credential-bearing downgrade before fetching its destination", async () => {
    const redirect = new Response("Redirect body", {
      status: 302, headers: { location: "http://newsletter.substack.com/p/next" }
    });
    const cancel = vi.spyOn(redirect.body!, "cancel");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(new Response(readableArticleHtml, { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAndExtractArticle("https://newsletter.substack.com/p/post", {
      substackAuth: { cookie: "substack.sid=synthetic-reader", additionalCookieHosts: [] }
    })).rejects.toThrow(/HTTPS to HTTP/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves HTTPS redirects while recomputing cookie host restrictions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/next" } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://example.com/post" } }))
      .mockResolvedValueOnce(new Response(readableArticleHtml, { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAndExtractArticle("https://newsletter.substack.com/p/post", {
      substackAuth: { cookie: "substack.sid=synthetic-reader", additionalCookieHosts: [] }
    });

    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init.headers).get("cookie")))
      .toEqual(["substack.sid=synthetic-reader", "substack.sid=synthetic-reader", null]);
  });

  it("sends the configured Substack cookie when fetching Substack article pages", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("cookie")).toBe("substack.sid=paid-reader");
      return new Response(readableArticleHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAndExtractArticle("https://example.substack.com/p/paid-post", {
      substackAuth: {
        cookie: "substack.sid=paid-reader",
        additionalCookieHosts: []
      }
    });

    expect(result.kind).toBe("article");
    if (result.kind !== "article") throw new Error("expected article");
    expect(result.article.title).toBe("Paid Substack Post");
    expect(result.article.textContent).toContain("full premium article body");
  });

  it("does not send the Substack cookie to unrelated article hosts", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      return new Response(readableArticleHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchAndExtractArticle("https://example.com/articles/paid-post", {
      substackAuth: {
        cookie: "substack.sid=paid-reader",
        additionalCookieHosts: []
      }
    });
  });

  it("returns a PDF result when the URL serves a PDF document", async () => {
    const pdfBytes = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from("Mock pdf body for KindleFlow tests.\n%%EOF\n")
    ]);
    const fetchMock = vi.fn(async () =>
      new Response(pdfBytes, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="Quarterly Report.pdf"'
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAndExtractArticle("https://example.com/files/q4.pdf");

    expect(result.kind).toBe("pdf");
    if (result.kind !== "pdf") throw new Error("expected pdf");
    expect(result.title).toBe("Quarterly Report");
    expect(result.pdfBuffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.pdfBuffer.equals(pdfBytes)).toBe(true);
  });

  it("rejects responses that are advertised as PDF but lack the %PDF- magic", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(Buffer.from("<html>not really pdf</html>"), {
        headers: { "content-type": "application/pdf" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAndExtractArticle("https://example.com/files/fake.pdf")).rejects.toThrow(
      /valid PDF/
    );
  });
});
