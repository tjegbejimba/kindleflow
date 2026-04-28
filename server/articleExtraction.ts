import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import sanitizeHtml from "sanitize-html";

export interface ExtractedArticle {
  title: string;
  contentHtml: string;
  textContent: string;
  byline?: string;
  excerpt?: string;
  siteName?: string;
}

const MINIMUM_TEXT_LENGTH = 80;

export function extractArticleFromHtml(html: string, sourceUrl: string): ExtractedArticle {
  const dom = new JSDOM(html, { url: sourceUrl });
  const parsed = new Readability(dom.window.document).parse();

  if (!parsed?.content || !parsed.textContent || parsed.textContent.trim().length < MINIMUM_TEXT_LENGTH) {
    throw new Error("Could not find a readable article at this URL.");
  }

  const normalizedHtml = absolutizeLinks(parsed.content, sourceUrl);
  const contentHtml = sanitizeHtml(normalizedHtml, {
    allowedTags: [
      "article",
      "section",
      "h1",
      "h2",
      "h3",
      "h4",
      "p",
      "blockquote",
      "pre",
      "code",
      "strong",
      "em",
      "b",
      "i",
      "u",
      "s",
      "a",
      "ul",
      "ol",
      "li",
      "hr",
      "br"
    ],
    allowedAttributes: {
      a: ["href", "title"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "nofollow noopener noreferrer" }, true)
    }
  }).trim();

  const textContent = new JSDOM(contentHtml).window.document.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
  if (textContent.length < MINIMUM_TEXT_LENGTH) {
    throw new Error("Could not find a readable article at this URL.");
  }

  return {
    title: sanitizePlainText(parsed.title || dom.window.document.title || "Untitled article"),
    contentHtml,
    textContent,
    byline: parsed.byline ? sanitizePlainText(parsed.byline) : undefined,
    excerpt: parsed.excerpt ? sanitizePlainText(parsed.excerpt) : undefined,
    siteName: parsed.siteName ? sanitizePlainText(parsed.siteName) : undefined
  };
}

function absolutizeLinks(contentHtml: string, sourceUrl: string): string {
  const dom = new JSDOM(`<main>${contentHtml}</main>`, { url: sourceUrl });
  for (const link of dom.window.document.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    if (!href) {
      continue;
    }

    try {
      link.setAttribute("href", new URL(href, sourceUrl).toString());
    } catch {
      link.removeAttribute("href");
    }
  }

  return dom.window.document.querySelector("main")?.innerHTML ?? contentHtml;
}

function sanitizePlainText(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
}
