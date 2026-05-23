// MCP server tool definitions and a factory that wires them to a KindleflowClient.
// Kept separate from the stdio entrypoint so tests can call the handlers directly.

import { z, type ZodRawShape } from "zod";
import type { KindleflowClient } from "../shared/kindleflowClient.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (input: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  onProgress?: (event: { url: string; index: number; status: string; total: number }) => void;
  signal?: AbortSignal;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>
  };
}

function err(message: string, code?: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, code }) }],
    isError: true
  };
}

const sendModeSchema = z.enum(["auto", "force", "none"]).optional();

export function createTools(client: KindleflowClient): ToolDefinition[] {
  return [
    {
      name: "kindleflow.send_article",
      description:
        "Import a URL into KindleFlow, generate an EPUB, and (depending on sendMode) deliver it to Kindle.",
      inputSchema: {
        url: z.string().describe("Article or PDF URL to import."),
        title: z.string().optional().describe("Optional title override."),
        sendMode: sendModeSchema.describe(
          "auto = respect user's auto-send setting (default); force = always send; none = generate only."
        )
      },
      handler: async (input) => {
        try {
          const result = await client.sendArticle(String(input.url), {
            title: typeof input.title === "string" ? input.title : undefined,
            sendMode: (input.sendMode as "auto" | "force" | "none" | undefined) ?? "auto"
          });
          return ok(result);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e), (e as { code?: string }).code);
        }
      }
    },
    {
      name: "kindleflow.send_batch",
      description: "Import a list of URLs in turn. Emits structured per-item results.",
      inputSchema: {
        urls: z.array(z.string()),
        sendMode: sendModeSchema
      },
      handler: async (input, ctx) => {
        const urls = Array.isArray(input.urls) ? (input.urls as string[]) : [];
        const sendMode = (input.sendMode as "auto" | "force" | "none" | undefined) ?? "auto";
        const events: unknown[] = [];
        let total = 0;
        try {
          for await (const ev of client.sendBatch(urls, { sendMode, signal: ctx?.signal })) {
            events.push(ev);
            if (ev.type === "start") total = ev.total;
            if (ev.type === "item" && ctx?.onProgress) {
              ctx.onProgress({
                url: ev.url,
                index: ev.index,
                status: ev.ok ? (ev.deduped ? "deduped" : "ok") : `error:${ev.error.code}`,
                total
              });
            }
          }
          return ok({ events });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e), (e as { code?: string }).code);
        }
      }
    },
    {
      name: "kindleflow.list_recent",
      description: "List recent imported items and their latest delivery status.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max number of items (default 25).")
      },
      handler: async (input) => {
        try {
          const items = await client.listRecent(
            typeof input.limit === "number" ? input.limit : undefined
          );
          return ok({ items });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e), (e as { code?: string }).code);
        }
      }
    },
    {
      name: "kindleflow.retry_delivery",
      description: "Retry a previously failed Kindle delivery by ID.",
      inputSchema: {
        deliveryId: z.string()
      },
      handler: async (input) => {
        try {
          const delivery = await client.retryDelivery(String(input.deliveryId));
          return ok({ delivery });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e), (e as { code?: string }).code);
        }
      }
    }
  ];
}
