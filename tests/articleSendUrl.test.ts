import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthHelpers } from "../server/auth.js";
import { AuthStore } from "../server/authStore.js";
import {
  registerSendUrlRoute,
  sendArticleByUrl,
  type SendArticleByUrlDeps
} from "../server/articleSendUrl.js";
import type { AppConfig, SmtpConfig } from "../server/config.js";
import type { FetchArticleResult } from "../server/articleFetcher.js";
import type { GeneratedKindleFile } from "../server/kindleFile.js";

const SMTP: SmtpConfig = {
  host: "smtp.test",
  port: 587,
  secure: false,
  from: "kindleflow@test"
};

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "0.0.0.0",
    port: 0,
    dataDir: "/tmp/kf-test",
    dbPath: "/tmp/kf-test/db.sqlite",
    inviteCodesFile: "/tmp/kf-test/invite.txt",
    appBaseUrl: "http://localhost",
    cookieSecure: false,
    sessionTtlDays: 30,
    smtp: SMTP,
    ...overrides
  };
}

const silentLog: any = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLog,
  level: "silent"
};

let tempDir: string;
let store: AuthStore;

function makeArticleFetch(url: string, title = "Hello"): FetchArticleResult {
  return {
    kind: "article",
    sourceUrl: url,
    article: {
      title,
      byline: "",
      contentHtml: `<p>body</p>`,
      textContent: "body",
      excerpt: "body",
      length: 4,
      siteName: "example",
      lang: "en"
    }
  } as FetchArticleResult;
}

function makeFakeGenerated(filename = "hello.epub"): GeneratedKindleFile {
  return {
    id: "abc",
    filename,
    absolutePath: `/tmp/${filename}`,
    mimeType: "application/epub+zip"
  };
}

function makeUser(overrides: { autoSend?: boolean; kindleEmail?: string | null } = {}) {
  const profileUpdate: { autoSendToKindle: boolean; kindleEmail?: string | null } = {
    autoSendToKindle: overrides.autoSend ?? true
  };
  if (overrides.kindleEmail !== undefined) {
    profileUpdate.kindleEmail = overrides.kindleEmail;
  }
  return store.updateUserProfile(seedUserId, profileUpdate);
}

let seedUserId: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-sendurl-"));
  store = new AuthStore(path.join(tempDir, "db.sqlite"));
  const code = store.createLoginCode("tj@example.com", "secret", "secret");
  const session = store.consumeLoginCode("tj@example.com", code);
  seedUserId = store.getUserBySession(session)!.id;
});

