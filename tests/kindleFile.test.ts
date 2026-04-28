import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKindleFile } from "../server/kindleFile.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("generateKindleFile", () => {
  it("writes an EPUB for an extracted article into the data directory", async () => {
    const file = await generateKindleFile(
      {
        title: "A Clean Kindle Article!",
        contentHtml: "<p>This article becomes an EPUB that can be sent to Kindle.</p>",
        textContent: "This article becomes an EPUB that can be sent to Kindle."
      },
      { dataDir: tempDir, sourceUrl: "https://example.com/articles/clean" }
    );

    expect(file.mimeType).toBe("application/epub+zip");
    expect(file.filename).toMatch(/^a-clean-kindle-article-[a-z0-9]+\.epub$/);
    expect(file.absolutePath.startsWith(tempDir)).toBe(true);

    const bytes = await readFile(file.absolutePath);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
  });
});
