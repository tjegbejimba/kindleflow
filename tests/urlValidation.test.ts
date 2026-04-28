import { describe, expect, it } from "vitest";
import { validateFetchUrl } from "../server/urlValidation.js";

describe("validateFetchUrl", () => {
  it("accepts normal public http and https article URLs", async () => {
    await expect(validateFetchUrl("https://example.com/articles/post")).resolves.toEqual(
      new URL("https://example.com/articles/post")
    );
    await expect(validateFetchUrl("http://example.com/blog")).resolves.toEqual(new URL("http://example.com/blog"));
  });

  it("rejects non-http schemes and malformed URLs", async () => {
    await expect(validateFetchUrl("file:///etc/passwd")).rejects.toThrow(/http/i);
    await expect(validateFetchUrl("not a url")).rejects.toThrow(/valid URL/i);
  });

  it("rejects localhost and internal hostnames", async () => {
    await expect(validateFetchUrl("http://localhost:3000")).rejects.toThrow(/not allowed/i);
    await expect(validateFetchUrl("http://printer.local/article")).rejects.toThrow(/not allowed/i);
    await expect(validateFetchUrl("http://nas.lan/article")).rejects.toThrow(/not allowed/i);
    await expect(validateFetchUrl("http://server.internal/article")).rejects.toThrow(/not allowed/i);
  });

  it("rejects private, link-local, loopback, and metadata IPs", async () => {
    const blockedUrls = [
      "http://127.0.0.1/article",
      "http://10.0.0.5/article",
      "http://172.16.0.5/article",
      "http://192.168.1.10/article",
      "http://169.254.10.20/article",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/article",
      "http://[fc00::1]/article",
      "http://[fe80::1]/article"
    ];

    for (const url of blockedUrls) {
      await expect(validateFetchUrl(url)).rejects.toThrow(/not allowed/i);
    }
  });
});
