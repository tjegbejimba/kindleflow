import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTools } from "../mcp/tools.js";
import type { KindleflowClient } from "../shared/kindleflowClient.js";

function makeClient(overrides: Partial<KindleflowClient> = {}): KindleflowClient {
  return {
    sendArticle: vi.fn(),
    sendBatch: vi.fn(),
    listRecent: vi.fn().mockResolvedValue([]),
    retryDelivery: vi.fn(),
    status: vi.fn(),
    ...overrides
  } as KindleflowClient;
}

describe("MCP stdio smoke (in-memory transport)", () => {
  it("lists the four tools and invokes list_recent end-to-end", async () => {
    const kfClient = makeClient({
      listRecent: vi.fn().mockResolvedValue([
        {
          id: "li1",
          title: "Hi",
          filename: "f.epub",
          mimeType: "application/epub+zip",
          createdAt: "2026-05-23",
          latestDelivery: null
        }
      ])
    });

    const server = new McpServer({ name: "kindleflow-mcp-test", version: "0.0.0" });
    for (const tool of createTools(kfClient)) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        async (args: Record<string, unknown>) => (await tool.handler(args ?? {})) as never
      );
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "kindleflow-mcp-test-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const tools = await mcpClient.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "kindleflow.list_recent",
      "kindleflow.retry_delivery",
      "kindleflow.send_article",
      "kindleflow.send_batch",
      "kindleflow.send_file"
    ]);

    const result = await mcpClient.callTool({ name: "kindleflow.list_recent", arguments: { limit: 5 } });
    expect(result.isError).toBeFalsy();
    expect(kfClient.listRecent).toHaveBeenCalledWith(5);

    await mcpClient.close();
    await server.close();
  });
});
