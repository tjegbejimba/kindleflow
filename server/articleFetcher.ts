import { extractArticleFromHtml, type ExtractedArticle } from "./articleExtraction.js";
import { cookieHeaderForUrl, type SubstackAuthConfig } from "./substackAuth.js";
import { validateFetchUrl } from "./urlValidation.js";

export interface FetchArticleResult {
  sourceUrl: string;
  article: ExtractedArticle;
}

export interface FetchArticleOptions {
  substackAuth?: SubstackAuthConfig;
}

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export async function fetchAndExtractArticle(rawUrl: string, options: FetchArticleOptions = {}): Promise<FetchArticleResult> {
  let currentUrl = await validateFetchUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const cookie = cookieHeaderForUrl(currentUrl, options.substackAuth);
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "user-agent": "KindleFlow/1.0 (+self-hosted article reader)",
        accept: "text/html,application/xhtml+xml",
        ...(cookie ? { cookie } : {})
      }
    });

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("The article URL redirected without a Location header.");
      }
      currentUrl = await validateFetchUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) {
      throw new Error(`Article fetch failed with HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.toLowerCase().includes("html")) {
      throw new Error("The URL did not return an HTML article.");
    }

    const html = await readLimitedText(response);
    return {
      sourceUrl: currentUrl.toString(),
      article: extractArticleFromHtml(html, currentUrl.toString())
    };
  }

  throw new Error("The article URL redirected too many times.");
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readLimitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > MAX_HTML_BYTES) {
      throw new Error("The article HTML is too large.");
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}
