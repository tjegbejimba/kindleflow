import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runLatest,
  runLogin,
  runRetry,
  runSend,
  runSendBatch,
  runSendFile,
  runStatus,
  type CliDeps,
  type CliIO
} from "../cli/commands.js";
import {
  EXIT_CODES,
  KindleflowError,
  type BatchEvent,
  type KindleflowClient,
  type RecentItem,
  type SendArticleResult
} from "../shared/kindleflowClient.js";
import { loadCliConfig, writeConfigFile, configFileMode } from "../cli/config.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-cli-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

type ExitSignal = { code: number };

function makeIO(env: NodeJS.ProcessEnv = {}, isTty = false): {
  io: CliIO;
  out: string[];
  err: string[];
  exited: ExitSignal | null;
} {
  const out: string[] = [];
  const err: string[] = [];
  const state = { exited: null as ExitSignal | null };
  const io: CliIO = {
    stdout: {
      write(chunk: string) {
        out.push(chunk);
        return true;
      },
      isTTY: isTty
    },
    stderr: {
      write(chunk: string) {
        err.push(chunk);
        return true;
      }
    },
    exit(code: number): never {
      state.exited = { code };
      throw new Error(`__exit__:${code}`);
    },
    env
  };
  return {
    io,
    out,
    err,
    get exited() {
      return state.exited;
    }
  } as any;
}

async function runWithExit(fn: () => Promise<void>): Promise<number | null> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("__exit__:")) {
      return Number(err.message.split(":")[1]);
    }
    throw err;
  }
  return null;
}

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

const articleSent: SendArticleResult = {
  kind: "article",
  libraryItemId: "li1",
  filename: "f.epub",
  mimeType: "application/epub+zip",
  sourceUrl: "https://ex/a",
  title: "A",
  deduped: false,
  delivery: { id: "d1", status: "sent" }
};

const articleDelivered = articleSent;
const articleFailed: SendArticleResult = {
  ...articleSent,
  delivery: { id: "d1", status: "failed", error: "smtp" }
};

