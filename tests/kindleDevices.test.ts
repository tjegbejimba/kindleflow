import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthHelpers } from "../server/auth.js";
import { AuthStore } from "../server/authStore.js";
import { registerKindleDeviceRoutes } from "../server/kindleDeviceRoutes.js";

let tempDir: string;
let dbPath: string;
let store: AuthStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-devices-"));
  dbPath = path.join(tempDir, "db.sqlite");
  store = new AuthStore(dbPath);
});

afterEach(async () => {
  store.close();
  await rm(tempDir, { recursive: true, force: true });
});

function legacySql(sql: string, ...params: (string | null)[]): void {
  store.close();
  const db = new DatabaseSync(dbPath);
  db.prepare(sql).run(...params);
  db.close();
  store = new AuthStore(dbPath);
}

describe("kindle devices store", () => {
  it("first device becomes primary and mirrors users.kindle_email", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const device = store.addKindleDevice(user.id, { name: "Paperwhite", email: "TJ_PW@kindle.com" });

    expect(device).toMatchObject({ name: "Paperwhite", email: "tj_pw@kindle.com", sendByDefault: true, isPrimary: true });
    expect(store.getUserById(user.id)?.kindleEmail).toBe("tj_pw@kindle.com");
  });

  it("adds more devices without changing the primary", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    const scribe = store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com", sendByDefault: false });

    expect(scribe).toMatchObject({ isPrimary: false, sendByDefault: false });
    expect(store.listKindleDevices(user.id).map((d) => d.name)).toEqual(["Paperwhite", "Scribe"]);
    expect(store.getUserById(user.id)?.kindleEmail).toBe("pw@kindle.com");
  });

  it("rejects duplicate emails and names (case-insensitive) with 400", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });

    expect(() => store.addKindleDevice(user.id, { name: "Other", email: "PW@kindle.com" })).toThrow(/already added/);
    expect(() => store.addKindleDevice(user.id, { name: "paperwhite", email: "x@kindle.com" })).toThrow(/name/);
    try {
      store.addKindleDevice(user.id, { name: "", email: "y@kindle.com" });
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it("allows the same email on different users", () => {
    const a = store.getOrCreateUserByEmail("a@example.com");
    const b = store.getOrCreateUserByEmail("b@example.com");
    store.addKindleDevice(a.id, { name: "Shared", email: "shared@kindle.com" });
    expect(() => store.addKindleDevice(b.id, { name: "Shared", email: "shared@kindle.com" })).not.toThrow();
  });

  it("caps devices per user", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    for (let i = 0; i < 10; i += 1) {
      store.addKindleDevice(user.id, { name: `K${i}`, email: `k${i}@kindle.com` });
    }
    expect(() => store.addKindleDevice(user.id, { name: "K10", email: "k10@kindle.com" })).toThrow(/up to 10/);
  });

  it("refuses to unset the last send-by-default device", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const pw = store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    const scribe = store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com", sendByDefault: false });

    expect(() => store.updateKindleDevice(user.id, pw.id, { sendByDefault: false })).toThrow(/At least one/);

    store.updateKindleDevice(user.id, scribe.id, { sendByDefault: true });
    expect(store.updateKindleDevice(user.id, pw.id, { sendByDefault: false }).sendByDefault).toBe(false);
  });

  it("updating the primary email updates the legacy mirror", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const pw = store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    store.updateKindleDevice(user.id, pw.id, { email: "new@kindle.com", name: "PW" });
    expect(store.getUserById(user.id)?.kindleEmail).toBe("new@kindle.com");
    expect(store.listKindleDevices(user.id)[0].name).toBe("PW");
  });

  it("deleting the primary promotes another device and keeps a default", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const pw = store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com", sendByDefault: false });

    store.deleteKindleDevice(user.id, pw.id);
    const [remaining] = store.listKindleDevices(user.id);
    expect(remaining).toMatchObject({ name: "Scribe", isPrimary: true, sendByDefault: true });
    expect(store.getUserById(user.id)?.kindleEmail).toBe("scribe@kindle.com");
  });

  it("deleting the last device clears the legacy mirror", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const pw = store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    expect(store.deleteKindleDevice(user.id, pw.id)).toBe(true);
    expect(store.getUserById(user.id)?.kindleEmail).toBeUndefined();
  });

  it("cannot touch another user's devices", () => {
    const a = store.getOrCreateUserByEmail("a@example.com");
    const b = store.getOrCreateUserByEmail("b@example.com");
    const device = store.addKindleDevice(a.id, { name: "A", email: "a@kindle.com" });
    expect(() => store.updateKindleDevice(b.id, device.id, { name: "Hijack" })).toThrow(/not found/);
    expect(store.deleteKindleDevice(b.id, device.id)).toBe(false);
  });
});

