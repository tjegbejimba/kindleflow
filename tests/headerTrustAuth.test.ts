import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthHelpers, type HeaderTrustOptions } from "../server/auth.js";
import { AuthStore } from "../server/authStore.js";
import { loadConfig, isAuthDevBypassActive } from "../server/config.js";

const EMAIL_HEADER = "x-auth-request-email";
const USER_HEADER = "x-auth-request-user";
const PROXY_SECRET_HEADER = "x-auth-request-proxy-secret";

let tempDir: string;
let store: AuthStore;
let app: FastifyInstance;

async function buildApp(options: HeaderTrustOptions = {}): Promise<FastifyInstance> {
  const instance = Fastify();
  const auth = createAuthHelpers(store, options);
  instance.get("/api/me", async (request) => ({ user: auth.getCurrentUser(request) }));
  instance.get("/api/protected", async (request) => auth.requireUser(request));
  instance.get("/api/browser", async (request) => auth.requireBrowserUser(request));
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-header-trust-"));
  store = new AuthStore(path.join(tempDir, "db.sqlite"));
});

afterEach(async () => {
  if (app) await app.close();
  store.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("header-trust auth", () => {
  it("resolves an existing user from the email header", async () => {
    const existing = store.getOrCreateUserByEmail("tj@example.com");
    app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "tj@example.com" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(existing.id);
  });

  it("JIT-creates a user from an unknown email header", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "newcomer@example.com" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe("newcomer@example.com");

    // Second call returns same user row, no duplicate.
    const again = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "newcomer@example.com" }
    });
    expect(again.json().id).toBe(res.json().id);
  });

  it("populates display name from the user header on JIT create", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "alice@example.com", [USER_HEADER]: "Alice" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Alice");
  });

  it("returns 401 on protected endpoints when no header is present", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/protected" });
    expect(res.statusCode).toBe(401);
  });

  it("returns { user: null } from /api/me when no header is present", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null });
  });

  it("rejects a blank or whitespace-only email header", async () => {
    app = await buildApp();
    const blank = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "" }
    });
    expect(blank.statusCode).toBe(401);

    const spaces = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "    " }
    });
    expect(spaces.statusCode).toBe(401);
  });

  it("rejects a malformed email header", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "not-an-email" }
    });
    expect(res.statusCode).toBe(401);
  });

  it("uses the dev bypass user when no header is present", async () => {
    app = await buildApp({ devBypass: { active: true, email: "dev@kindleflow.local" } });
    const res = await app.inject({ method: "GET", url: "/api/protected" });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe("dev@kindleflow.local");
  });

  it("dev bypass does not override a real header", async () => {
    app = await buildApp({ devBypass: { active: true, email: "dev@kindleflow.local" } });
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "real@example.com" }
    });
    expect(res.json().email).toBe("real@example.com");
  });

  it("accepts a bearer PAT in addition to header auth", async () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const pat = store.createApiToken(user.id, "cli").token;
    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { authorization: `Bearer ${pat}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(user.id);
  });

  it("requireBrowserUser rejects bearer-only requests", async () => {
    const user = store.getOrCreateUserByEmail("tj@example.com");
    const pat = store.createApiToken(user.id, "cli").token;
    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/browser",
      headers: { authorization: `Bearer ${pat}` }
    });
    expect(res.statusCode).toBe(401);
  });

  it("requireBrowserUser accepts header auth", async () => {
    store.getOrCreateUserByEmail("tj@example.com");
    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/browser",
      headers: { [EMAIL_HEADER]: "tj@example.com" }
    });
    expect(res.statusCode).toBe(200);
  });

  it("trusted-proxy secret is required when configured", async () => {
    app = await buildApp({ trustedProxySecret: "super-secret" });

    const noSecret = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "tj@example.com" }
    });
    expect(noSecret.statusCode).toBe(401);

    const wrongSecret = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "tj@example.com", [PROXY_SECRET_HEADER]: "wrong" }
    });
    expect(wrongSecret.statusCode).toBe(401);

    const okSecret = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { [EMAIL_HEADER]: "tj@example.com", [PROXY_SECRET_HEADER]: "super-secret" }
    });
    expect(okSecret.statusCode).toBe(200);
  });
});

describe("loadConfig auth-mode validation", () => {
  it("refuses to start when AUTH_DEV_BYPASS=true and NODE_ENV=production", () => {
    expect(() =>
      loadConfig({
        AUTH_DEV_BYPASS: "true",
        NODE_ENV: "production"
      } as NodeJS.ProcessEnv)
    ).toThrow(/production/i);
  });

  it("isAuthDevBypassActive requires NODE_ENV in {development, test}", () => {
    const baseEnv: NodeJS.ProcessEnv = { AUTH_DEV_BYPASS: "true" };

    expect(
      isAuthDevBypassActive(loadConfig({ ...baseEnv, NODE_ENV: "development" }), {
        NODE_ENV: "development"
      } as NodeJS.ProcessEnv)
    ).toBe(true);

    expect(
      isAuthDevBypassActive(loadConfig({ ...baseEnv, NODE_ENV: "test" }), {
        NODE_ENV: "test"
      } as NodeJS.ProcessEnv)
    ).toBe(true);

    // Unset NODE_ENV → bypass NOT active
    expect(isAuthDevBypassActive(loadConfig(baseEnv), {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("defaults the dev email to dev@kindleflow.local", () => {
    const config = loadConfig({
      AUTH_DEV_BYPASS: "true",
      NODE_ENV: "development"
    } as NodeJS.ProcessEnv);
    expect(config.authDevEmail).toBe("dev@kindleflow.local");
  });

  it("accepts a custom AUTH_DEV_EMAIL", () => {
    const config = loadConfig({
      AUTH_DEV_BYPASS: "true",
      AUTH_DEV_EMAIL: "tj@kindleflow.local",
      NODE_ENV: "development"
    } as NodeJS.ProcessEnv);
    expect(config.authDevEmail).toBe("tj@kindleflow.local");
  });

  it("rejects a malformed AUTH_DEV_EMAIL when bypass is active", () => {
    expect(() =>
      loadConfig({
        AUTH_DEV_BYPASS: "true",
        AUTH_DEV_EMAIL: "not-an-email",
        NODE_ENV: "development"
      } as NodeJS.ProcessEnv)
    ).toThrow();
  });
});
