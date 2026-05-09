export interface SubstackAuthConfig {
  cookie?: string;
  additionalCookieHosts: string[];
}

export function cookieHeaderForUrl(url: URL, auth: SubstackAuthConfig | undefined): string | undefined {
  const cookie = auth?.cookie?.trim();
  if (!cookie || !auth) {
    return undefined;
  }

  const hostname = normalizeHostname(url.hostname);
  if (isDefaultSubstackHost(hostname) || auth.additionalCookieHosts.map(normalizeHostname).includes(hostname)) {
    return cookie;
  }

  return undefined;
}

export function parseAdditionalCookieHosts(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return [...new Set(value.split(",").map(normalizeHostname).filter(Boolean))];
}

function isDefaultSubstackHost(hostname: string): boolean {
  return hostname === "substack.com" || hostname.endsWith(".substack.com");
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
}
