import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
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

export interface LibraryItem {
  id: string;
  userId: string;
  type: "article" | "subscription_post";
  subscriptionId?: string;
  title: string;
  sourceUrl?: string;
  filename: string;
  mimeType: LibraryItemMimeType;
  createdAt: string;
}

export type LibraryItemMimeType = "application/epub+zip" | "application/pdf";

export interface LibraryItemInput {
  type: "article" | "subscription_post";
  subscriptionId?: string;
  title: string;
  sourceUrl?: string;
  filename: string;
  mimeType: LibraryItemMimeType;
}

export interface TemporaryFile {
  id: string;
  userId: string;
  sourceLibraryItemId: string;
  filename: string;
  mimeType: LibraryItemMimeType;
  createdAt: string;
  expiresAt: string;
}

export interface TemporaryFileInput {
  userId: string;
  sourceLibraryItemId: string;
  filename: string;
  mimeType: LibraryItemMimeType;
  retentionHours: number;
}

export interface KindleDelivery {
  id: string;
  userId: string;
  libraryItemId?: string;
  title: string;
  filename: string;
  kindleEmail: string;
  trigger: "auto" | "manual" | "subscription" | "test" | "retry";
  status: "pending" | "sent" | "failed";
  attempts: number;
  messageId?: string;
  response?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KindleDeliveryInput {
  libraryItemId?: string;
  title: string;
  filename: string;
  kindleEmail: string;
  trigger: KindleDelivery["trigger"];
}

export interface LibrarySubscription {
  id: string;
  title: string;
  itemCount: number;
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

const LOGIN_CODE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export class AuthStore {
  private readonly db: DatabaseSync;
  private readonly sessionTtlMs: number;

  constructor(dbPath: string, options: { sessionTtlMs?: number } = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createLoginCode(emailInput: string, inviteCode: string | undefined, expectedInviteCode: string | undefined): string {
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

    this.db.prepare("UPDATE login_codes SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(user.id);

    const code = randomLoginCode();
    this.db
      .prepare(
        "INSERT INTO login_codes (id, user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      )
      .run(randomUUID(), user.id, hashLoginCode(user.id, code), Date.now() + LOGIN_CODE_TTL_MS);

    return code;
  }

  consumeLoginCode(emailInput: string, codeInput: string): string {
    const email = normalizeEmail(emailInput);
    const code = normalizeLoginCode(codeInput);
    const user = this.findUserByEmail(email);
    if (!user) {
      throw new Error("This login code is invalid or expired.");
    }

    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT id, user_id AS userId
         FROM login_codes
         WHERE user_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?`
      )
      .get(user.id, hashLoginCode(user.id, code), now) as { id: string; userId: string } | undefined;

    if (!row) {
      throw new Error("This login code is invalid or expired.");
    }

    this.db.prepare("UPDATE login_codes SET used_at = datetime('now') WHERE id = ?").run(row.id);
    this.db.prepare("UPDATE users SET verified_at = COALESCE(verified_at, datetime('now')) WHERE id = ?").run(row.userId);

    const sessionToken = randomToken();
    this.db
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(randomUUID(), row.userId, hashToken(sessionToken), now + this.sessionTtlMs);

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

  refreshSession(sessionToken: string | undefined): void {
    if (!sessionToken) {
      return;
    }
    this.db
      .prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ?")
      .run(Date.now() + this.sessionTtlMs, hashToken(sessionToken), Date.now());
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

  ensureOpdsToken(userId: string): string {
    const row = this.db.prepare("SELECT opds_token AS opdsToken FROM users WHERE id = ?").get(userId) as
      | { opdsToken?: string }
      | undefined;
    if (!row) {
      throw new Error("User not found.");
    }

    return row.opdsToken || this.rotateOpdsToken(userId);
  }

  rotateOpdsToken(userId: string): string {
    const token = randomToken();
    this.db.prepare("UPDATE users SET opds_token = ?, updated_at = datetime('now') WHERE id = ?").run(token, userId);
    return token;
  }

  getUserByOpdsToken(token: string | undefined): UserProfile | null {
    if (!token) {
      return null;
    }

    const row = this.db
      .prepare(
        `SELECT id, email, verified_at AS verifiedAt, kindle_email AS kindleEmail,
                auto_send_to_kindle AS autoSendToKindle,
                subscription_retention_days AS subscriptionRetentionDays
         FROM users WHERE opds_token = ?`
      )
      .get(token) as
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

  addLibraryItem(userId: string, input: LibraryItemInput): LibraryItem {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO library_items
           (id, user_id, type, subscription_id, title, source_url, filename, mime_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        id,
        userId,
        input.type,
        input.subscriptionId ?? null,
        input.title,
        input.sourceUrl ?? null,
        input.filename,
        input.mimeType
      );

    return this.getLibraryItem(id)!;
  }

  getLatestLibraryItem(userId: string): LibraryItem | null {
    const row = this.db
      .prepare("SELECT * FROM library_items WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(userId) as DbLibraryItem | undefined;
    return row ? toLibraryItem(row) : null;
  }

  getLibraryItemForUserByFilename(userId: string, filename: string): LibraryItem | null {
    const row = this.db
      .prepare("SELECT * FROM library_items WHERE user_id = ? AND filename = ?")
      .get(userId, filename) as DbLibraryItem | undefined;
    return row ? toLibraryItem(row) : null;
  }

  listRecentLibraryItems(userId: string, limit = 50): LibraryItem[] {
    return (
      this.db
        .prepare("SELECT * FROM library_items WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(userId, limit) as unknown as DbLibraryItem[]
    ).map(toLibraryItem);
  }

  listLibraryItemsBySubscription(userId: string, subscriptionId: string, limit = 50): LibraryItem[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM library_items
           WHERE user_id = ? AND subscription_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`
        )
        .all(userId, subscriptionId, limit) as unknown as DbLibraryItem[]
    ).map(toLibraryItem);
  }

  listLibrarySubscriptions(userId: string): LibrarySubscription[] {
    return this.db
      .prepare(
        `SELECT subscriptions.id, subscriptions.title, COUNT(library_items.id) AS itemCount
         FROM subscriptions
         JOIN library_items ON library_items.subscription_id = subscriptions.id
         WHERE subscriptions.user_id = ?
         GROUP BY subscriptions.id, subscriptions.title
         ORDER BY subscriptions.title COLLATE NOCASE ASC`
      )
      .all(userId) as unknown as LibrarySubscription[];
  }

  addTemporaryFile(input: TemporaryFileInput): TemporaryFile {
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.retentionHours * 60 * 60 * 1000);
    
    this.db
      .prepare(
        `INSERT INTO temporary_files
           (id, user_id, source_library_item_id, filename, mime_type, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.userId,
        input.sourceLibraryItemId,
        input.filename,
        input.mimeType,
        now.toISOString(),
        expiresAt.toISOString()
      );
    
    return this.getTemporaryFile(id)!;
  }

  listTemporaryFiles(userId: string): TemporaryFile[] {
    return (
      this.db
        .prepare("SELECT * FROM temporary_files WHERE user_id = ? ORDER BY created_at DESC")
        .all(userId) as unknown as DbTemporaryFile[]
    ).map(toTemporaryFile);
  }

  listExpiredTemporaryFiles(): TemporaryFile[] {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare("SELECT * FROM temporary_files WHERE expires_at <= ?")
        .all(now) as unknown as DbTemporaryFile[]
    ).map(toTemporaryFile);
  }

  cleanupExpiredTemporaryFiles(): number {
    const now = new Date().toISOString();
    // Get expired files before deleting them
    const expiredFiles = (
      this.db
        .prepare("SELECT * FROM temporary_files WHERE expires_at <= ?")
        .all(now) as unknown as DbTemporaryFile[]
    ).map(toTemporaryFile);
    
    // Delete from database
    const result = this.db
      .prepare("DELETE FROM temporary_files WHERE expires_at <= ?")
      .run(now);
    
    return result.changes;
  }

  getTemporaryFileByFilename(userId: string, filename: string): TemporaryFile | null {
    const row = this.db
      .prepare("SELECT * FROM temporary_files WHERE user_id = ? AND filename = ?")
      .get(userId, filename) as DbTemporaryFile | undefined;
    return row ? toTemporaryFile(row) : null;
  }

  deleteTemporaryFile(userId: string, filename: string): boolean {
    const result = this.db
      .prepare("DELETE FROM temporary_files WHERE user_id = ? AND filename = ?")
      .run(userId, filename);
    return result.changes > 0;
  }

  getLibraryItem(id: string): LibraryItem | null {
    const row = this.db
      .prepare("SELECT * FROM library_items WHERE id = ?")
      .get(id) as DbLibraryItem | undefined;
    return row ? toLibraryItem(row) : null;
  }

  private getTemporaryFile(id: string): TemporaryFile | null {
    const row = this.db
      .prepare("SELECT * FROM temporary_files WHERE id = ?")
      .get(id) as DbTemporaryFile | undefined;
    return row ? toTemporaryFile(row) : null;
  }

  getLibraryItemForOpdsToken(token: string, filename: string): LibraryItem | null {
    const user = this.getUserByOpdsToken(token);
    if (!user) {
      return null;
    }

    const row = this.db
      .prepare("SELECT * FROM library_items WHERE user_id = ? AND filename = ?")
      .get(user.id, filename) as DbLibraryItem | undefined;
    return row ? toLibraryItem(row) : null;
  }

  createKindleDelivery(userId: string, input: KindleDeliveryInput): KindleDelivery {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO kindle_deliveries
           (id, user_id, library_item_id, title, filename, kindle_email, trigger, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))`
      )
      .run(
        id,
        userId,
        input.libraryItemId ?? null,
        input.title,
        input.filename,
        normalizeEmail(input.kindleEmail),
        input.trigger
      );
    return this.getKindleDeliveryForUser(userId, id)!;
  }

  recordKindleDeliveryResult(
    deliveryId: string,
    result: { status: "sent"; messageId?: string; response?: string } | { status: "failed"; error: string }
  ): KindleDelivery {
    if (result.status === "sent") {
      this.db
        .prepare(
          `UPDATE kindle_deliveries
           SET status = 'sent', attempts = attempts + 1, message_id = ?, response = ?, error = NULL, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(result.messageId ?? null, result.response ?? null, deliveryId);
    } else {
      this.db
        .prepare(
          `UPDATE kindle_deliveries
           SET status = 'failed', attempts = attempts + 1, error = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(result.error, deliveryId);
    }

    const delivery = this.getKindleDelivery(deliveryId);
    if (!delivery) {
      throw new Error("Delivery not found.");
    }
    return delivery;
  }

  listKindleDeliveries(userId: string, limit = 25): KindleDelivery[] {
    return (
      this.db
        .prepare("SELECT * FROM kindle_deliveries WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?")
        .all(userId, limit) as unknown as DbKindleDelivery[]
    ).map(toKindleDelivery);
  }

  getKindleDeliveryForUser(userId: string, deliveryId: string): KindleDelivery | null {
    const row = this.db
      .prepare("SELECT * FROM kindle_deliveries WHERE user_id = ? AND id = ?")
      .get(userId, deliveryId) as DbKindleDelivery | undefined;
    return row ? toKindleDelivery(row) : null;
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
    const filenames = rows.map((row) => row.filename).filter((filename): filename is string => Boolean(filename));
    if (filenames.length > 0) {
      const filenamePlaceholders = filenames.map(() => "?").join(", ");
      this.db
        .prepare(`DELETE FROM library_items WHERE user_id = ? AND filename IN (${filenamePlaceholders})`)
        .run(userId, ...filenames);
    }

    return filenames;
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

  private getLibraryItem(id: string): LibraryItem | null {
    const row = this.db.prepare("SELECT * FROM library_items WHERE id = ?").get(id) as DbLibraryItem | undefined;
    return row ? toLibraryItem(row) : null;
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
        opds_token TEXT UNIQUE,
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

      CREATE TABLE IF NOT EXISTS login_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS library_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        source_url TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, filename)
      );

      CREATE TABLE IF NOT EXISTS kindle_deliveries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        library_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        kindle_email TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        message_id TEXT,
        response TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS temporary_files (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing("users", "subscription_retention_days", "INTEGER NOT NULL DEFAULT 30");
    this.addColumnIfMissing("users", "opds_token", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_opds_token ON users(opds_token)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kindle_deliveries_user_updated ON kindle_deliveries(user_id, updated_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_temporary_files_expires_at ON temporary_files(expires_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_temporary_files_user_filename ON temporary_files(user_id, filename)");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!columns.some((existing) => existing.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private getKindleDelivery(deliveryId: string): KindleDelivery | null {
    const row = this.db.prepare("SELECT * FROM kindle_deliveries WHERE id = ?").get(deliveryId) as
      | DbKindleDelivery
      | undefined;
    return row ? toKindleDelivery(row) : null;
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

interface DbLibraryItem {
  id: string;
  user_id: string;
  type: "article" | "subscription_post";
  subscription_id?: string;
  title: string;
  source_url?: string;
  filename: string;
  mime_type: LibraryItemMimeType;
  created_at: string;
}

interface DbKindleDelivery {
  id: string;
  user_id: string;
  library_item_id?: string;
  title: string;
  filename: string;
  kindle_email: string;
  trigger: KindleDelivery["trigger"];
  status: KindleDelivery["status"];
  attempts: number;
  message_id?: string;
  response?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

interface DbTemporaryFile {
  id: string;
  user_id: string;
  source_library_item_id: string;
  filename: string;
  mime_type: LibraryItemMimeType;
  created_at: string;
  expires_at: string;
}

function randomToken(): string {
  return randomBytes(36).toString("base64url");
}

function randomLoginCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashLoginCode(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Please enter a valid email address.");
  }
  return normalized;
}

function normalizeLoginCode(code: string): string {
  const normalized = code.trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) {
    throw new Error("Enter the 6-digit login code from your email.");
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

function toLibraryItem(row: DbLibraryItem): LibraryItem {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    subscriptionId: row.subscription_id || undefined,
    title: row.title,
    sourceUrl: row.source_url || undefined,
    filename: row.filename,
    mimeType: row.mime_type,
    createdAt: row.created_at
  };
}

function toKindleDelivery(row: DbKindleDelivery): KindleDelivery {
  return {
    id: row.id,
    userId: row.user_id,
    libraryItemId: row.library_item_id || undefined,
    title: row.title,
    filename: row.filename,
    kindleEmail: row.kindle_email,
    trigger: row.trigger,
    status: row.status,
    attempts: row.attempts,
    messageId: row.message_id || undefined,
    response: row.response || undefined,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTemporaryFile(row: DbTemporaryFile): TemporaryFile {
  return {
    id: row.id,
    userId: row.user_id,
    sourceLibraryItemId: row.source_library_item_id,
    filename: row.filename,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}
