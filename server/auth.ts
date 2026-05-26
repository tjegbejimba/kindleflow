import type { FastifyRequest } from "fastify";
import { API_TOKEN_PREFIX, type AuthStore, type UserProfile } from "./authStore.js";

export interface AuthHelpers {
  getCurrentUser(request: FastifyRequest): UserProfile | null;
  requireUser(request: FastifyRequest): UserProfile;
  /**
   * Browser-only auth: header in production, dev-bypass user locally.
   * Never accepts a bearer PAT (used to gate /api/tokens endpoints).
   */
  requireBrowserUser(request: FastifyRequest): UserProfile;
}

export interface HeaderTrustOptions {
  emailHeader?: string;
  displayNameHeader?: string;
  proxySecretHeader?: string;
  trustedProxySecret?: string;
  devBypass?: {
    active: boolean;
    email: string;
  };
}

const DEFAULT_EMAIL_HEADER = "x-auth-request-email";
const DEFAULT_DISPLAY_NAME_HEADER = "x-auth-request-user";
const DEFAULT_PROXY_SECRET_HEADER = "x-auth-request-proxy-secret";

export function extractBearerToken(authorization: unknown): string | null {
  if (typeof authorization !== "string") return null;
  const match = authorization.match(/^Bearer\s+(\S+)$/);
  if (!match) return null;
  const token = match[1];
  return token.startsWith(API_TOKEN_PREFIX) ? token : null;
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return null; // duplicate headers — reject
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function createAuthHelpers(store: AuthStore, options: HeaderTrustOptions = {}): AuthHelpers {
  const emailHeader = (options.emailHeader ?? DEFAULT_EMAIL_HEADER).toLowerCase();
  const displayNameHeader = (options.displayNameHeader ?? DEFAULT_DISPLAY_NAME_HEADER).toLowerCase();
  const proxySecretHeader = (options.proxySecretHeader ?? DEFAULT_PROXY_SECRET_HEADER).toLowerCase();
  const trustedProxySecret = options.trustedProxySecret;
  const devBypass = options.devBypass;

  function resolveHeaderUser(request: FastifyRequest): UserProfile | null {
    const email = headerValue(request, emailHeader);
    if (!email) return null;

    if (trustedProxySecret) {
      const presented = headerValue(request, proxySecretHeader);
      if (presented !== trustedProxySecret) {
        return null;
      }
    }

    const displayName = headerValue(request, displayNameHeader);
    try {
      return store.getOrCreateUserByEmail(email, displayName);
    } catch {
      // Malformed email or other validation error — treat as unauthenticated.
      return null;
    }
  }

  function resolveDevBypassUser(): UserProfile | null {
    if (!devBypass?.active) return null;
    try {
      return store.getOrCreateUserByEmail(devBypass.email);
    } catch {
      return null;
    }
  }

  function resolveBearerUser(request: FastifyRequest): UserProfile | null {
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

  function getCurrentUser(request: FastifyRequest): UserProfile | null {
    return resolveBearerUser(request) ?? resolveHeaderUser(request) ?? resolveDevBypassUser();
  }

  function requireUser(request: FastifyRequest): UserProfile {
    const user = getCurrentUser(request);
    if (!user) {
      const error = new Error("Authentication required.");
      Object.assign(error, { statusCode: 401 });
      throw error;
    }
    return user;
  }

  function requireBrowserUser(request: FastifyRequest): UserProfile {
    const user = resolveHeaderUser(request) ?? resolveDevBypassUser();
    if (!user) {
      const error = new Error("This endpoint requires a browser session.");
      Object.assign(error, { statusCode: 401 });
      throw error;
    }
    return user;
  }

  return { getCurrentUser, requireUser, requireBrowserUser };
}