describe("CLI commands", () => {
  describe("send", () => {
    it("exits 0 and prints the imported title on success", async () => {
      const client = makeClient({ sendArticle: vi.fn().mockResolvedValue(articleSent) });
      const { io, out } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSend(deps, { positional: "https://ex/a", url: "", token: "" })
      );
      expect(code).toBe(0);
      expect(out.join("")).toContain("imported: A");
      expect(out.join("")).toContain("delivery=sent");
    });

    it("--no-send passes sendMode=none to the client", async () => {
      const send = vi.fn().mockResolvedValue({
        ...articleSent,
        delivery: null
      } satisfies SendArticleResult);
      const client = makeClient({ sendArticle: send });
      const { io } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      await runWithExit(() =>
        runSend(deps, { positional: "https://ex/a", noSend: true, url: "", token: "" })
      );
      expect(send).toHaveBeenCalledWith("https://ex/a", { sendMode: "none", title: undefined });
    });

    it("exits 2 on AUTH failure", async () => {
      const client = makeClient({
        sendArticle: vi.fn().mockRejectedValue(new KindleflowError("AUTH", "bad token", 401))
      });
      const { io, err } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSend(deps, { positional: "https://ex/a", url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.AUTH);
      expect(err.join("")).toMatch(/auth/i);
    });

    it("exits 3 on IMPORT failure", async () => {
      const client = makeClient({
        sendArticle: vi.fn().mockRejectedValue(new KindleflowError("IMPORT", "fetch failed", 422))
      });
      const { io } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSend(deps, { positional: "https://ex/a", url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.IMPORT);
    });

    it("exits 4 when the server reports a failed delivery", async () => {
      const client = makeClient({ sendArticle: vi.fn().mockResolvedValue(articleFailed) });
      const { io } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSend(deps, { positional: "https://ex/a", url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.DELIVERY);
    });

    it("exits 2 when no token is configured", async () => {
      const client = makeClient();
      const { io } = makeIO({});
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSend(deps, { positional: "https://ex/a", url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.AUTH);
    });
  });

  describe("send-batch", () => {
    it("line-streams progress, prints JSON summary, exits 0 when all OK", async () => {
      const events: BatchEvent[] = [
        { type: "start", total: 2 },
        { type: "item", index: 0, url: "https://ex/a", ok: true, deduped: false, result: articleDelivered },
        { type: "item", index: 1, url: "https://ex/b", ok: true, deduped: true, result: { ...articleDelivered, deduped: true } },
        { type: "done", total: 2, sent: 1, deduped: 1, failed: 0 }
      ];
      const client = makeClient({
        sendBatch: () =>
          (async function* () {
            for (const ev of events) yield ev;
          })()
      });
      const { io, out } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSendBatch(deps, { urls: ["https://ex/a", "https://ex/b"], url: "", token: "" })
      );
      expect(code).toBe(0);
      const text = out.join("");
      expect(text).toContain("https://ex/a\tSENT\t");
      expect(text).toContain("https://ex/b\tSKIP\t");
      expect(text).toContain('"sent":1');
      expect(text).toContain('"deduped":1');
    });

    it("exits with AUTH (2) when any item is AUTH", async () => {
      const events: BatchEvent[] = [
        { type: "start", total: 2 },
        { type: "item", index: 0, url: "https://ex/a", ok: false, error: { code: "AUTH", message: "bad token" } },
        { type: "item", index: 1, url: "https://ex/b", ok: false, error: { code: "IMPORT", message: "fail" } },
        { type: "done", total: 2, sent: 0, deduped: 0, failed: 2 }
      ];
      const client = makeClient({
        sendBatch: () =>
          (async function* () {
            for (const ev of events) yield ev;
          })()
      });
      const { io } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSendBatch(deps, { urls: ["https://ex/a", "https://ex/b"], url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.AUTH);
    });
  });

  describe("latest", () => {
    const items: RecentItem[] = [
      {
        id: "li1",
        title: "First",
        filename: "first.epub",
        mimeType: "application/epub+zip",
        sourceUrl: "https://ex/1",
        createdAt: "2026-05-23T10:00:00Z",
        latestDelivery: { id: "d1", status: "sent", updatedAt: "2026-05-23T10:01:00Z" }
      }
    ];

    it("prints a table when stdout is a TTY", async () => {
      const client = makeClient({ listRecent: vi.fn().mockResolvedValue(items) });
      const { io, out } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" }, true);
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      await runWithExit(() => runLatest(deps, { url: "", token: "" }));
      const text = out.join("");
      expect(text).toContain("TITLE");
      expect(text).toContain("First");
      // Should not be JSON.
      expect(() => JSON.parse(text)).toThrow();
    });

    it("prints JSON when piped", async () => {
      const client = makeClient({ listRecent: vi.fn().mockResolvedValue(items) });
      const { io, out } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" }, false);
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      await runWithExit(() => runLatest(deps, { url: "", token: "" }));
      const parsed = JSON.parse(out.join(""));
      expect(parsed[0].title).toBe("First");
    });
  });

  describe("retry", () => {
    it("exits 0 when delivery is sent", async () => {
      const client = makeClient({
        retryDelivery: vi.fn().mockResolvedValue({
          id: "d1",
          title: "T",
          filename: "f",
          status: "sent",
          attempts: 2,
          updatedAt: "x"
        })
      });
      const { io } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runRetry(deps, { deliveryId: "d1", url: "", token: "" })
      );
      expect(code).toBe(0);
    });

    it("exits 4 when retry still fails", async () => {
      const client = makeClient({
        retryDelivery: vi.fn().mockResolvedValue({
          id: "d1",
          title: "T",
          filename: "f",
          status: "failed",
          error: "smtp",
          attempts: 2,
          updatedAt: "x"
        })
      });
      const { io } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runRetry(deps, { deliveryId: "d1", url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.DELIVERY);
    });
  });

  describe("status", () => {
    it("exits 5 (NETWORK) when not reachable", async () => {
      const client = makeClient({
        status: vi.fn().mockResolvedValue({
          reachable: false,
          authOk: false,
          smtpConfigured: false,
          recent: []
        })
      });
      const { io } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() => runStatus(deps, { url: "", token: "" }));
      expect(code).toBe(EXIT_CODES.NETWORK);
    });
  });

  describe("login", () => {
    it("verifies the token, writes a 0600 config file, and exits 0", async () => {
      const configPath = path.join(tempDir, "config.yaml");
      const client = makeClient({
        status: vi.fn().mockResolvedValue({
          reachable: true,
          authOk: true,
          smtpConfigured: true,
          user: { email: "tj@example.com" },
          recent: []
        })
      });
      const { io } = makeIO({});
      const deps: CliDeps = { io, makeClient: () => client, configPath };
      const code = await runWithExit(() =>
        runLogin(deps, { url: "http://t", token: "kf_pat_abc" })
      );
      expect(code).toBe(0);
      expect(await readFile(configPath, "utf8")).toContain("kf_pat_abc");
      expect(await configFileMode(configPath)).toBe(0o600);
    });

    it("refuses to write config when status() rejects", async () => {
      const configPath = path.join(tempDir, "config.yaml");
      const client = makeClient({
        status: vi.fn().mockRejectedValue(new KindleflowError("AUTH", "bad token", 401))
      });
      const { io } = makeIO({});
      const deps: CliDeps = { io, makeClient: () => client, configPath };
      const code = await runWithExit(() =>
        runLogin(deps, { url: "http://t", token: "kf_pat_bad" })
      );
      expect(code).toBe(EXIT_CODES.AUTH);
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("send-file", () => {
    const uploadedPdf: SendArticleResult = {
      kind: "pdf",
      libraryItemId: "li1",
      filename: "upload-xyz.pdf",
      mimeType: "application/pdf",
      sourceUrl: "",
      title: "My Document",
      deduped: false,
      delivery: { id: "d1", status: "sent" }
    };

    it("uploads a local PDF and prints the result", async () => {
      const pdfPath = path.join(tempDir, "test.pdf");
      await writeFile(pdfPath, Buffer.from("%PDF-1.4\nfake pdf"));
      const send = vi.fn().mockResolvedValue(uploadedPdf);
      const client = makeClient({ sendFile: send } as any);
      const { io, out } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSendFile(deps, { positional: pdfPath, url: "", token: "" })
      );
      expect(code).toBe(0);
      expect(send).toHaveBeenCalledWith(pdfPath, { title: undefined });
      const text = out.join("");
      expect(text).toContain("uploaded: My Document");
      expect(text).toContain("kind=pdf");
      expect(text).toContain("file=upload-xyz.pdf");
      expect(text).toContain("delivery=sent");
    });

    it("passes --title to the client", async () => {
      const pdfPath = path.join(tempDir, "test.pdf");
      await writeFile(pdfPath, Buffer.from("%PDF-1.4\nfake pdf"));
      const send = vi.fn().mockResolvedValue({ ...uploadedPdf, title: "Custom Title" });
      const client = makeClient({ sendFile: send } as any);
      const { io, out } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSendFile(deps, { positional: pdfPath, title: "Custom Title", url: "", token: "" })
      );
      expect(code).toBe(0);
      expect(send).toHaveBeenCalledWith(pdfPath, { title: "Custom Title" });
      expect(out.join("")).toContain("Custom Title");
    });

    it("exits 3 when the local file does not exist", async () => {
      const client = makeClient({ sendFile: vi.fn() } as any);
      const { io, err } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSendFile(deps, { positional: "/nonexistent/file.pdf", url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.IMPORT);
      expect(err.join("")).toMatch(/does not exist|not found/i);
    });

    it("exits 3 when the path is a directory", async () => {
      const client = makeClient({ sendFile: vi.fn() } as any);
      const { io, err } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSendFile(deps, { positional: tempDir, url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.IMPORT);
      expect(err.join("")).toMatch(/is a directory|not a file/i);
    });

    it("exits 3 when the file extension is unsupported", async () => {
      const txtPath = path.join(tempDir, "doc.txt");
      await writeFile(txtPath, "plain text");
      const client = makeClient({ sendFile: vi.fn() } as any);
      const { io, err } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSendFile(deps, { positional: txtPath, url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.IMPORT);
      expect(err.join("")).toMatch(/unsupported|only pdf and epub/i);
    });

    it("exits 3 when the file is over 50MB", async () => {
      const bigPath = path.join(tempDir, "big.pdf");
      await writeFile(bigPath, Buffer.alloc(51 * 1024 * 1024));
      const client = makeClient({ sendFile: vi.fn() } as any);
      const { io, err } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSendFile(deps, { positional: bigPath, url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.IMPORT);
      expect(err.join("")).toMatch(/50.*mb|too large|size limit/i);
    });

    it("exits 4 when delivery fails", async () => {
      const pdfPath = path.join(tempDir, "test.pdf");
      await writeFile(pdfPath, Buffer.from("%PDF-1.4\nfake pdf"));
      const client = makeClient({
        sendFile: vi.fn().mockResolvedValue({
          ...uploadedPdf,
          delivery: { id: "d1", status: "failed", error: "smtp timeout" }
        })
      } as any);
      const { io } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSendFile(deps, { positional: pdfPath, url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.DELIVERY);
    });

    it("exits 3 when server validation fails", async () => {
      const pdfPath = path.join(tempDir, "test.pdf");
      await writeFile(pdfPath, Buffer.from("%PDF-1.4\nfake pdf"));
      const client = makeClient({
        sendFile: vi.fn().mockRejectedValue(new KindleflowError("IMPORT", "Invalid file", 422))
      } as any);
      const { io, err } = makeIO({ KINDLEFLOW_URL: "http://t", KINDLEFLOW_TOKEN: "kf_pat_x" });
      const deps: CliDeps = { io, makeClient: () => client, configPath: path.join(tempDir, "config.yaml") };
      const code = await runWithExit(() =>
        runSendFile(deps, { positional: pdfPath, url: "", token: "" })
      );
      expect(code).toBe(EXIT_CODES.IMPORT);
      expect(err.join("")).toContain("Invalid file");
    });
  });
});

describe("CLI config", () => {
  it("flag overrides env, env overrides file", async () => {
    const cfgPath = path.join(tempDir, "config.yaml");
    await writeConfigFile(cfgPath, { url: "http://from-file", token: "tok-file" });
    expect(
      await loadCliConfig({ env: { KINDLEFLOW_URL: "http://from-env" }, configPath: cfgPath })
    ).toMatchObject({ url: "http://from-env", token: "tok-file" });
    expect(
      await loadCliConfig({
        flagUrl: "http://from-flag",
        env: { KINDLEFLOW_URL: "http://from-env" },
        configPath: cfgPath
      })
    ).toMatchObject({ url: "http://from-flag" });
  });

  it("writeConfigFile uses 0600 permissions", async () => {
    const cfgPath = path.join(tempDir, "config.yaml");
    await writeConfigFile(cfgPath, { url: "http://x", token: "tok" });
    const mode = (await stat(cfgPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("loadCliConfig returns empty when file is missing", async () => {
    expect(await loadCliConfig({ configPath: path.join(tempDir, "missing.yaml"), env: {} })).toEqual({
      url: undefined,
      token: undefined
    });
  });
});
