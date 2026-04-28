export interface OpdsNavigationFeed {
  id: string;
  title: string;
  updated: string;
  entries: OpdsNavigationEntry[];
}

export interface OpdsNavigationEntry {
  id: string;
  title: string;
  href: string;
}

export interface OpdsAcquisitionFeed {
  id: string;
  title: string;
  updated: string;
  entries: OpdsAcquisitionEntry[];
}

export interface OpdsAcquisitionEntry {
  id: string;
  title: string;
  updated: string;
  sourceUrl?: string;
  href: string;
  mimeType: "application/epub+zip";
}

const OPDS_NAVIGATION_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation";
const OPDS_ACQUISITION_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";

export function renderOpdsNavigationFeed(feed: OpdsNavigationFeed): string {
  return xmlDocument(`
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${escapeXml(feed.id)}</id>
  <title>${escapeXml(feed.title)}</title>
  <updated>${escapeXml(feed.updated)}</updated>
${feed.entries
  .map(
    (entry) => `  <entry>
    <id>${escapeXml(entry.id)}</id>
    <title>${escapeXml(entry.title)}</title>
    <updated>${escapeXml(feed.updated)}</updated>
    <link rel="subsection" type="${OPDS_NAVIGATION_TYPE}" href="${escapeAttribute(entry.href)}" />
  </entry>`
  )
  .join("\n")}
</feed>`);
}

export function renderOpdsAcquisitionFeed(feed: OpdsAcquisitionFeed): string {
  return xmlDocument(`
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${escapeXml(feed.id)}</id>
  <title>${escapeXml(feed.title)}</title>
  <updated>${escapeXml(feed.updated)}</updated>
${feed.entries
  .map(
    (entry) => `  <entry>
    <id>${escapeXml(entry.id)}</id>
    <title>${escapeXml(entry.title)}</title>
    <updated>${escapeXml(entry.updated)}</updated>
    ${entry.sourceUrl ? `<link rel="alternate" type="text/html" href="${escapeAttribute(entry.sourceUrl)}" />` : ""}
    <link rel="http://opds-spec.org/acquisition" type="${escapeAttribute(entry.mimeType)}" href="${escapeAttribute(entry.href)}" />
  </entry>`
  )
  .join("\n")}
</feed>`);
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body.trim()}\n`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeAttribute(value: string): string {
  return escapeXml(value);
}
