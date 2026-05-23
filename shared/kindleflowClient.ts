// Pure TypeScript HTTP client for the KindleFlow server.
// No Node-specific deps beyond global fetch. Importable by CLI, MCP, and tests.

export type SendMode = "auto" | "force" | "none";

export type ErrorCode = "AUTH" | "IMPORT" | "DELIVERY" | "NETWORK" | "UNKNOWN";

export const EXIT_CODES: Record<ErrorCode | "SUCCESS", number> = {
  SUCCESS: 0,
  AUTH: 2,
  IMPORT: 3,
  DELIVERY: 4,
  NETWORK: 5,
  UNKNOWN: 1
};

export class KindleflowError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly status?: number;

  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.name = "KindleflowError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.status = status;
  }
}

export interface ClientConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface SendArticleOptions {
  title?: string;
  sendMode?: SendMode;
  signal?: AbortSignal;
}

export interface DeliverySummary {
  id: string;
  status: "pending" | "sent" | "failed";
  error?: string;
  messageId?: string;
}

export interface SendArticleResult {
  kind: "article" | "pdf";
  libraryItemId: string;
  filename: string;
  mimeType: string;
  sourceUrl: string;
  title: string;
  deduped: boolean;
  delivery: DeliverySummary | null;
  pdfVerdict?: string;
}

export type BatchEvent =
  | { type: "start"; total: number }
  | { type: "item"; index: number; url: string; ok: true; deduped: boolean; result: SendArticleResult }
  | { type: "item"; index: number; url: string; ok: false; error: { code: ErrorCode; message: string } }
  | { type: "done"; total: number; sent: number; deduped: number; failed: number };

export interface SendBatchOptions {
  sendMode?: SendMode;
  signal?: AbortSignal;
}

export interface RecentItem {
  id: string;
  title: string;
  filename: string;
  mimeType: string;
  sourceUrl?: string;
  createdAt: string;
  latestDelivery: { id: string; status: "pending" | "sent" | "failed"; updatedAt: string } | null;
}

export interface DeliveryRow {
  id: string;
  title: string;
  filename: string;
  status: "pending" | "sent" | "failed";
  error?: string;
  attempts: number;
  updatedAt: string;
}

export interface StatusResult {
  reachable: boolean;
  authOk: boolean;
  smtpConfigured: boolean;
  kindleEmail?: string;
  user?: { email: string };
  recent: RecentItem[];
}

export interface KindleflowClient {
  sendArticle(url: string, opts?: SendArticleOptions): Promise<SendArticleResult>;
  sendBatch(urls: string[], opts?: SendBatchOptions): AsyncIterable<BatchEvent>;
  listRecent(limit?: number): Promise<RecentItem[]>;
  retryDelivery(deliveryId: string): Promise<DeliveryRow>;
  status(): Promise<StatusResult>;
}

