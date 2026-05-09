import { describe, expect, it } from "vitest";
import { importRenderedArticle } from "../server/articleImport.js";

const readableArticleHtml = `
  <!doctype html>
  <html>
    <head><title>Rendered Premium Post</title></head>
    <body>
      <article>
        <h1>Rendered Premium Post</h1>
        <p>This premium Substack article was captured from the rendered browser DOM.</p>
        <p>KindleFlow should extract it into the normal review and generate preview flow.</p>
      </article>
    </body>
  </html>
`;

describe("importRenderedArticle", () => {
  it("extracts rendered browser HTML into the normal article preview shape", () => {
    const imported = importRenderedArticle({
      sourceUrl: "https://example.substack.com/p/premium",
      html: readableArticleHtml
    });

    expect(imported.sourceUrl).toBe("https://example.substack.com/p/premium");
    expect(imported.article.title).toBe("Rendered Premium Post");
    expect(imported.article.textContent).toContain("premium Substack article");
  });

  it("rejects non-web source URLs", () => {
    expect(() => importRenderedArticle({ sourceUrl: "file:///etc/passwd", html: readableArticleHtml })).toThrow(/HTTP/i);
  });
});
