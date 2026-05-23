import type { FastifyRequest } from "fastify";
import { API_TOKEN_PREFIX, type AuthStore, type UserProfile } from "./authStore.js";

export interface AuthHelpers {
  sessionCookie: string;
  getCurrentUser(request: FastifyRequest): UserProfile | null;
  requireUser(request: FastifyRequest): UserProfile;
  requireUserCookieOnly(request: FastifyRequest): UserProfile;
}

export function extractBearerToken(authorization: unknown): string | null {
  if (typeof authorization !== "string") return null;
  const match = authorization.match(/^Bearer\s+(\S+)$/);
  if (!match) return null;
  const token = match[1];
  return token.startsWith(API_TOKEN_PREFIX) ? token : null;
}

export function createAuthHelpers(store: AuthStore, sessionCookie: string): AuthHelpers {
  function getCurrentUser(request: FastifyRequest): UserProfile | null {
    const cookieUser = store.getUserBySession(request.cookies?.[sessionCookie]);
    if (cookieUser) return cookieUser;

    const token = extractBearerToken(request.headers["authorization"]);
    if (!token) return null;
    const tokenUser = store.getUserByApiToken(token);
    if (tokenUser) {
      try {
        store.touchApiToken(token);
      } catch {
        // best-effort; never fail the request on touch
      }
    }
    return tokenUser;
  }

  function requireUser(request: FastifyRequest): UserProfile {
    const user = getCurrentUser(request);
    if (!user) {
      const error = new Error("Please sign in to continue.");
      Object.assign(error, { statusCode: 401 });
      throw error;
    }
    return user;
  }

  function requireUserCookieOnly(request: FastifyRequest): UserProfile {
    const user = store.getUserBySession(request.cookies?.[sessionCookie]);
    if (!user) {
      const error = new Error("This endpoint requires a browser session.");
      Object.assign(error, { statusCode: 401 });
      throw error;
    }
    return user;
  }

  return { sessionCookie, getCurrentUser, requireUser, requireUserCookieOnly };
}
