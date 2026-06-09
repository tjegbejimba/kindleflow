import {
  createClient,
  EXIT_CODES,
  KindleflowError,
  type BatchEvent,
  type KindleflowClient,
  type RecentItem,
  type SendArticleResult,
  type SendMode
} from "../shared/kindleflowClient.js";
import { loadCliConfig, writeConfigFile, defaultConfigPath } from "./config.js";

export interface CliIO {
  stdout: NodeJS.WriteStream | { write(chunk: string): boolean | void; isTTY?: boolean };
  stderr: NodeJS.WriteStream | { write(chunk: string): boolean | void };
  exit(code: number): never;
  env: NodeJS.ProcessEnv;
}

export interface CliDeps {
  io: CliIO;
  // Optional override (used in tests) so we can inject a stub client without HTTP.
  makeClient?: (cfg: { baseUrl: string; token: string }) => KindleflowClient;
  configPath?: string;
}

export interface CommonFlags {
  url?: string;
  token?: string;
}

async function getClient(deps: CliDeps, flags: CommonFlags): Promise<KindleflowClient> {
  const resolved = await loadCliConfig({
    flagUrl: flags.url,
    flagToken: flags.token,
    env: deps.io.env,
    configPath: deps.configPath
  });

  if (!resolved.url) {
    deps.io.stderr.write(
      "error: KindleFlow URL is not configured. Set KINDLEFLOW_URL, pass --url, or run `kindleflow login`.\n"
    );
    deps.io.exit(EXIT_CODES.AUTH);
  }
  if (!resolved.token) {
    deps.io.stderr.write(
      "error: KindleFlow token is not configured. Mint one in the web UI and run `kindleflow login --token <token>`.\n"
    );
    deps.io.exit(EXIT_CODES.AUTH);
  }
  const factory = deps.makeClient ?? createClient;
  return factory({ baseUrl: resolved.url!, token: resolved.token! });
}

function reportError(io: CliIO, err: unknown): number {
  if (err instanceof KindleflowError) {
    io.stderr.write(`error (${err.code.toLowerCase()}): ${err.message}\n`);
    return err.exitCode;
  }
  if (err instanceof Error) {
    io.stderr.write(`error: ${err.message}\n`);
    return EXIT_CODES.UNKNOWN;
  }
  io.stderr.write(`error: unknown failure\n`);
  return EXIT_CODES.UNKNOWN;
}

// Wraps an async unit of work so any thrown KindleflowError becomes a synthesized exit code.
// Anything else (including the io.exit sentinel) is re-thrown so the caller can surface it.
async function safeRun<T>(io: CliIO, work: () => Promise<T>): Promise<T | { __error: number }> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("__exit__:")) {
      throw err;
    }
    return { __error: reportError(io, err) };
  }
}

function isError(value: unknown): value is { __error: number } {
  return Boolean(value && typeof value === "object" && "__error" in (value as object));
}

export async function runSend(
  deps: CliDeps,
  flags: CommonFlags & { url: string; noSend?: boolean; title?: string; positional: string }
): Promise<void> {
  const client = await safeRun(deps.io, () => getClient(deps, flags));
  if (isError(client)) deps.io.exit(client.__error);
  const sendMode: SendMode = flags.noSend ? "none" : "auto";
  const result = await safeRun(deps.io, () =>
    (client as KindleflowClient).sendArticle(flags.positional, { title: flags.title, sendMode })
  );
  if (isError(result)) deps.io.exit(result.__error);
  const sendResult = result as SendArticleResult;
  deps.io.stdout.write(formatSendResult(sendResult) + "\n");
  deps.io.exit(sendResult.delivery?.status === "failed" ? EXIT_CODES.DELIVERY : EXIT_CODES.SUCCESS);
}

function formatSendResult(result: SendArticleResult): string {
  const parts: string[] = [];
  if (result.deduped) {
    parts.push(`already in library: ${result.title}`);
  } else {
    parts.push(`imported: ${result.title}`);
  }
  parts.push(`kind=${result.kind}`);
  if (result.filename) parts.push(`file=${result.filename}`);
  if (result.pdfVerdict) parts.push(`pdf-verdict=${result.pdfVerdict}`);
  if (result.delivery) {
    parts.push(`delivery=${result.delivery.status}`);
    if (result.delivery.error) parts.push(`delivery-error=${result.delivery.error}`);
  } else {
    parts.push("delivery=none");
  }
  return parts.join(" | ");
}

