import type { FastifyInstance } from "fastify";
import type { AuthHelpers } from "./auth.js";
import type { AuthStore } from "./authStore.js";

export function registerApiTokenRoutes(app: FastifyInstance, store: AuthStore, auth: AuthHelpers): void {
  app.post("/api/tokens", async (request) => {
    const user = auth.requireBrowserUser(request);
    const body = (request.body ?? {}) as { name?: unknown };
    if (typeof body.name !== "string") {
      const error = new Error("Token name is required.");
      Object.assign(error, { statusCode: 400 });
      throw error;
    }
    try {
      const created = store.createApiToken(user.id, body.name);
      return { token: created };
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to create token.");
      Object.assign(error, { statusCode: 400 });
      throw error;
    }
  });

  app.get("/api/tokens", async (request) => {
    const user = auth.requireBrowserUser(request);
    return { tokens: store.listApiTokens(user.id) };
  });

  app.delete("/api/tokens/:tokenId", async (request) => {
    const user = auth.requireBrowserUser(request);
    const { tokenId } = request.params as { tokenId: string };
    const revoked = store.revokeApiToken(user.id, tokenId);
    if (!revoked) {
      const error = new Error("Token not found.");
      Object.assign(error, { statusCode: 404 });
      throw error;
    }
    return { revoked: true };
  });
}
