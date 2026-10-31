import { JSDOM } from "jsdom";
import { cookieHeaderForUrl, type SubstackAuthConfig } from "./substackAuth.js";
import { validateFetchUrl } from "./urlValidation.js";

export interface FeedItem {
  title: string;
  url: string;
  guid?: string;
  publishedAt?: string;
}

export interface ParsedFeed {
  feedTitle: string;
  items: FeedItem[];
}

export interface FetchFeedOptions {
  substackAuth?: SubstackAuthConfig;
}

export function normalizeFeedUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";

  if (url.hostname.endsWith(".substack.com")) {
    return `${url.origin}/feed`;
  }

  return url.toString();
}

export async function fetchFeed(rawUrl: string, options: FetchFeedOptions = {}): Promise<ParsedFeed & { feedUrl: string }> {
  let currentUrl = await validateFetchUrl(normalizeFeedUrl(rawUrl));
  const signal = AbortSignal.timeout(15_000);

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const cookie = cookieHeaderForUrl(currentUrl, options.substackAuth);
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        "user-agent": "KindleFlow/1.0 (+self-hosted newsletter reader)",
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        ...(cookie ? { cookie } : {})
      },
      signal
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new Error("The feed URL redirected without a Location header.");
      }
      currentUrl = await validateFetchUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) {
      throw new Error(`Feed fetch failed with HTTP ${response.status}.`);
    }

    return {
      feedUrl: currentUrl.toString(),
      ...parseFeedXml(await response.text())
    };
  }

  throw new Error("The feed URL redirected too many times.");
}

export function parseFeedXml(xml: string): ParsedFeed {
  const document = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  const parseError = document.querySelector("parsererror");
  if (parseError) {
    throw new Error("The subscription URL did not return a valid RSS/Atom feed.");
  }

  const rssItems = Array.from(document.querySelectorAll("item"));
  if (rssItems.length > 0) {
    return {
      feedTitle: text(document.querySelector("channel > title")) || "Untitled feed",
      items: rssItems.reduce<ParsedFeed["items"]>((acc, item) => {
        const url = text(item.querySelector("link"));
        if (!url) return acc;
        acc.push({
          title: text(item.querySelector("title")) || "Untitled post",
          url,
          guid: text(item.querySelector("guid")) || undefined,
          publishedAt: parseDate(text(item.querySelector("pubDate")))
        });
        return acc;
      }, [])
    };
  }

  const atomEntries = Array.from(document.querySelectorAll("entry"));
  return {
    feedTitle: text(document.querySelector("feed > title")) || "Untitled feed",
    items: atomEntries.reduce<ParsedFeed["items"]>((acc, entry) => {
      const url = atomLink(entry);
      if (!url) return acc;
      acc.push({
        title: text(entry.querySelector("title")) || "Untitled post",
        url,
        guid: text(entry.querySelector("id")) || undefined,
        publishedAt: parseDate(text(entry.querySelector("published")) || text(entry.querySelector("updated")))
      });
      return acc;
    }, [])
  };
}

function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function atomLink(entry: Element): string {
  const alternate = entry.querySelector("link[rel='alternate']") ?? entry.querySelector("link[href]");
  return alternate?.getAttribute("href") ?? "";
}

function parseDate(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}
