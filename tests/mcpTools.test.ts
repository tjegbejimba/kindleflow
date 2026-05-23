import { describe, expect, it, vi } from "vitest";
import { createTools } from "../mcp/tools.js";
import type { KindleflowClient, SendArticleResult, RecentItem } from "../shared/kindleflowClient.js";

function makeClient(overrides: Partial<KindleflowClient> = {}): KindleflowClient {
  return {
    sendArticle: vi.fn(),
    sendBatch: vi.fn(),
    listRecent: vi.fn(),
    retryDelivery: vi.fn(),
    status: vi.fn(),
    ...overrides
  } as KindleflowClient;
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

describe("MCP tool handlers", () => {
  it("registers exactly the four issue-spec tools", () => {
    const tools = createTools(makeClient());
    expect(tools.map((t) => t.name).sort()).toEqual([
      "kindleflow.list_recent",
      "kindleflow.retry_delivery",
      "kindleflow.send_article",
      "kindleflow.send_batch"
    ]);
  });

  it("tool input schemas declare the expected keys", () => {
    const tools = createTools(makeClient());
    const summary = Object.fromEntries(
      tools.map((t) => [t.name, Object.keys(t.inputSchema)])
    );
    expect(summary).toEqual({
      "kindleflow.send_article": ["url", "title", "sendMode"],
      "kindleflow.send_batch": ["urls", "sendMode"],
      "kindleflow.list_recent": ["limit"],
      "kindleflow.retry_delivery": ["deliveryId"]
    });
  });

  it("send_article passes args through and returns the structured result", async () => {
    const send = vi.fn().mockResolvedValue(articleResult);
    const client = makeClient({ sendArticle: send });
    const tool = createTools(client).find((t) => t.name === "kindleflow.send_article")!;
    const res = await tool.handler({ url: "https://ex/a", sendMode: "force" });
    expect(send).toHaveBeenCalledWith("https://ex/a", { title: undefined, sendMode: "force" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.libraryItemId).toBe("li1");
  });

  it("send_article returns an MCP error result on client failure", async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("nope"), { code: "AUTH" }));
    const client = makeClient({ sendArticle: send });
    const tool = createTools(client).find((t) => t.name === "kindleflow.send_article")!;
    const res = await tool.handler({ url: "https://ex/a" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("nope");
  });

  it("send_batch streams events from the client's async iterator", async () => {
    const fakeIterable = (async function* () {
      yield { type: "start" as const, total: 1 };
      yield {
        type: "item" as const,
        index: 0,
        url: "https://ex/a",
        ok: true as const,
        deduped: false,
        result: articleResult
      };
      yield { type: "done" as const, total: 1, sent: 1, deduped: 0, failed: 0 };
    })();
    const client = makeClient({ sendBatch: () => fakeIterable as any });
    const tool = createTools(client).find((t) => t.name === "kindleflow.send_batch")!;
    const progress: any[] = [];
    const res = await tool.handler({ urls: ["https://ex/a"] }, {
      onProgress: (ev) => progress.push(ev)
    });
    expect(res.isError).toBeFalsy();
    const events = (res.structuredContent as { events: unknown[] }).events;
    expect(events).toHaveLength(3);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ status: "ok", index: 0 });
  });

  it("list_recent forwards limit and returns items", async () => {
    const items: RecentItem[] = [];
    const listRecent = vi.fn().mockResolvedValue(items);
    const client = makeClient({ listRecent });
    const tool = createTools(client).find((t) => t.name === "kindleflow.list_recent")!;
    await tool.handler({ limit: 10 });
    expect(listRecent).toHaveBeenCalledWith(10);
  });

  it("retry_delivery returns the delivery row", async () => {
    const retryDelivery = vi.fn().mockResolvedValue({ id: "d1", status: "sent" });
    const client = makeClient({ retryDelivery });
    const tool = createTools(client).find((t) => t.name === "kindleflow.retry_delivery")!;
    const res = await tool.handler({ deliveryId: "d1" });
    expect(retryDelivery).toHaveBeenCalledWith("d1");
    expect((res.structuredContent as { delivery: { id: string } }).delivery.id).toBe("d1");
  });
});