describe("legacy kindleEmail profile updates", () => {
  it("creates a primary device when none exist", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const updated = store.updateUserProfile(user.id, { kindleEmail: "pw@kindle.com" });
    expect(updated.kindleEmail).toBe("pw@kindle.com");
    expect(store.listKindleDevices(user.id)).toEqual([
      expect.objectContaining({ name: "Kindle", email: "pw@kindle.com", isPrimary: true, sendByDefault: true })
    ]);
  });

  it("changes the primary device email and returns it exactly", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com" });

    expect(store.updateUserProfile(user.id, { kindleEmail: "pw2@kindle.com" }).kindleEmail).toBe("pw2@kindle.com");
    expect(store.listKindleDevices(user.id).map((d) => d.email)).toEqual(["pw2@kindle.com", "scribe@kindle.com"]);
  });

  it("switches primary when the email already belongs to another device", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com", sendByDefault: false });

    expect(store.updateUserProfile(user.id, { kindleEmail: "scribe@kindle.com" }).kindleEmail).toBe("scribe@kindle.com");
    const scribe = store.listKindleDevices(user.id).find((d) => d.name === "Scribe");
    expect(scribe).toMatchObject({ isPrimary: true, sendByDefault: true });
    expect(store.listKindleDevices(user.id)).toHaveLength(2);
  });

  it("null clears every device", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com" });
    expect(store.updateUserProfile(user.id, { kindleEmail: null }).kindleEmail).toBeUndefined();
    expect(store.listKindleDevices(user.id)).toEqual([]);
  });
});

describe("startup migration and rollback reconciliation", () => {
  it("backfills a device for users that only have a legacy kindle_email", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    legacySql("UPDATE users SET kindle_email = ? WHERE id = ?", "legacy@kindle.com", user.id);

    expect(store.listKindleDevices(user.id)).toEqual([
      expect.objectContaining({ name: "Kindle", email: "legacy@kindle.com", isPrimary: true, sendByDefault: true })
    ]);
  });

  it("picks up a legacy image changing kindle_email after migration", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com" });

    legacySql("UPDATE users SET kindle_email = ? WHERE id = ?", "rolled@kindle.com", user.id);

    expect(store.getUserById(user.id)?.kindleEmail).toBe("rolled@kindle.com");
    expect(store.resolveKindleTargets(user.id).map((d) => d.email)).toEqual(["rolled@kindle.com", "scribe@kindle.com"]);
  });

  it("honours a legacy image clearing kindle_email", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    legacySql("UPDATE users SET kindle_email = NULL WHERE id = ?", user.id);
    expect(store.listKindleDevices(user.id)).toEqual([]);
  });

  it("is idempotent across restarts", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com" });
    store.close();
    store = new AuthStore(dbPath);
    store.close();
    store = new AuthStore(dbPath);
    expect(store.listKindleDevices(user.id)).toHaveLength(2);
  });
});

describe("resolveKindleTargets", () => {
  it("returns send-by-default devices when no selectors are given", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com", sendByDefault: false });
    store.addKindleDevice(user.id, { name: "Oasis", email: "oasis@kindle.com" });

    expect(store.resolveKindleTargets(user.id).map((d) => d.name)).toEqual(["Paperwhite", "Oasis"]);
    expect(store.resolveKindleTargets(user.id, []).map((d) => d.name)).toEqual(["Paperwhite", "Oasis"]);
  });

  it("matches id, email, or case-insensitive name and dedupes", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const pw = store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    store.addKindleDevice(user.id, { name: "Scribe", email: "scribe@kindle.com", sendByDefault: false });

    expect(store.resolveKindleTargets(user.id, ["scribe"]).map((d) => d.name)).toEqual(["Scribe"]);
    expect(
      store.resolveKindleTargets(user.id, [pw.id, "PW@kindle.com", "paperwhite", " Scribe "]).map((d) => d.name)
    ).toEqual(["Paperwhite", "Scribe"]);
  });

  it("rejects unknown selectors with 400", () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    store.addKindleDevice(user.id, { name: "Paperwhite", email: "pw@kindle.com" });
    try {
      store.resolveKindleTargets(user.id, ["Nope"]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/Unknown Kindle "Nope"/);
      expect((error as { statusCode?: number }).statusCode).toBe(400);
    }
  });
});

