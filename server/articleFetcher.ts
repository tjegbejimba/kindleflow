import { extractArticleFromHtml, type ExtractedArticle } from "./articleExtraction.js";
import { cookieHeaderForUrl, type SubstackAuthConfig } from "./substackAuth.js";
import { validateFetchUrl } from "./urlValidation.js";
import { analyzePdf, type PdfAnalysis } from "./pdfAnalyzer.js";

export interface FetchedArticleResult {
  kind: "article";
  sourceUrl: string;
  article: ExtractedArticle;
}

export interface FetchedPdfResult {
  kind: "pdf";
  sourceUrl: string;
  title: string;
  pdfBuffer: Buffer;
  analysis: PdfAnalysis;
}

export type FetchArticleResult = FetchedArticleResult | FetchedPdfResult;

export interface FetchArticleOptions {
  substackAuth?: SubstackAuthConfig;
}

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const PDF_MAGIC = Buffer.from("%PDF-");

export async function fetchAndExtractArticle(rawUrl: string, options: FetchArticleOptions = {}): Promise<FetchArticleResult> {
  let currentUrl = await validateFetchUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const cookie = cookieHeaderForUrl(currentUrl, options.substackAuth);
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "user-agent": "KindleFlow/1.0 (+self-hosted article reader)",
        accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.1",
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

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const contentDisposition = response.headers.get("content-disposition") ?? "";
    const dispositionFilename = parseContentDispositionFilename(contentDisposition);

    if (looksLikePdf(currentUrl, contentType, dispositionFilename)) {
      const pdfBuffer = await readLimitedBytes(response, MAX_PDF_BYTES, "PDF");
      if (!pdfBuffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
        throw new Error("The URL did not return a valid PDF document.");
      }

      const analysis = await analyzePdf(pdfBuffer);

      return {
        kind: "pdf",
        sourceUrl: currentUrl.toString(),
        title: derivePdfTitle(currentUrl, dispositionFilename),
        pdfBuffer,
        analysis
      };
    }

    if (contentType && !contentType.includes("html")) {
      throw new Error("The URL did not return an HTML article or a PDF document.");
    }

    const html = (await readLimitedBytes(response, MAX_HTML_BYTES, "HTML")).toString("utf8");
    return {
      kind: "article",
      sourceUrl: currentUrl.toString(),
      article: extractArticleFromHtml(html, currentUrl.toString())
    };
  }

  throw new Error("The article URL redirected too many times.");
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function looksLikePdf(url: URL, contentType: string, dispositionFilename: string | undefined): boolean {
  if (contentType.startsWith("application/pdf")) {
    return true;
  }
  if (dispositionFilename && dispositionFilename.toLowerCase().endsWith(".pdf")) {
    return true;
  }
  if (url.pathname.toLowerCase().endsWith(".pdf")) {
    return true;
  }
  return false;
}

function parseContentDispositionFilename(header: string): string | undefined {
  if (!header) {
    return undefined;
  }
  const utf8Match = header.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through
    }
  }
  const plainMatch = header.match(/filename\s*=\s*("([^"]*)"|([^;]+))/i);
  if (plainMatch) {
    return (plainMatch[2] ?? plainMatch[3] ?? "").trim();
  }
  return undefined;
}

function derivePdfTitle(url: URL, dispositionFilename: string | undefined): string {
  if (dispositionFilename) {
    const cleaned = stripPdfExtension(dispositionFilename);
    if (cleaned) {
      return cleaned;
    }
  }
  const lastSegment = url.pathname.split("/").filter(Boolean).pop();
  if (lastSegment) {
    try {
      const decoded = stripPdfExtension(decodeURIComponent(lastSegment));
      if (decoded) {
        return decoded;
      }
    } catch {
      // fall through
    }
  }
  return url.hostname || "document";
}

function stripPdfExtension(value: string): string {
  return value.replace(/\.pdf$/i, "").trim();
}

async function readLimitedBytes(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`The ${label} payload is too large.`);
    }
    return Buffer.from(arrayBuffer);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`The ${label} payload is too large.`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}