export async function runSendBatch(
  deps: CliDeps,
  flags: CommonFlags & { urls: string[]; noSend?: boolean }
): Promise<void> {
  const client = await safeRun(deps.io, () => getClient(deps, flags));
  if (isError(client)) deps.io.exit(client.__error);
  const sendMode: SendMode = flags.noSend ? "none" : "auto";
  let worstExit = EXIT_CODES.SUCCESS;
  const summary = { total: 0, sent: 0, deduped: 0, failed: 0 };

  const outcome = await safeRun(deps.io, async () => {
    for await (const ev of (client as KindleflowClient).sendBatch(flags.urls, { sendMode })) {
      if (ev.type === "start") {
        summary.total = ev.total;
        continue;
      }
      if (ev.type === "done") {
        summary.sent = ev.sent;
        summary.deduped = ev.deduped;
        summary.failed = ev.failed;
        continue;
      }
      if (ev.ok) {
        const label = ev.deduped ? "SKIP" : ev.result.delivery?.status === "sent" ? "SENT" : "OK";
        deps.io.stdout.write(`${ev.url}\t${label}\t${ev.result.title}\n`);
      } else {
        worstExit = pickWorseExit(worstExit, EXIT_CODES[ev.error.code]);
        deps.io.stdout.write(`${ev.url}\tERR\t${ev.error.code}: ${ev.error.message}\n`);
      }
    }
    return null;
  });
  if (isError(outcome)) deps.io.exit(outcome.__error);

  deps.io.stdout.write(`\n${JSON.stringify(summary)}\n`);
  if (summary.failed > 0 && worstExit === EXIT_CODES.SUCCESS) {
    worstExit = EXIT_CODES.UNKNOWN;
  }
  deps.io.exit(worstExit);
}

function pickWorseExit(a: number, b: number): number {
  // Priority: AUTH (2) > IMPORT (3) > DELIVERY (4) > NETWORK (5) > UNKNOWN (1)
  const priority = (code: number): number => {
    if (code === EXIT_CODES.AUTH) return 5;
    if (code === EXIT_CODES.IMPORT) return 4;
    if (code === EXIT_CODES.DELIVERY) return 3;
    if (code === EXIT_CODES.NETWORK) return 2;
    if (code === EXIT_CODES.UNKNOWN) return 1;
    return 0;
  };
  return priority(b) > priority(a) ? b : a;
}

export async function runLatest(
  deps: CliDeps,
  flags: CommonFlags & { limit?: number }
): Promise<void> {
  const client = await safeRun(deps.io, () => getClient(deps, flags));
  if (isError(client)) deps.io.exit(client.__error);
  const items = await safeRun(deps.io, () => (client as KindleflowClient).listRecent(flags.limit ?? 25));
  if (isError(items)) deps.io.exit(items.__error);
  const list = items as RecentItem[];
  const isTty = Boolean((deps.io.stdout as { isTTY?: boolean }).isTTY);
  if (isTty) {
    deps.io.stdout.write(formatRecentTable(list) + "\n");
  } else {
    deps.io.stdout.write(JSON.stringify(list, null, 2) + "\n");
  }
  deps.io.exit(EXIT_CODES.SUCCESS);
}

