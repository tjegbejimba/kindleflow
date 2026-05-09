import { describe, expect, it } from "vitest";
import { cookieHeaderForUrl, parseAdditionalCookieHosts } from "../server/substackAuth.js";

describe("Substack auth helpers", () => {
  it("uses the cookie for Substack hosts by default", () => {
    expect(
      cookieHeaderForUrl(new URL("https://newsletter.substack.com/p/post"), {
        cookie: "substack.sid=paid-reader",
        additionalCookieHosts: []
      })
    ).toBe("substack.sid=paid-reader");
  });

  it("uses the cookie for configured custom Substack hosts", () => {
    expect(
      cookieHeaderForUrl(new URL("https://custom-newsletter.example/p/post"), {
        cookie: "substack.sid=paid-reader",
        additionalCookieHosts: ["custom-newsletter.example"]
      })
    ).toBe("substack.sid=paid-reader");
  });

  it("does not use the cookie for unrelated hosts", () => {
    expect(
      cookieHeaderForUrl(new URL("https://example.com/article"), {
        cookie: "substack.sid=paid-reader",
        additionalCookieHosts: []
      })
    ).toBeUndefined();
  });

  it("parses comma-separated custom hosts", () => {
    expect(parseAdditionalCookieHosts(" custom-newsletter.example,Another.example.,custom-newsletter.example ")).toEqual([
      "custom-newsletter.example",
      "another.example"
    ]);
  });
});
