import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore } from "../server/authStore.js";
import type { SmtpConfig } from "../server/config.js";
import { deliverToKindles, requireKindleTargets, summarizeDeliveries } from "../server/kindleDelivery.js";

const smtp = { host: "smtp.test", port: 587, secure: false, from: "kf@test" } as unknown as SmtpConfig;

let tempDir: string;
let store: AuthStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-delivery-"));
  store = new AuthStore(path.join(tempDir, "db.sqlite"));
});

afterEach(async () => {
  store.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("requireKindleTargets", () => {
  it("rejects when SMTP is missing or the user has no Kindles", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    expect(() => requireKindleTargets({ store, smtp: undefined, userId: user.id })).toThrow(/not configured/);
    expect(() => requireKindleTargets({ store, smtp, userId: user.id })).toThrow(
      "Add your Kindle email address before sending files."
    );
  });

  it("returns default devices or the selected ones", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com", sendByDefault: false });

    expect(requireKindleTargets({ store, smtp, userId: user.id }).map((d) => d.name)).toEqual(["Paperwhite"]);
    expect(requireKindleTargets({ store, smtp, userId: user.id, selectors: ["Scribe"] }).map((d) => d.name)).toEqual([
      "Scribe"
    ]);
  });
});

describe("deliverToKindles", () => {
  it("sends to each target with a shared batch id and records partial failures", async () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const send = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m1", response: "250 ok" })
      .mockRejectedValueOnce(new Error("SMTP down"));
    const log = { warn: vi.fn() };

    const deliveries = await deliverToKindles({
      store,
      smtp,
      dataDir: tempDir,
      log,
      send,
      userId: user.id,
      targets: ["pw@kindle.com", "scribe@kindle.com"],
      file: { title: "Doc", filename: "doc.epub", displayFilename: "Doc.epub" },
      trigger: "manual"
    });

    expect(send).toHaveBeenNthCalledWith(1, smtp, tempDir, "doc.epub", "pw@kindle.com", "Doc.epub");
    expect(send).toHaveBeenNthCalledWith(2, smtp, tempDir, "doc.epub", "scribe@kindle.com", "Doc.epub");
    expect(deliveries.map((d) => [d.kindleEmail, d.status])).toEqual([
      ["pw@kindle.com", "sent"],
      ["scribe@kindle.com", "failed"]
    ]);
    expect(deliveries[0].batchId).toBeTruthy();
    expect(deliveries[1].batchId).toBe(deliveries[0].batchId);
    expect(deliveries[1].error).toBe("SMTP down");
    expect(log.warn).toHaveBeenCalledTimes(1);

    expect(summarizeDeliveries(deliveries)).toEqual({ total: 2, sent: 1, failed: 1, allSent: false, anySent: true });
  });
});
