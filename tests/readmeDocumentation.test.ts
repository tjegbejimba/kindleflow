import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("README documentation for downloaded-file sending", () => {
  const readmePath = path.join(__dirname, "..", "README.md");
  const readme = readFileSync(readmePath, "utf-8");

  it("features list mentions sending downloaded PDF and EPUB files to Kindle", () => {
    const featuresSection = readme.match(/##\s+Features[\s\S]*?(?=##)/i)?.[0] || "";
    expect(featuresSection).toMatch(
      /(?:upload|send).*(?:download|local).*(?:pdf|epub)|(?:pdf|epub).*(?:download|local)/i
    );
  });

  it("has a web app usage section explaining upload behavior", () => {
    // Should have a dedicated section about using the web app for uploads
    const webAppSectionMatch = readme.match(/##\s+Web\s+app\s+usage[\s\S]*?(?=\n##\s+[^#]|$)/i);
    expect(webAppSectionMatch).toBeTruthy();
    
    const webAppSection = webAppSectionMatch![0];
    expect(webAppSection.length).toBeGreaterThan(100); // Should be a substantial section
    expect(webAppSection).toMatch(/upload/i);
    expect(webAppSection).toMatch(/pdf.*epub|epub.*pdf/i);
    expect(webAppSection).toMatch(/50\s*MB/i);
  });

  it("web app docs explain file picker, optional title, file types, limits, and library behavior", () => {
    // These details should be somewhere in the README
    expect(readme).toMatch(/file.*picker|choose.*file/i);
    expect(readme).toMatch(/title/i);
    expect(readme).toMatch(/50\s*MB/i);
    expect(readme).toMatch(/pdf.*epub|epub.*pdf/i);
    expect(readme).toMatch(/library/i);
  });

  it("Kindle delivery docs explain SMTP sender reuse", () => {
    expect(readme).toMatch(/SMTP_FROM/);
    expect(readme).toMatch(/approved.*sender|sender.*approved/i);
  });

  it("docs explain uploads appear in Recent/OPDS even when delivery setup is missing", () => {
    // Should explicitly state that library/OPDS work without delivery config
    expect(readme).toMatch(/(?:upload|file).*(?:library|opds|recent)/i);
    expect(readme).toMatch(/(?:without|missing|unavailable).*(?:smtp|delivery|email)/i);
  });

  it("CLI docs include send-file command with title examples", () => {
    expect(readme).toMatch(/kindleflow send-file/);
    expect(readme).toMatch(/--title/);
  });

  it("MCP docs include send_file tool with path semantics", () => {
    expect(readme).toMatch(/kindleflow\.send_file/);
    expect(readme).toMatch(/path/i);
    expect(readme).toMatch(/MCP.*server.*host.*filesystem|host.*filesystem.*MCP/i);
  });

  it("docs warn that SMTP providers may reject under 50 MB due to encoding", () => {
    // Should have a caveat about SMTP provider limits vs file size limits
    const hasSMTPCaveat = readme.match(
      /smtp.*(?:provider|relay).*(?:reject|limit)|(?:reject|limit).*smtp.*(?:provider|relay)/i
    );
    const hasEncodingNote = readme.match(/encod|overhead|base64/i);
    
    expect(hasSMTPCaveat || hasEncodingNote).toBeTruthy();
  });
});
