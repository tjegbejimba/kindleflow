import type { FastifyInstance } from "fastify";
import type { AuthHelpers } from "./auth.js";
import type { AuthStore } from "./authStore.js";

export function registerLibraryRecentRoute(app: FastifyInstance, store: AuthStore, auth: AuthHelpers): void {
  app.get("/api/library/recent", async (request) => {
    const user = auth.requireUser(request);
    const query = (request.query ?? {}) as { limit?: unknown };
    const limit = parseLimit(query.limit, 25);
    const items = store.listRecentLibraryItemsWithDelivery(user.id, limit);
    return { items };
  });
}

function parseLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 200) {
    return parsed;
  }
  return fallback;
}
