import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerApiTokenRoutes } from "../server/apiTokenRoutes.js";
import { createAuthHelpers } from "../server/auth.js";
import { AuthStore } from "../server/authStore.js";

const EMAIL_HEADER = "x-auth-request-email";

let tempDir: string;
let store: AuthStore;
let app: FastifyInstance;

async function seedUser(email: string): Promise<{ userId: string }> {
  const user = store.getOrCreateUserByEmail(email);
  return { userId: user.id };
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-tokens-"));
  store = new AuthStore(path.join(tempDir, "db.sqlite"));
  app = Fastify();
  const auth = createAuthHelpers(store);
  registerApiTokenRoutes(app, store, auth);

  // A test-only echo endpoint for the bearer-auth path.
  app.get("/test/me", async (request) => auth.requireUser(request));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  store.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("API token routes", () => {
  it("mints, lists, and revokes tokens for the header-authenticated user", async () => {
    const { userId } = await seedUser("tj@example.com");
    const headers = { [EMAIL_HEADER]: "tj@example.com", "content-type": "application/json" };

    const create = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers,
      payload: { name: "Laptop CLI" }
    });
    expect(create.statusCode).toBe(200);
    const created = create.json().token as { id: string; name: string; token: string };
    expect(created.name).toBe("Laptop CLI");
    expect(created.token).toMatch(/^kf_pat_/);

    const list = await app.inject({ method: "GET", url: "/api/tokens", headers: { [EMAIL_HEADER]: "tj@example.com" } });
    expect(list.statusCode).toBe(200);
    expect(list.json().tokens).toHaveLength(1);
    expect(list.json().tokens[0]).not.toHaveProperty("token");

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/tokens/${created.id}`,
      headers: { [EMAIL_HEADER]: "tj@example.com" }
    });
    expect(revoke.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/tokens", headers: { [EMAIL_HEADER]: "tj@example.com" } })).json()
        .tokens
    ).toHaveLength(0);

    const revokeAgain = await app.inject({
      method: "DELETE",
      url: `/api/tokens/${created.id}`,
      headers: { [EMAIL_HEADER]: "tj@example.com" }
    });
    expect(revokeAgain.statusCode).toBe(404);
    // Sanity: userId is the same person across calls.
    expect(userId).toBeTruthy();
  });

  it("requires a valid name", async () => {
    await seedUser("tj@example.com");
    const noName = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { [EMAIL_HEADER]: "tj@example.com", "content-type": "application/json" },
      payload: {}
    });
    expect(noName.statusCode).toBe(400);

    const blank = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { [EMAIL_HEADER]: "tj@example.com", "content-type": "application/json" },
      payload: { name: "   " }
    });
    expect(blank.statusCode).toBe(400);
  });

  it("requires browser (header) auth and rejects bearer tokens (carve-out)", async () => {
    const { userId } = await seedUser("tj@example.com");

    // Mint a PAT through the header-auth flow.
    const create = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { [EMAIL_HEADER]: "tj@example.com", "content-type": "application/json" },
      payload: { name: "Laptop CLI" }
    });
    const pat = create.json().token.token as string;

    // No auth at all → 401.
    const noAuth = await app.inject({ method: "GET", url: "/api/tokens" });
    expect(noAuth.statusCode).toBe(401);

    // Bearer-only → 401 because /api/tokens is browser-only.
    const bearerList = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: { authorization: `Bearer ${pat}` }
    });
    expect(bearerList.statusCode).toBe(401);

    const bearerCreate = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { authorization: `Bearer ${pat}`, "content-type": "application/json" },
      payload: { name: "Another" }
    });
    expect(bearerCreate.statusCode).toBe(401);

    const bearerDelete = await app.inject({
      method: "DELETE",
      url: `/api/tokens/${create.json().token.id}`,
      headers: { authorization: `Bearer ${pat}` }
    });
    expect(bearerDelete.statusCode).toBe(401);

    // Bearer token DOES work on regular bearer-allowed endpoint (sanity).
    const meBearer = await app.inject({
      method: "GET",
      url: "/test/me",
      headers: { authorization: `Bearer ${pat}` }
    });
    expect(meBearer.statusCode).toBe(200);
    expect(meBearer.json().id).toBe(userId);
  });

  it("rejects a revoked token on the next bearer request", async () => {
    await seedUser("tj@example.com");
    const create = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { [EMAIL_HEADER]: "tj@example.com", "content-type": "application/json" },
      payload: { name: "Temp" }
    });
    const tokenId = create.json().token.id as string;
    const pat = create.json().token.token as string;

    const before = await app.inject({
      method: "GET",
      url: "/test/me",
      headers: { authorization: `Bearer ${pat}` }
    });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: "DELETE",
      url: `/api/tokens/${tokenId}`,
      headers: { [EMAIL_HEADER]: "tj@example.com" }
    });

    const after = await app.inject({
      method: "GET",
      url: "/test/me",
      headers: { authorization: `Bearer ${pat}` }
    });
    expect(after.statusCode).toBe(401);
  });

  it("ignores bearer tokens with the wrong prefix", async () => {
    const after = await app.inject({
      method: "GET",
      url: "/test/me",
      headers: { authorization: "Bearer sk-something-else" }
    });
    expect(after.statusCode).toBe(401);
  });

  it("prefers a valid bearer over a missing header, and a valid header is enough on its own", async () => {
    const { userId } = await seedUser("tj@example.com");
    const pat = store.createApiToken(userId, "cli").token;

    const bearerRes = await app.inject({
      method: "GET",
      url: "/test/me",
      headers: { authorization: `Bearer ${pat}` }
    });
    expect(bearerRes.statusCode).toBe(200);
    expect(bearerRes.json().id).toBe(userId);

    const headerRes = await app.inject({
      method: "GET",
      url: "/test/me",
      headers: { [EMAIL_HEADER]: "tj@example.com" }
    });
    expect(headerRes.statusCode).toBe(200);
    expect(headerRes.json().id).toBe(userId);
  });
});