export function createClient(cfg: ClientConfig): KindleflowClient {
  if (!cfg.baseUrl) throw new Error("baseUrl is required");
  if (!cfg.token) throw new Error("token is required");
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;

  async function request<T>(
    method: string,
    pathname: string,
    options: { body?: unknown; signal?: AbortSignal; expectJson?: boolean } = {}
  ): Promise<T> {
    const url = `${baseUrl}${pathname}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${cfg.token}`,
          ...(options.body !== undefined ? { "content-type": "application/json" } : {})
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      throw new KindleflowError(
        "NETWORK",
        `Could not reach KindleFlow at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      const message = extractMessage(errBody) ?? `HTTP ${response.status}`;
      const code = mapStatusToCode(response.status, message);
      throw new KindleflowError(code, message, response.status);
    }

    if (options.expectJson === false) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async function sendArticle(url: string, opts: SendArticleOptions = {}): Promise<SendArticleResult> {
    const result = await request<SendArticleResult>("POST", "/api/articles/send-url", {
      body: { url, title: opts.title, sendMode: opts.sendMode ?? "auto" },
      signal: opts.signal
    });
    if (result.delivery?.status === "failed") {
      // sendArticle still resolves with the result; callers can inspect delivery.
      // But for `force` mode the CLI may want to exit 4. Leaving that to the caller.
    }
    return result;
  }

  async function listRecent(limit = 25): Promise<RecentItem[]> {
    const { items } = await request<{ items: RecentItem[] }>(
      "GET",
      `/api/library/recent?limit=${encodeURIComponent(String(limit))}`
    );
    return items;
  }

  async function retryDelivery(deliveryId: string): Promise<DeliveryRow> {
    const { delivery } = await request<{ delivery: DeliveryRow }>(
      "POST",
      `/api/deliveries/${encodeURIComponent(deliveryId)}/retry`
    );
    return delivery;
  }

  async function status(): Promise<StatusResult> {
    try {
      const [me, cfgResponse] = await Promise.all([
        request<{ user: { email: string; kindleEmail?: string } | null }>("GET", "/api/me"),
        request<{ emailDeliveryEnabled: boolean }>("GET", "/api/config")
      ]);
      if (!me.user) {
        throw new KindleflowError("AUTH", "Token is not associated with a user.");
      }
      const recent = await listRecent(5).catch(() => [] as RecentItem[]);
      return {
        reachable: true,
        authOk: true,
        smtpConfigured: Boolean(cfgResponse.emailDeliveryEnabled),
        kindleEmail: me.user.kindleEmail,
        user: { email: me.user.email },
        recent
      };
    } catch (err) {
      if (err instanceof KindleflowError && err.code === "NETWORK") {
        return {
          reachable: false,
          authOk: false,
          smtpConfigured: false,
          recent: []
        };
      }
      throw err;
    }
  }

  function sendBatch(urls: string[], opts: SendBatchOptions = {}): AsyncIterable<BatchEvent> {
    return {
      [Symbol.asyncIterator]: () => sendBatchIterator(urls, opts)
    };
  }

  async function* sendBatchIterator(urls: string[], opts: SendBatchOptions): AsyncIterator<BatchEvent> {
    type Item = { url: string; index: number; duplicateOfIndex?: number };

    const items: Item[] = [];
    const normalisedSeen = new Map<string, number>();
    for (let i = 0; i < urls.length; i += 1) {
      const normalised = normaliseUrl(urls[i]);
      const existingIndex = normalisedSeen.get(normalised);
      items.push({ url: urls[i], index: i, duplicateOfIndex: existingIndex });
      if (existingIndex === undefined) {
        normalisedSeen.set(normalised, i);
      }
    }

    yield { type: "start", total: urls.length };

    let sent = 0;
    let deduped = 0;
    let failed = 0;

    for (const item of items) {
      if (opts.signal?.aborted) break;
      if (item.duplicateOfIndex !== undefined) {
        deduped += 1;
        yield {
          type: "item",
          index: item.index,
          url: item.url,
          ok: true,
          deduped: true,
          result: {
            kind: "article",
            libraryItemId: "",
            filename: "",
            mimeType: "",
            sourceUrl: item.url,
            title: "(duplicate within batch)",
            deduped: true,
            delivery: null
          }
        };
        continue;
      }
      try {
        const result = await sendArticle(item.url, {
          sendMode: opts.sendMode ?? "auto",
          signal: opts.signal
        });
        if (result.deduped) {
          deduped += 1;
        } else if (result.delivery?.status === "sent") {
          sent += 1;
        }
        yield {
          type: "item",
          index: item.index,
          url: item.url,
          ok: true,
          deduped: result.deduped,
          result
        };
      } catch (err) {
        failed += 1;
        const code = err instanceof KindleflowError ? err.code : "UNKNOWN";
        const message = err instanceof Error ? err.message : String(err);
        yield {
          type: "item",
          index: item.index,
          url: item.url,
          ok: false,
          error: { code, message }
        };
      }
    }

    yield { type: "done", total: urls.length, sent, deduped, failed };
  }

  return { sendArticle, sendBatch, listRecent, retryDelivery, status };
}

function normaliseUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    return u.toString();
  } catch {
    return raw.trim();
  }
}

function mapStatusToCode(status: number, message: string): ErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 400 || status === 404 || status === 422) {
    if (/SMTP|deliver|kindle email/i.test(message)) return "DELIVERY";
    return "IMPORT";
  }
  return "UNKNOWN";
}

function extractMessage(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? null;
  } catch {
    return body.length > 200 ? null : body;
  }
}
