import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { extractArticleFromHtml, sanitizeArticleHtml } from "../server/articleExtraction.js";

describe("extractArticleFromHtml", () => {
  it("does not turn disallowed raw-text content into live markup", () => {
    const clean = sanitizeArticleHtml('<p>Keep this.</p><xmp><span data-marker="inert">Raw marker</span></xmp>');

    expect(clean).toContain("<p>Keep this.</p>");
    expect(clean).not.toContain("<span");
    expect(clean).not.toContain("data-marker");
  });

  it("preserves supported formatting through extraction and preview DOM insertion", () => {
    const article = extractArticleFromHtml(`
      <html><head><title>Safe formatting</title></head><body><article>
        <h1>Safe formatting</h1>
        <p>This readable article has enough ordinary text to preserve its useful formatting and links.</p>
        <p>Keep <strong>bold</strong>, <em>emphasis</em>, and <a href="/post">relative links</a>.</p>
        <blockquote>A quoted paragraph.</blockquote><pre><code>const value = 1;</code></pre>
        <ul><li>First point</li><li>Second point</li></ul><hr><br>
        <xmp><span data-marker="raw">Inert raw marker</span></xmp>
        <svg><textarea><span data-marker="foreign">Inert foreign marker</span></textarea></svg>
        <iframe><iframe>Inert nested fallback</iframe></iframe>
      </article></body></html>`, "https://example.com/articles/formatting");
    const preview = new JSDOM("<article></article>").window.document.querySelector("article")!;
    preview.innerHTML = article.contentHtml;

    expect(preview.querySelector("strong")?.textContent).toBe("bold");
    expect(preview.querySelector("em")?.textContent).toBe("emphasis");
    expect(preview.querySelector("a")?.getAttribute("href")).toBe("https://example.com/post");
    expect(preview.querySelector("pre code")?.textContent).toBe("const value = 1;");
    expect(preview.querySelectorAll("li")).toHaveLength(2);
    expect(preview.querySelector("blockquote")?.textContent).toContain("quoted paragraph");
    expect(preview.querySelector("xmp, span, svg, textarea, iframe, [data-marker]")).toBeNull();
  });

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
