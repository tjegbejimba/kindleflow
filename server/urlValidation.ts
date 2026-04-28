import { lookup } from "node:dns/promises";
import net from "node:net";

const INTERNAL_HOSTNAME_SUFFIXES = [".local", ".lan", ".internal", ".home", ".test"];
const METADATA_IPV4 = "169.254.169.254";

export async function validateFetchUrl(rawUrl: string): Promise<URL> {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Please enter a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error("This host is not allowed.");
  }

  const directIpVersion = net.isIP(hostname);
  if (directIpVersion !== 0) {
    if (isBlockedIp(hostname)) {
      throw new Error("This host is not allowed.");
    }
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new Error("This host is not allowed.");
  }

  return url;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }

  if (!hostname.includes(".")) {
    return true;
  }

  return INTERNAL_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function isBlockedIp(address: string): boolean {
  const normalized = normalizeHostname(address);
  const embeddedIpv4 = normalized.match(/(?:(?:^|:)ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  const ipVersion = net.isIP(embeddedIpv4 ?? normalized);

  if (ipVersion === 4) {
    return isBlockedIpv4(embeddedIpv4 ?? normalized);
  }

  if (ipVersion === 6) {
    return isBlockedIpv6(normalized);
  }

  return true;
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }

  const [first, second] = octets;
  return (
    address === METADATA_IPV4 ||
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}
