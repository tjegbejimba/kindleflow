import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface UserProfile {
  id: string;
  email: string;
  verified: boolean;
  kindleEmail?: string;
  autoSendToKindle: boolean;
  subscriptionRetentionDays: number;
}

export interface SubscriptionRecord {
  id: string;
  userId: string;
  feedUrl: string;
  sourceUrl: string;
  title: string;
  status: "active" | "paused";
  lastCheckedAt?: string;
}

export interface SubscriptionInput {
  feedUrl: string;
  sourceUrl: string;
  title: string;
}

export interface SubscriptionWithUser extends SubscriptionRecord {
  userEmail: string;
  kindleEmail?: string;
  autoSendToKindle: boolean;
  subscriptionRetentionDays: number;
}

const MAGIC_TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class AuthStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createLoginToken(emailInput: string, inviteCode: string | undefined, expectedInviteCode: string | undefined): string {
    const email = normalizeEmail(emailInput);
    let user = this.findUserByEmail(email);

    if (!user) {
      if (inviteCode !== "__already_invited__" && (!expectedInviteCode || inviteCode !== expectedInviteCode)) {
        throw new Error("A valid invite code is required for new users.");
      }

      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO users (id, email, auto_send_to_kindle, created_at) VALUES (?, ?, 1, datetime('now'))"
        )
        .run(id, email);
      user = { id };
    }

    const token = randomToken();
    this.db
      .prepare(
        "INSERT INTO magic_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      )
      .run(randomUUID(), user.id, hashToken(token), Date.now() + MAGIC_TOKEN_TTL_MS);

    return token;
  }

  consumeMagicToken(token: string): string {
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT id, user_id AS userId
         FROM magic_tokens
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
      )
      .get(hashToken(token), now) as { id: string; userId: string } | undefined;

    if (!row) {
      throw new Error("This login link is invalid or expired.");
    }

    this.db.prepare("UPDATE magic_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
    this.db.prepare("UPDATE users SET verified_at = COALESCE(verified_at, datetime('now')) WHERE id = ?").run(row.userId);

    const sessionToken = randomToken();
    this.db
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(randomUUID(), row.userId, hashToken(sessionToken), now + SESSION_TTL_MS);

    return sessionToken;
  }

  userExists(emailInput: string): boolean {
    return Boolean(this.findUserByEmail(normalizeEmail(emailInput)));
  }

  getUserBySession(sessionToken: string | undefined): UserProfile | null {
    if (!sessionToken) {
      return null;
    }

    const row = this.db
      .prepare(
        `SELECT users.id, users.email, users.verified_at AS verifiedAt, users.kindle_email AS kindleEmail,
                users.auto_send_to_kindle AS autoSendToKindle,
                users.subscription_retention_days AS subscriptionRetentionDays
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
      )
      .get(hashToken(sessionToken), Date.now()) as
      | {
          id: string;
          email: string;
          verifiedAt?: string;
          kindleEmail?: string;
          autoSendToKindle: number;
          subscriptionRetentionDays: number;
        }
      | undefined;

    return row ? toUserProfile(row) : null;
  }

  destroySession(sessionToken: string | undefined): void {
    if (!sessionToken) {
      return;
    }
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(sessionToken));
  }

  updateUserProfile(
    userId: string,
    profile: { kindleEmail?: string | null; autoSendToKindle?: boolean; subscriptionRetentionDays?: number }
  ): UserProfile {
    if (profile.kindleEmail !== undefined) {
      this.db
        .prepare("UPDATE users SET kindle_email = ?, updated_at = datetime('now') WHERE id = ?")
        .run(normalizeOptionalEmail(profile.kindleEmail), userId);
    }

    if (profile.autoSendToKindle !== undefined) {
      this.db
        .prepare("UPDATE users SET auto_send_to_kindle = ?, updated_at = datetime('now') WHERE id = ?")
        .run(profile.autoSendToKindle ? 1 : 0, userId);
    }

    if (profile.subscriptionRetentionDays !== undefined) {
      this.db
        .prepare("UPDATE users SET subscription_retention_days = ?, updated_at = datetime('now') WHERE id = ?")
        .run(clampRetentionDays(profile.subscriptionRetentionDays), userId);
    }

    const user = this.getUserById(userId);
    if (!user) {
      throw new Error("User not found.");
    }
    return user;
  }

  getUserById(userId: string): UserProfile | null {
    const row = this.db
      .prepare(
        `SELECT id, email, verified_at AS verifiedAt, kindle_email AS kindleEmail,
                auto_send_to_kindle AS autoSendToKindle,
                subscription_retention_days AS subscriptionRetentionDays
         FROM users WHERE id = ?`
      )
      .get(userId) as
      | {
          id: string;
          email: string;
          verifiedAt?: string;
          kindleEmail?: string;
          autoSendToKindle: number;
          subscriptionRetentionDays: number;
        }
      | undefined;
    return row ? toUserProfile(row) : null;
  }

  addSubscription(userId: string, input: SubscriptionInput): SubscriptionRecord {
    const existing = this.db
      .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND feed_url = ?")
      .get(userId, input.feedUrl) as DbSubscription | undefined;

    if (existing) {
      return toSubscription(existing);
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO subscriptions (id, user_id, feed_url, source_url, title, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))`
      )
      .run(id, userId, input.feedUrl, input.sourceUrl, input.title);

    return this.getSubscription(id)!;
  }

  listSubscriptions(userId: string): SubscriptionRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC")
        .all(userId) as unknown as DbSubscription[]
    ).map(toSubscription);
  }

  listActiveSubscriptionsWithUsers(): SubscriptionWithUser[] {
    return (
      this.db
        .prepare(
          `SELECT subscriptions.*, users.email AS user_email, users.kindle_email AS kindle_email,
                  users.auto_send_to_kindle AS auto_send_to_kindle,
                  users.subscription_retention_days AS subscription_retention_days
           FROM subscriptions
           JOIN users ON users.id = subscriptions.user_id
           WHERE subscriptions.status = 'active'`
        )
        .all() as unknown as (DbSubscription & {
          user_email: string;
          kindle_email?: string;
          auto_send_to_kindle: number;
          subscription_retention_days: number;
        })[]
    ).map((row) => ({
      ...toSubscription(row),
      userEmail: row.user_email,
      kindleEmail: row.kindle_email || undefined,
      autoSendToKindle: row.auto_send_to_kindle === 1,
      subscriptionRetentionDays: row.subscription_retention_days
    }));
  }

  markSubscriptionChecked(subscriptionId: string): void {
    this.db.prepare("UPDATE subscriptions SET last_checked_at = datetime('now') WHERE id = ?").run(subscriptionId);
  }

  hasDeliveredPost(subscriptionId: string, postUrl: string, postGuid?: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM delivered_posts
         WHERE subscription_id = ? AND (post_url = ? OR (? IS NOT NULL AND post_guid = ?))
         LIMIT 1`
      )
      .get(subscriptionId, postUrl, postGuid ?? null, postGuid ?? null);
    return Boolean(row);
  }

  markPostDelivered(subscriptionId: string, post: { url: string; guid?: string; title: string; filename?: string }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO delivered_posts (id, subscription_id, post_url, post_guid, title, filename, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(randomUUID(), subscriptionId, post.url, post.guid ?? null, post.title, post.filename ?? null);
  }

  pruneDeliveredPostsForUser(userId: string): string[] {
    const user = this.getUserById(userId);
    if (!user) {
      throw new Error("User not found.");
    }

    const rows = this.db
      .prepare(
        `SELECT delivered_posts.id, delivered_posts.filename
         FROM delivered_posts
         JOIN subscriptions ON subscriptions.id = delivered_posts.subscription_id
         WHERE subscriptions.user_id = ?
           AND delivered_posts.delivered_at < datetime('now', ?)`
      )
      .all(userId, `-${user.subscriptionRetentionDays} days`) as unknown as { id: string; filename?: string }[];

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM delivered_posts WHERE id IN (${placeholders})`).run(...ids);

    return rows.map((row) => row.filename).filter((filename): filename is string => Boolean(filename));
  }

  setDeliveredPostAgeForTest(postUrl: string, ageDays: number): void {
    this.db
      .prepare("UPDATE delivered_posts SET delivered_at = datetime('now', ?) WHERE post_url = ?")
      .run(`-${ageDays} days`, postUrl);
  }

  private getSubscription(id: string): SubscriptionRecord | null {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as DbSubscription | undefined;
    return row ? toSubscription(row) : null;
  }

  private findUserByEmail(email: string): { id: string } | null {
    const row = this.db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
    return row ?? null;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        verified_at TEXT,
        kindle_email TEXT,
        auto_send_to_kindle INTEGER NOT NULL DEFAULT 1,
        subscription_retention_days INTEGER NOT NULL DEFAULT 30,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS magic_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        feed_url TEXT NOT NULL,
        source_url TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, feed_url)
      );

      CREATE TABLE IF NOT EXISTS delivered_posts (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        post_url TEXT NOT NULL,
        post_guid TEXT,
        title TEXT NOT NULL,
        filename TEXT,
        delivered_at TEXT NOT NULL,
        UNIQUE(subscription_id, post_url)
      );
    `);
    this.addColumnIfMissing("users", "subscription_retention_days", "INTEGER NOT NULL DEFAULT 30");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!columns.some((existing) => existing.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

interface DbSubscription {
  id: string;
  user_id: string;
  feed_url: string;
  source_url: string;
  title: string;
  status: "active" | "paused";
  last_checked_at?: string;
}

function randomToken(): string {
  return randomBytes(36).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Please enter a valid email address.");
  }
  return normalized;
}

function normalizeOptionalEmail(email: string | null): string | null {
  if (!email) {
    return null;
  }
  return normalizeEmail(email);
}

function toUserProfile(row: {
  id: string;
  email: string;
  verifiedAt?: string;
  kindleEmail?: string;
  autoSendToKindle: number;
  subscriptionRetentionDays: number;
}): UserProfile {
  return {
    id: row.id,
    email: row.email,
    verified: Boolean(row.verifiedAt),
    kindleEmail: row.kindleEmail || undefined,
    autoSendToKindle: row.autoSendToKindle === 1,
    subscriptionRetentionDays: row.subscriptionRetentionDays
  };
}

function clampRetentionDays(value: number): number {
  if (!Number.isInteger(value)) {
    throw new Error("Subscription retention must be a whole number of days.");
  }
  return Math.min(Math.max(value, 1), 365);
}

function toSubscription(row: DbSubscription): SubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    feedUrl: row.feed_url,
    sourceUrl: row.source_url,
    title: row.title,
    status: row.status,
    lastCheckedAt: row.last_checked_at || undefined
  };
}
