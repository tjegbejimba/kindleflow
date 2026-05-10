import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assetDir = join(root, "extension", "store-assets");
const fontFamily = "Helvetica";

mkdirSync(assetDir, { recursive: true });

const screenshots = [
  {
    filename: "chrome-screenshot-1.png",
    eyebrow: "Paid Substack to Kindle",
    title: "Send articles from the browser you already use",
    body: "Open a paid Substack post while signed in, click KindleFlow, and send the readable page to your KindleFlow server.",
    callout: "No cookie copying. No preview-only server fetches.",
    panelTitle: "Send article",
    status: "EPUB generated. Send to Kindle or download."
  },
  {
    filename: "chrome-screenshot-2.png",
    eyebrow: "Private by design",
    title: "Captures the rendered page, not your Substack session",
    body: "KindleFlow imports only the article HTML visible in your current tab after you choose to send it.",
    callout: "The extension does not read, store, or transmit Substack cookies.",
    panelTitle: "KindleFlow URL",
    status: "https://kindleflow.tail217062.ts.net"
  },
  {
    filename: "chrome-screenshot-3.png",
    eyebrow: "Kindle-ready flow",
    title: "Generate an EPUB and send it from the extension",
    body: "The popup calls KindleFlow to import, generate, download, and optionally send the EPUB to your Kindle address.",
    callout: "Works best when you are already signed in to KindleFlow in the same browser.",
    panelTitle: "Generated file",
    status: "deep-dive-paid-substack.epub"
  }
];

for (const screenshot of screenshots) {
  const svgPath = join(assetDir, screenshot.filename.replace(".png", ".svg"));
  const pngPath = join(assetDir, screenshot.filename);
  writeFileSync(svgPath, renderScreenshot(screenshot));
  renderPng(svgPath, pngPath);
}

writeFileSync(
  join(assetDir, "chrome-listing.txt"),
  `Name
KindleFlow

Short description
Send paid Substack and other readable articles from your browser to KindleFlow.

Detailed description
KindleFlow turns readable web articles into Kindle-friendly EPUB files. The browser extension is the recommended way to save paid Substack posts because it works from the page you can already read in your browser.

Open a readable article, click the KindleFlow extension, and send the current page to your configured KindleFlow server. KindleFlow imports the rendered article, generates an EPUB, and can automatically send it to your Kindle email address when your KindleFlow profile is configured for auto-send.

Privacy
The extension sends the rendered page HTML to the KindleFlow server URL you configure. It does not collect analytics and does not read, store, or transmit Substack cookies.

Permission justification
activeTab: lets the extension access only the current tab after the user clicks the extension.
scripting: captures the rendered article HTML from the current tab.
storage: saves the configured KindleFlow server URL.
host permissions: allow the popup to call the configured KindleFlow server and support Substack article pages.
`
);

console.log(`Generated Chrome Web Store assets in extension/store-assets`);

function renderPng(svgPath, pngPath) {
  const attempts = [
    ["rsvg-convert", ["-w", "1280", "-h", "800", "-o", pngPath, svgPath]],
    ["sips", ["-s", "format", "png", svgPath, "--out", pngPath]],
    ["magick", [svgPath, pngPath]],
    ["convert", [svgPath, pngPath]]
  ];

  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, { stdio: "ignore" });
      return;
    } catch {
      // Try the next renderer; availability differs by platform.
    }
  }

  throw new Error("Could not render store screenshot PNGs. Install librsvg, ImageMagick, or run on macOS with sips.");
}

function renderScreenshot({ eyebrow, title, body, callout, panelTitle, status }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="#fff8ef" />
      <stop offset="1" stop-color="#eadccb" />
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#1d1a17" flood-opacity=".22" />
    </filter>
  </defs>
  <rect width="1280" height="800" fill="url(#bg)" />
  <circle cx="1076" cy="128" r="260" fill="#dbcdbb" opacity=".45" />
  <circle cx="162" cy="692" r="240" fill="#b26d23" opacity=".12" />

  <g transform="translate(88 86)">
    <rect width="88" height="88" rx="22" fill="#1d1a17" />
    <path fill="#fff8ef" d="M28 17h32l14 14v43H28z" />
    <path fill="#dbcdbb" d="M60 17v14h14z" />
    <path fill="#8a5a24" d="M38 32h8v15l16-15h11L54 49l20 22H63L46 52v19h-8z" />
  </g>

  <text x="88" y="230" fill="#8a5a24" font-family="${fontFamily}" font-size="26" font-weight="800" letter-spacing="4">${escapeXml(eyebrow).toUpperCase()}</text>
  <text x="88" y="320" fill="#1d1a17" font-family="${fontFamily}" font-size="68" font-weight="900">
    ${wrapText(title, 24, 88, 320, 78)}
  </text>
  <text x="88" y="510" fill="#5d5349" font-family="${fontFamily}" font-size="32" font-weight="500">
    ${wrapText(body, 46, 88, 510, 44)}
  </text>
  <rect x="88" y="632" width="600" height="72" rx="36" fill="#1d1a17" />
  <text x="124" y="678" fill="#fff8ef" font-family="${fontFamily}" font-size="26" font-weight="800">${escapeXml(callout)}</text>

  <g filter="url(#shadow)" transform="translate(800 110)">
    <rect width="360" height="520" rx="36" fill="#f6f0e8" />
    <text x="34" y="68" fill="#8a5a24" font-family="${fontFamily}" font-size="17" font-weight="900" letter-spacing="3">KINDLEFLOW</text>
    <text x="34" y="124" fill="#1d1a17" font-family="${fontFamily}" font-size="38" font-weight="900">Send article</text>
    <text x="34" y="184" fill="#1d1a17" font-family="${fontFamily}" font-size="18" font-weight="800">${escapeXml(panelTitle)}</text>
    <rect x="34" y="204" width="292" height="54" rx="16" fill="#fffaf3" stroke="#dbcdbb" />
    <text x="52" y="238" fill="#6f6257" font-family="${fontFamily}" font-size="15">${escapeXml(status)}</text>
    <rect x="34" y="288" width="292" height="58" rx="29" fill="#1d1a17" />
    <text x="100" y="325" fill="#fffaf3" font-family="${fontFamily}" font-size="18" font-weight="800">Send current page</text>
    <rect x="34" y="380" width="292" height="74" rx="18" fill="#eadccb" />
    <text x="58" y="424" fill="#1d1a17" font-family="${fontFamily}" font-size="17" font-weight="800">Download EPUB</text>
  </g>
</svg>
`;
}

function wrapText(value, maxChars, x, y, lineHeight) {
  const words = escapeXml(value).split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.map((text, index) => `<tspan x="${x}" y="${y + index * lineHeight}">${text}</tspan>`).join("");
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