describe("listRecentLibraryItemsWithDelivery batch status", () => {
  function seed() {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const item = store.addLibraryItem(user.id, {
      type: "article",
      title: "Doc",
      filename: "doc.epub",
      mimeType: "application/epub+zip"
    });
    const make = (kindleEmail: string, batchId?: string) =>
      store.createKindleDelivery(user.id, {
        batchId,
        libraryItemId: item.id,
        title: "Doc",
        filename: "doc.epub",
        kindleEmail,
        trigger: "manual"
      });
    return { user, make };
  }

  it("reports failed when any Kindle in the latest batch failed", () => {
    const { user, make } = seed();
    const a = make("a@kindle.com", "batch-1");
    const b = make("b@kindle.com", "batch-1");
    store.recordKindleDeliveryResult(a.id, { status: "sent" });
    store.recordKindleDeliveryResult(b.id, { status: "failed", error: "x" });

    const [recent] = store.listRecentLibraryItemsWithDelivery(user.id);
    expect(recent.latestDelivery).toMatchObject({ status: "failed", sentCount: 1, totalCount: 2 });
  });

  it("reports pending while any Kindle is pending and sent when all sent", () => {
    const { user, make } = seed();
    const a = make("a@kindle.com", "batch-1");
    make("b@kindle.com", "batch-1");
    store.recordKindleDeliveryResult(a.id, { status: "sent" });
    expect(store.listRecentLibraryItemsWithDelivery(user.id)[0].latestDelivery?.status).toBe("pending");

    const c = make("a@kindle.com", "batch-2");
    store.recordKindleDeliveryResult(c.id, { status: "sent" });
    expect(store.listRecentLibraryItemsWithDelivery(user.id)[0].latestDelivery).toMatchObject({
      status: "sent",
      sentCount: 1,
      totalCount: 1
    });
  });

  it("treats legacy rows without a batch id individually", () => {
    const { user, make } = seed();
    const a = make("a@kindle.com");
    store.recordKindleDeliveryResult(a.id, { status: "failed", error: "x" });
    const b = make("a@kindle.com");
    store.recordKindleDeliveryResult(b.id, { status: "sent" });
    expect(store.listRecentLibraryItemsWithDelivery(user.id)[0].latestDelivery).toMatchObject({
      id: b.id,
      status: "sent",
      totalCount: 1
    });
  });
});

describe("kindle device routes", () => {
  let app: FastifyInstance;
  const headers = { "x-auth-request-email": "tj@example.com" };

  beforeEach(async () => {
    app = Fastify();
    registerKindleDeviceRoutes(app, store, createAuthHelpers(store));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("supports list, create, update, delete", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/kindles",
      headers,
      payload: { name: "Paperwhite", email: "pw@kindle.com" }
    });
    expect(created.statusCode).toBe(200);
    const device = created.json().device;
    expect(device).toMatchObject({ name: "Paperwhite", email: "pw@kindle.com", isPrimary: true });
    expect(device).not.toHaveProperty("userId");

    const second = await app.inject({
      method: "POST",
      url: "/api/kindles",
      headers,
      payload: { name: "Scribe", email: "scribe@kindle.com", sendByDefault: false }
    });
    expect(second.json().device.sendByDefault).toBe(false);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/kindles/${second.json().device.id}`,
      headers,
      payload: { sendByDefault: true, name: "Kindle Scribe" }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().device).toMatchObject({ name: "Kindle Scribe", sendByDefault: true });

    const list = await app.inject({ method: "GET", url: "/api/kindles", headers });
    expect(list.json().devices.map((d: { name: string }) => d.name)).toEqual(["Paperwhite", "Kindle Scribe"]);

    const removed = await app.inject({ method: "DELETE", url: `/api/kindles/${device.id}`, headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().devices).toHaveLength(1);

    const missing = await app.inject({ method: "DELETE", url: `/api/kindles/${device.id}`, headers });
    expect(missing.statusCode).toBe(404);
  });

  it("returns 400 for invalid input and 401 without auth", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/kindles", headers, payload: { name: "X", email: "nope" } });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({ method: "GET", url: "/api/kindles" });
    expect(anon.statusCode).toBe(401);
  });
});
