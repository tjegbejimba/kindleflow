import { describe, expect, it } from "vitest";
import { extractArticleFromHtml } from "../server/articleExtraction.js";

describe("extractArticleFromHtml", () => {
  it("extracts the readable article title and sanitized content", () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <title>Ignored site title</title>
          <meta property="og:title" content="Readable Article Title" />
        </head>
        <body>
          <nav>Navigation should not be part of the article</nav>
          <main>
            <article>
              <h1>Readable Article Title</h1>
              <p onclick="alert('bad')">This is the first useful paragraph.</p>
              <p>This is the second useful paragraph with <a href="/relative">a relative link</a>.</p>
              <script>window.evil = true;</script>
            </article>
          </main>
        </body>
      </html>
    `;

    const article = extractArticleFromHtml(html, "https://example.com/posts/readable");

    expect(article.title).toBe("Readable Article Title");
    expect(article.contentHtml).toContain("This is the first useful paragraph.");
    expect(article.contentHtml).toContain('href="https://example.com/relative"');
    expect(article.textContent).toContain("This is the second useful paragraph");
    expect(article.contentHtml).not.toContain("Navigation should not be part");
    expect(article.contentHtml).not.toContain("<script");
    expect(article.contentHtml).not.toContain("onclick");
  });

  it("fails clearly when no readable article can be found", () => {
    expect(() => extractArticleFromHtml("<html><body><p>tiny</p></body></html>", "https://example.com")).toThrow(
      /readable article/i
    );
  });
});
