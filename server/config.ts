import path from "node:path";
import { parseAdditionalCookieHosts, type SubstackAuthConfig } from "./substackAuth.js";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  appBaseUrl: string;
  authDevBypass: boolean;
  authDevEmail: string;
  trustedProxySecret?: string;
  substackAuth?: SubstackAuthConfig;
  smtp?: SmtpConfig;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const smtp = loadSmtpConfig(env);
  const authDevBypass = env.AUTH_DEV_BYPASS === "true";
  const nodeEnv = env.NODE_ENV;

  if (authDevBypass && nodeEnv === "production") {
    throw new Error(
      "AUTH_DEV_BYPASS=true is not allowed when NODE_ENV=production. " +
        "Unset AUTH_DEV_BYPASS or run in development/test."
    );
  }

  const authDevEmail = (env.AUTH_DEV_EMAIL ?? "dev@kindleflow.local").trim();
  if (authDevBypass && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authDevEmail)) {
    throw new Error("AUTH_DEV_EMAIL must be a valid email when AUTH_DEV_BYPASS=true.");
  }

  const trustedProxySecret = env.AUTH_TRUSTED_PROXY_SECRET?.trim() || undefined;

  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 3000),
    dataDir: path.resolve(env.DATA_DIR ?? "data"),
    dbPath: path.resolve(env.DB_PATH ?? path.join(env.DATA_DIR ?? "data", "kindleflow.sqlite")),
    appBaseUrl: (env.APP_BASE_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ""),
    authDevBypass,
    authDevEmail,
    trustedProxySecret,
    substackAuth: loadSubstackAuthConfig(env),
    smtp
  };
}

export function isAuthDevBypassActive(config: AppConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!config.authDevBypass) return false;
  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}

export function isEmailDeliveryEnabled(config: AppConfig): boolean {
  return Boolean(config.smtp);
}

function loadSmtpConfig(env: NodeJS.ProcessEnv): SmtpConfig | undefined {
  const host = env.SMTP_HOST;
  const from = env.SMTP_FROM;

  if (!host || !from) {
    return undefined;
  }

  return {
    host,
    port: Number(env.SMTP_PORT ?? 587),
    secure: env.SMTP_SECURE === "true",
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from
  };
}

function loadSubstackAuthConfig(env: NodeJS.ProcessEnv): SubstackAuthConfig | undefined {
  const cookie = env.SUBSTACK_COOKIE?.trim();
  if (!cookie) {
    return undefined;
  }

  return {
    cookie,
    additionalCookieHosts: parseAdditionalCookieHosts(env.SUBSTACK_COOKIE_HOSTS)
  };
}
