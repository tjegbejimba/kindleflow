import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Content, Options } from "epub-gen-memory";
import type { ExtractedArticle } from "./articleExtraction.js";
import { generateCoverPng } from "./coverImage.js";

type EpubGenerator = (optionsOrTitle: Options | string, content: Content, ...args: (boolean | number)[]) => Promise<Buffer>;

const require = createRequire(import.meta.url);
const generateEpub = (require("epub-gen-memory") as { default: EpubGenerator }).default;

export interface GeneratedKindleFile {
  id: string;
  filename: string;
  absolutePath: string;
  mimeType: "application/epub+zip";
}

export interface GenerateKindleFileOptions {
  dataDir: string;
  sourceUrl?: string;
}

export async function generateKindleFile(
  article: Pick<ExtractedArticle, "title" | "contentHtml" | "textContent">,
  options: GenerateKindleFileOptions
): Promise<GeneratedKindleFile> {
  const id = randomUUID().slice(0, 8);
  const filename = `${slugify(article.title)}-${id}.epub`;
  const dataDir = path.resolve(options.dataDir);
  const absolutePath = path.resolve(dataDir, filename);

  if (!absolutePath.startsWith(`${dataDir}${path.sep}`)) {
    throw new Error("Generated file path escaped the data directory.");
  }

  await mkdir(dataDir, { recursive: true });

  const cover = new File([new Uint8Array(generateCoverPng({ title: article.title, sourceUrl: options.sourceUrl }))], "cover.png", {
    type: "image/png"
  });
  const sourceLink = options.sourceUrl
    ? `<hr /><p><em>Original article:</em> <a href="${escapeHtml(options.sourceUrl)}">${escapeHtml(options.sourceUrl)}</a></p>`
    : "";
  const buffer = await generateEpub(
    {
      title: article.title,
      author: "KindleFlow",
      publisher: "KindleFlow",
      lang: "en",
      cover,
      css: `
        body { font-family: serif; line-height: 1.45; margin: 5%; }
        h1, h2, h3 { line-height: 1.2; }
        blockquote { border-left: 0.2em solid #999; margin-left: 0; padding-left: 1em; }
        pre, code { font-family: monospace; white-space: pre-wrap; }
      `,
      version: 3,
      ignoreFailedDownloads: true,
      verbose: false
    },
    [
      {
        title: article.title,
        content: `${article.contentHtml}${sourceLink}`,
        url: options.sourceUrl
      }
    ]
  );

  await writeFile(absolutePath, buffer);

  return {
    id,
    filename,
    absolutePath,
    mimeType: "application/epub+zip"
  };
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "article";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
