#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "../shared/kindleflowClient.js";
import { createTools } from "./tools.js";

const baseUrl = process.env.KINDLEFLOW_URL;
const token = process.env.KINDLEFLOW_TOKEN;
if (!baseUrl || !token) {
  process.stderr.write(
    "kindleflow-mcp: KINDLEFLOW_URL and KINDLEFLOW_TOKEN must be set in the environment.\n"
  );
  process.exit(2);
}

const client = createClient({ baseUrl, token });
const server = new McpServer({ name: "kindleflow-mcp", version: "0.1.0" });

for (const tool of createTools(client)) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema
    },
    async (args: Record<string, unknown>) => {
      const result = await tool.handler(args ?? {});
      return result as never;
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