afterEach(async () => {
  store.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("sendArticleByUrl orchestration", () => {
  it("sends in sendMode=auto when user opts in and SMTP configured", async () => {
    const user = makeUser({ autoSend: true, kindleEmail: "tj@kindle.com" });

    const fetcher = vi.fn().mockResolvedValue(makeArticleFetch("https://ex/a"));
    const genFile = vi.fn().mockResolvedValue(makeFakeGenerated());
    const savePdf = vi.fn();
    const mailer = vi.fn().mockResolvedValue({ messageId: "m1", response: "250 OK" });

    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: fetcher,
      generateKindleFile: genFile,
      saveKindlePdf: savePdf,
      sendFileToKindle: mailer
    };

    const result = await sendArticleByUrl(deps, {
      user,
      url: "https://ex/a",
      sendMode: "auto"
    });

    expect(result.kind).toBe("article");
    expect(result.deduped).toBe(false);
    expect(result.delivery?.status).toBe("sent");
    expect(mailer).toHaveBeenCalledTimes(1);
  });

  it("does not send in sendMode=auto when user has autoSend=false", async () => {
    const user = makeUser({ autoSend: false, kindleEmail: "tj@kindle.com" });

    const mailer = vi.fn();
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: vi.fn().mockResolvedValue(makeArticleFetch("https://ex/b")),
      generateKindleFile: vi.fn().mockResolvedValue(makeFakeGenerated()),
      saveKindlePdf: vi.fn(),
      sendFileToKindle: mailer
    };

    const result = await sendArticleByUrl(deps, { user, url: "https://ex/b", sendMode: "auto" });
    expect(result.delivery).toBeNull();
    expect(mailer).not.toHaveBeenCalled();
  });

  it("sends in sendMode=force even when autoSend=false", async () => {
    const user = makeUser({ autoSend: false, kindleEmail: "tj@kindle.com" });
    const mailer = vi.fn().mockResolvedValue({ messageId: "m", response: "ok" });
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: vi.fn().mockResolvedValue(makeArticleFetch("https://ex/c")),
      generateKindleFile: vi.fn().mockResolvedValue(makeFakeGenerated()),
      saveKindlePdf: vi.fn(),
      sendFileToKindle: mailer
    };
    const result = await sendArticleByUrl(deps, { user, url: "https://ex/c", sendMode: "force" });
    expect(result.delivery?.status).toBe("sent");
    expect(mailer).toHaveBeenCalledTimes(1);
  });

  it("never sends in sendMode=none, even with autoSend=true", async () => {
    const user = makeUser({ autoSend: true, kindleEmail: "tj@kindle.com" });
    const mailer = vi.fn();
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: vi.fn().mockResolvedValue(makeArticleFetch("https://ex/d")),
      generateKindleFile: vi.fn().mockResolvedValue(makeFakeGenerated()),
      saveKindlePdf: vi.fn(),
      sendFileToKindle: mailer
    };
    const result = await sendArticleByUrl(deps, { user, url: "https://ex/d", sendMode: "none" });
    expect(result.delivery).toBeNull();
    expect(mailer).not.toHaveBeenCalled();
  });

  it("does not fetch again on pre-fetch dedupe by raw URL", async () => {
    const user = makeUser({ autoSend: true, kindleEmail: "tj@kindle.com" });
    // Seed an existing library item for the URL.
    store.addLibraryItem(user.id, {
      type: "article",
      title: "existing",
      sourceUrl: "https://ex/e",
      filename: "existing.epub",
      mimeType: "application/epub+zip"
    });
    const fetcher = vi.fn();
    const mailer = vi.fn();
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: fetcher,
      generateKindleFile: vi.fn(),
      saveKindlePdf: vi.fn(),
      sendFileToKindle: mailer
    };
    const result = await sendArticleByUrl(deps, { user, url: "https://ex/e", sendMode: "auto" });
    expect(result.deduped).toBe(true);
    expect(result.delivery).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(mailer).not.toHaveBeenCalled();
  });

  it("dedupes post-fetch when the resolved URL differs from the raw input", async () => {
    const user = makeUser({ autoSend: true, kindleEmail: "tj@kindle.com" });
    store.addLibraryItem(user.id, {
      type: "article",
      title: "existing",
      sourceUrl: "https://ex/canonical",
      filename: "existing.epub",
      mimeType: "application/epub+zip"
    });
    const fetcher = vi.fn().mockResolvedValue(makeArticleFetch("https://ex/canonical"));
    const genFile = vi.fn();
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: fetcher,
      generateKindleFile: genFile,
      saveKindlePdf: vi.fn(),
      sendFileToKindle: vi.fn()
    };
    const result = await sendArticleByUrl(deps, {
      user,
      url: "https://ex/raw?utm=1",
      sendMode: "auto"
    });
    expect(result.deduped).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(genFile).not.toHaveBeenCalled();
  });

  it("returns a failed delivery without throwing when SMTP errors", async () => {
    const user = makeUser({ autoSend: true, kindleEmail: "tj@kindle.com" });
    const mailer = vi.fn().mockRejectedValue(new Error("SMTP exploded"));
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: vi.fn().mockResolvedValue(makeArticleFetch("https://ex/f")),
      generateKindleFile: vi.fn().mockResolvedValue(makeFakeGenerated()),
      saveKindlePdf: vi.fn(),
      sendFileToKindle: mailer
    };
    const result = await sendArticleByUrl(deps, { user, url: "https://ex/f", sendMode: "force" });
    expect(result.delivery?.status).toBe("failed");
    expect(result.delivery?.error).toContain("SMTP");
  });

  it("rejects sendMode=force without SMTP", async () => {
    const user = makeUser({ autoSend: true });
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig({ smtp: undefined }),
      log: silentLog,
      fetchAndExtractArticle: vi.fn(),
      generateKindleFile: vi.fn(),
      saveKindlePdf: vi.fn(),
      sendFileToKindle: vi.fn()
    };
    await expect(
      sendArticleByUrl(deps, { user, url: "https://ex/g", sendMode: "force" })
    ).rejects.toThrow(/email delivery/i);
  });

  it("PDF: pauses auto-send in sendMode=auto for a good-epub-candidate verdict", async () => {
    const user = makeUser({ autoSend: true, kindleEmail: "tj@kindle.com" });
    const pdfBuffer = Buffer.from("%PDF-1.4\n");
    const pdfResult: FetchArticleResult = {
      kind: "pdf",
      sourceUrl: "https://ex/article.pdf",
      title: "Article",
      pdfBuffer,
      analysis: { verdict: "good-epub-candidate", reasons: ["portrait", "text-heavy"] } as any
    };
    const mailer = vi.fn();
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: vi.fn().mockResolvedValue(pdfResult),
      generateKindleFile: vi.fn(),
      saveKindlePdf: vi.fn().mockResolvedValue({
        id: "p1",
        filename: "article.pdf",
        absolutePath: "/tmp/article.pdf",
        mimeType: "application/pdf"
      } satisfies GeneratedKindleFile),
      sendFileToKindle: mailer
    };
    const result = await sendArticleByUrl(deps, {
      user,
      url: "https://ex/article.pdf",
      sendMode: "auto"
    });
    expect(result.kind).toBe("pdf");
    expect(result.pdfVerdict).toBe("good-epub-candidate");
    expect(result.delivery).toBeNull();
    expect(mailer).not.toHaveBeenCalled();
  });

  it("PDF: auto-sends in sendMode=auto for a better-as-pdf verdict", async () => {
    const user = makeUser({ autoSend: true, kindleEmail: "tj@kindle.com" });
    const pdfBuffer = Buffer.from("%PDF-1.4\n");
    const pdfResult: FetchArticleResult = {
      kind: "pdf",
      sourceUrl: "https://ex/slides.pdf",
      title: "Slides",
      pdfBuffer,
      analysis: { verdict: "better-as-pdf", reasons: ["landscape"] } as any
    };
    const mailer = vi.fn().mockResolvedValue({ messageId: "m", response: "ok" });
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: vi.fn().mockResolvedValue(pdfResult),
      generateKindleFile: vi.fn(),
      saveKindlePdf: vi.fn().mockResolvedValue({
        id: "p3",
        filename: "slides3.pdf",
        absolutePath: "/tmp/slides3.pdf",
        mimeType: "application/pdf"
      } satisfies GeneratedKindleFile),
      sendFileToKindle: mailer
    };
    const result = await sendArticleByUrl(deps, {
      user,
      url: "https://ex/slides.pdf",
      sendMode: "auto"
    });
    expect(result.delivery?.status).toBe("sent");
    expect(mailer).toHaveBeenCalledTimes(1);
  });

  it("PDF: sendMode=force overrides shouldAutoSendPdf", async () => {
    const user = makeUser({ autoSend: false, kindleEmail: "tj@kindle.com" });
    const pdfBuffer = Buffer.from("%PDF-1.4\n");
    const pdfResult: FetchArticleResult = {
      kind: "pdf",
      sourceUrl: "https://ex/slides.pdf",
      title: "Slides",
      pdfBuffer,
      analysis: { verdict: "better-as-pdf", reasons: ["landscape"] } as any
    };
    const mailer = vi.fn().mockResolvedValue({ messageId: "m", response: "250 OK" });
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: vi.fn().mockResolvedValue(pdfResult),
      generateKindleFile: vi.fn(),
      saveKindlePdf: vi.fn().mockResolvedValue({
        id: "p2",
        filename: "slides2.pdf",
        absolutePath: "/tmp/slides2.pdf",
        mimeType: "application/pdf"
      } satisfies GeneratedKindleFile),
      sendFileToKindle: mailer
    };
    const result = await sendArticleByUrl(deps, {
      user,
      url: "https://ex/slides.pdf",
      sendMode: "force"
    });
    expect(result.delivery?.status).toBe("sent");
    expect(mailer).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/articles/send-url route", () => {
  async function buildApp(deps: SendArticleByUrlDeps): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(fastifyCookie);
    const auth = createAuthHelpers(store, "kf_session");
    registerSendUrlRoute(app, deps, auth);
    await app.ready();
    return app;
  }

  it("requires auth and accepts a bearer token", async () => {
    const user = makeUser({ autoSend: false, kindleEmail: "tj@kindle.com" });
    const token = store.createApiToken(user.id, "cli").token;

    const fetcher = vi.fn().mockResolvedValue(makeArticleFetch("https://ex/route"));
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: fetcher,
      generateKindleFile: vi.fn().mockResolvedValue(makeFakeGenerated()),
      saveKindlePdf: vi.fn(),
      sendFileToKindle: vi.fn()
    };
    const app = await buildApp(deps);

    const noAuth = await app.inject({
      method: "POST",
      url: "/api/articles/send-url",
      payload: { url: "https://ex/route", sendMode: "none" }
    });
    expect(noAuth.statusCode).toBe(401);

    const bearer = await app.inject({
      method: "POST",
      url: "/api/articles/send-url",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { url: "https://ex/route", sendMode: "none" }
    });
    expect(bearer.statusCode).toBe(200);
    expect(bearer.json().kind).toBe("article");
    expect(bearer.json().delivery).toBeNull();

    await app.close();
  });

  it("returns 400 when URL is missing", async () => {
    const user = makeUser({ kindleEmail: "tj@kindle.com" });
    const token = store.createApiToken(user.id, "cli").token;
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: vi.fn(),
      generateKindleFile: vi.fn(),
      saveKindlePdf: vi.fn(),
      sendFileToKindle: vi.fn()
    };
    const app = await buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/api/articles/send-url",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {}
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("surfaces 422 with code IMPORT_FAILED when the fetcher throws", async () => {
    const user = makeUser({ kindleEmail: "tj@kindle.com" });
    const token = store.createApiToken(user.id, "cli").token;
    const deps: SendArticleByUrlDeps = {
      store,
      config: makeConfig(),
      log: silentLog,
      fetchAndExtractArticle: vi.fn().mockRejectedValue(new Error("DNS failure")),
      generateKindleFile: vi.fn(),
      saveKindlePdf: vi.fn(),
      sendFileToKindle: vi.fn()
    };
    const app = await buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/api/articles/send-url",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { url: "https://ex/nope", sendMode: "none" }
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message ?? res.json().error).toMatch(/DNS/);
    await app.close();
  });
});
