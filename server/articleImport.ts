import { extractArticleFromHtml, type ExtractedArticle } from "./articleExtraction.js";

export interface ImportedRenderedArticle {
  sourceUrl: string;
  article: ExtractedArticle;
}

export interface ImportRenderedArticleInput {
  sourceUrl: string;
  html: string;
}

export function importRenderedArticle(input: ImportRenderedArticleInput): ImportedRenderedArticle {
  const sourceUrl = normalizeWebUrl(input.sourceUrl);
  return {
    sourceUrl,
    article: extractArticleFromHtml(input.html, sourceUrl)
  };
}

function normalizeWebUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Please enter a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  return url.toString();
}
