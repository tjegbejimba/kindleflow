import { describe, expect, it, vi } from "vitest";
import {
  createClient,
  EXIT_CODES,
  KindleflowError,
  type BatchEvent,
  type SendArticleResult
} from "../shared/kindleflowClient.js";

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

const articleResult: SendArticleResult = {
  kind: "article",
  libraryItemId: "li1",
  filename: "f.epub",
  mimeType: "application/epub+zip",
  sourceUrl: "https://ex/a",
  title: "A",
  deduped: false,
  delivery: { id: "d1", status: "sent" }
};

describe("kindleflowClient", () => {
  it("includes Authorization: Bearer on every request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200, articleResult));
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    await client.sendArticle("https://ex/a", { sendMode: "auto" });
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe("http://test/api/articles/send-url");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers.authorization).toBe("Bearer kf_pat_x");
    expect(JSON.parse(call[1].body)).toEqual({
      url: "https://ex/a",
      title: undefined,
      sendMode: "auto"
    });
  });

  it("maps 401 to KindleflowError(AUTH) with exit code 2", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse(401, { message: "unauthorised" }));
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    await expect(client.sendArticle("https://ex/a")).rejects.toMatchObject({
      code: "AUTH",
      exitCode: EXIT_CODES.AUTH
    });
  });

  it("maps 422 import failure to IMPORT (exit 3)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse(422, { message: "Article fetch failed" }));
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    await expect(client.sendArticle("https://ex/a")).rejects.toMatchObject({
      code: "IMPORT",
      exitCode: EXIT_CODES.IMPORT
    });
  });

  it("maps SMTP-related 400 to DELIVERY (exit 4)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(400, { message: "Kindle email delivery is not configured" })
    );
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    await expect(client.sendArticle("https://ex/a", { sendMode: "force" })).rejects.toMatchObject({
      code: "DELIVERY",
      exitCode: EXIT_CODES.DELIVERY
    });
  });

  it("maps network errors to NETWORK", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("connection refused"));
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    await expect(client.listRecent()).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("status() surfaces reachability and smtp config", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/me")) {
        return Promise.resolve(makeResponse(200, { user: { email: "tj@example.com", kindleEmail: "kc@k" } }));
      }
      if (url.endsWith("/api/config")) {
        return Promise.resolve(makeResponse(200, { emailDeliveryEnabled: true }));
      }
      if (url.includes("/api/library/recent")) {
        return Promise.resolve(makeResponse(200, { items: [] }));
      }
      return Promise.resolve(makeResponse(404, "nope"));
    });
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    const s = await client.status();
    expect(s).toMatchObject({ reachable: true, authOk: true, smtpConfigured: true, user: { email: "tj@example.com" } });
  });

  it("status() returns reachable=false on network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("offline"));
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    const s = await client.status();
    expect(s.reachable).toBe(false);
    expect(s.authOk).toBe(false);
  });

  it("sendBatch dedupes raw URLs within a batch and emits events", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200, articleResult));
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    const events: BatchEvent[] = [];
    for await (const ev of client.sendBatch(
      ["https://ex/a", "https://ex/a#frag", "https://ex/b"],
      { sendMode: "auto" }
    )) {
      events.push(ev);
    }
    expect(events[0]).toEqual({ type: "start", total: 3 });
    expect(events.at(-1)).toMatchObject({ type: "done", total: 3, deduped: 1 });
    // Two items should have hit the network (a and b); one was the in-batch dupe.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const dup = events.find(
      (e) => e.type === "item" && e.url === "https://ex/a#frag" && e.ok === true && (e as any).deduped
    );
    expect(dup).toBeTruthy();
  });

  it("sendBatch surfaces post-fetch server-side dedupe in the event stream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, { ...articleResult, deduped: true, delivery: null } satisfies SendArticleResult)
    );
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    const events: BatchEvent[] = [];
    for await (const ev of client.sendBatch(["https://ex/a"], { sendMode: "auto" })) {
      events.push(ev);
    }
    const done = events.find((e) => e.type === "done") as { deduped: number };
    expect(done.deduped).toBe(1);
  });

  it("sendBatch records failures with their code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(401, { message: "unauthorised" })
    );
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    const events: BatchEvent[] = [];
    for await (const ev of client.sendBatch(["https://ex/a"], { sendMode: "auto" })) {
      events.push(ev);
    }
    const failure = events.find((e) => e.type === "item" && e.ok === false) as {
      error: { code: string };
    };
    expect(failure.error.code).toBe("AUTH");
    const done = events.find((e) => e.type === "done") as { failed: number };
    expect(done.failed).toBe(1);
  });

  it("sendBatch honours AbortSignal", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve(makeResponse(200, articleResult));
    });
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    const controller = new AbortController();
    const events: BatchEvent[] = [];
    for await (const ev of client.sendBatch(["https://ex/a", "https://ex/b", "https://ex/c"], {
      signal: controller.signal
    })) {
      events.push(ev);
      if (calls === 1) controller.abort();
    }
    // After aborting, the loop should break before processing the third URL.
    expect(calls).toBeLessThan(3);
  });

  it("retryDelivery posts to the correct endpoint and returns the row", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, { delivery: { id: "d1", status: "sent", title: "T", filename: "f", attempts: 2, updatedAt: "x" } })
    );
    const client = createClient({ baseUrl: "http://test", token: "kf_pat_x", fetchImpl: fetchImpl as any });
    const row = await client.retryDelivery("d1");
    expect(row.id).toBe("d1");
    expect(fetchImpl.mock.calls[0][0]).toBe("http://test/api/deliveries/d1/retry");
  });
});