function formatRecentTable(items: RecentItem[]): string {
  if (items.length === 0) return "(no recent items)";
  const rows = items.map((item) => {
    const delivery = item.latestDelivery ? item.latestDelivery.status : "—";
    return [truncate(item.title, 50), delivery, item.createdAt.slice(0, 19), item.filename];
  });
  rows.unshift(["TITLE", "DELIVERY", "CREATED", "FILE"]);
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows
    .map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  "))
    .join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export async function runRetry(
  deps: CliDeps,
  flags: CommonFlags & { deliveryId: string }
): Promise<void> {
  const client = await safeRun(deps.io, () => getClient(deps, flags));
  if (isError(client)) deps.io.exit(client.__error);
  const row = await safeRun(deps.io, () => (client as KindleflowClient).retryDelivery(flags.deliveryId));
  if (isError(row)) deps.io.exit(row.__error);
  const r = row as { status: string; attempts: number };
  deps.io.stdout.write(`retry ${flags.deliveryId}: status=${r.status} attempts=${r.attempts}\n`);
  deps.io.exit(r.status === "sent" ? EXIT_CODES.SUCCESS : EXIT_CODES.DELIVERY);
}

export async function runStatus(deps: CliDeps, flags: CommonFlags): Promise<void> {
  const client = await safeRun(deps.io, () => getClient(deps, flags));
  if (isError(client)) deps.io.exit(client.__error);
  const s = await safeRun(deps.io, () => (client as KindleflowClient).status());
  if (isError(s)) deps.io.exit(s.__error);
  const status = s as Awaited<ReturnType<KindleflowClient["status"]>>;
  const lines = [
    `reachable: ${status.reachable}`,
    `auth-ok: ${status.authOk}`,
    `smtp-configured: ${status.smtpConfigured}`,
    `kindle-email: ${status.kindleEmail ?? "(not set)"}`,
    `user: ${status.user?.email ?? "(unknown)"}`
  ];
  if (status.recent.length > 0) {
    lines.push("recent:");
    for (const item of status.recent.slice(0, 5)) {
      lines.push(`  - ${item.title} [${item.latestDelivery?.status ?? "—"}]`);
    }
  }
  deps.io.stdout.write(lines.join("\n") + "\n");
  if (!status.reachable) deps.io.exit(EXIT_CODES.NETWORK);
  if (!status.authOk) deps.io.exit(EXIT_CODES.AUTH);
  deps.io.exit(EXIT_CODES.SUCCESS);
}

export async function runLogin(
  deps: CliDeps,
  flags: { url?: string; token: string }
): Promise<void> {
  if (!flags.token) {
    deps.io.stderr.write("error: --token is required. Mint one in the web UI under Settings → API tokens.\n");
    deps.io.exit(EXIT_CODES.AUTH);
  }
  const url = flags.url ?? deps.io.env.KINDLEFLOW_URL;
  if (!url) {
    deps.io.stderr.write("error: --url or KINDLEFLOW_URL is required.\n");
    deps.io.exit(EXIT_CODES.AUTH);
  }
  const factory = deps.makeClient ?? createClient;
  const client = factory({ baseUrl: url!, token: flags.token });
  const s = await safeRun(deps.io, () => client.status());
  if (isError(s)) deps.io.exit(s.__error);
  const status = s as Awaited<ReturnType<KindleflowClient["status"]>>;
  if (!status.reachable) {
    deps.io.stderr.write(`error: could not reach ${url}\n`);
    deps.io.exit(EXIT_CODES.NETWORK);
  }
  if (!status.authOk) {
    deps.io.stderr.write("error: token rejected by server\n");
    deps.io.exit(EXIT_CODES.AUTH);
  }
  const configPath = deps.configPath ?? defaultConfigPath();
  const wrote = await safeRun(deps.io, () =>
    writeConfigFile(configPath, { url: url!.replace(/\/$/, ""), token: flags.token })
  );
  if (isError(wrote)) deps.io.exit(wrote.__error);
  deps.io.stdout.write(`logged in as ${status.user?.email ?? "(unknown)"} — config saved to ${configPath}\n`);
  deps.io.exit(EXIT_CODES.SUCCESS);
}

export async function runSendFile(
  deps: CliDeps,
  flags: CommonFlags & { positional: string; title?: string }
): Promise<void> {
  const { stat } = await import("node:fs/promises");
  const { extname } = await import("node:path");

  // Preflight checks
  let fileStat;
  try {
    fileStat = await stat(flags.positional);
  } catch (err) {
    deps.io.stderr.write(
      `error: file does not exist: ${flags.positional}\n`
    );
    deps.io.exit(EXIT_CODES.IMPORT);
  }

  if (fileStat.isDirectory()) {
    deps.io.stderr.write(
      `error: path is a directory, not a file: ${flags.positional}\n`
    );
    deps.io.exit(EXIT_CODES.IMPORT);
  }

  const ext = extname(flags.positional).toLowerCase();
  if (ext !== ".pdf" && ext !== ".epub") {
    deps.io.stderr.write(
      `error: unsupported file type. Only PDF and EPUB files are supported.\n`
    );
    deps.io.exit(EXIT_CODES.IMPORT);
  }

  const maxSize = 50 * 1024 * 1024; // 50MB
  if (fileStat.size > maxSize) {
    deps.io.stderr.write(
      `error: file size (${Math.round(fileStat.size / 1024 / 1024)}MB) exceeds 50MB limit\n`
    );
    deps.io.exit(EXIT_CODES.IMPORT);
  }

  const client = await safeRun(deps.io, () => getClient(deps, flags));
  if (isError(client)) deps.io.exit(client.__error);

  const result = await safeRun(deps.io, () =>
    (client as KindleflowClient).sendFile(flags.positional, { title: flags.title })
  );
  if (isError(result)) deps.io.exit(result.__error);

  const sendResult = result as SendArticleResult;
  deps.io.stdout.write(formatUploadResult(sendResult) + "\n");
  deps.io.exit(sendResult.delivery?.status === "failed" ? EXIT_CODES.DELIVERY : EXIT_CODES.SUCCESS);
}

function formatUploadResult(result: SendArticleResult): string {
  const parts: string[] = [];
  parts.push(`uploaded: ${result.title}`);
  parts.push(`kind=${result.kind}`);
  if (result.filename) parts.push(`file=${result.filename}`);
  if (result.delivery) {
    parts.push(`delivery=${result.delivery.status}`);
    if (result.delivery.error) parts.push(`delivery-error=${result.delivery.error}`);
  } else {
    parts.push("delivery=none");
  }
  return parts.join(" | ");
}

export type BatchEventForTests = BatchEvent;
