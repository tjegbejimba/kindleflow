import path from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  inviteCodesFile: string;
  appBaseUrl: string;
  inviteCode?: string;
  cookieSecure: boolean;
  sessionTtlDays: number;
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
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 3000),
    dataDir: path.resolve(env.DATA_DIR ?? "data"),
    dbPath: path.resolve(env.DB_PATH ?? path.join(env.DATA_DIR ?? "data", "kindleflow.sqlite")),
    inviteCodesFile: path.resolve(env.INVITE_CODES_FILE ?? path.join(env.DATA_DIR ?? "data", "invite-codes.txt")),
    appBaseUrl: (env.APP_BASE_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ""),
    inviteCode: env.INVITE_CODE,
    cookieSecure: env.COOKIE_SECURE === "true",
    sessionTtlDays: parsePositiveInteger(env.SESSION_TTL_DAYS, 180),
    smtp
  };
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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
