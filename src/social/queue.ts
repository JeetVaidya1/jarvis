/**
 * Social media post queue — draft, approve, and schedule posts.
 *
 * Posts go through: draft → approved → posted (or rejected).
 * The poster checks the queue periodically and publishes approved posts.
 */

import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createLogger } from "../logger.js";

const log = createLogger("social");

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "../..");
const DB_PATH = join(PROJECT_ROOT, "data", "social.db");

// ── Database ──

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const dataDir = join(PROJECT_ROOT, "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'x',
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      scheduled_at TEXT,
      posted_at TEXT,
      permalink TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_social_status ON social_queue(status);
  `);

  return db;
}

// ── Types ──

export type PostStatus = "draft" | "approved" | "posted" | "rejected";

export interface QueuedPost {
  readonly id: number;
  readonly platform: string;
  readonly content: string;
  readonly status: PostStatus;
  readonly scheduled_at: string | null;
  readonly posted_at: string | null;
  readonly permalink: string | null;
  readonly created_at: string;
}

// ── Public API ──

export function addToQueue(
  platform: string,
  content: string,
  scheduledAt?: string,
): number {
  const database = getDb();
  const stmt = database.prepare(
    "INSERT INTO social_queue (platform, content, scheduled_at) VALUES (?, ?, ?)",
  );
  const result = stmt.run(platform, content, scheduledAt ?? null);
  log.info(`Post queued [${platform}]: ${content.slice(0, 50)}...`);
  return result.lastInsertRowid as number;
}

export function getQueue(status?: PostStatus): QueuedPost[] {
  const database = getDb();
  if (status) {
    return database.prepare(
      "SELECT * FROM social_queue WHERE status = ? ORDER BY created_at DESC LIMIT 20",
    ).all(status) as QueuedPost[];
  }
  return database.prepare(
    "SELECT * FROM social_queue ORDER BY created_at DESC LIMIT 20",
  ).all() as QueuedPost[];
}

export function approvePost(id: number): boolean {
  const database = getDb();
  const result = database.prepare(
    "UPDATE social_queue SET status = 'approved', updated_at = datetime('now') WHERE id = ? AND status = 'draft'",
  ).run(id);
  if (result.changes > 0) {
    log.info(`Post ${id} approved`);
    return true;
  }
  return false;
}

export function rejectPost(id: number): boolean {
  const database = getDb();
  const result = database.prepare(
    "UPDATE social_queue SET status = 'rejected', updated_at = datetime('now') WHERE id = ? AND status = 'draft'",
  ).run(id);
  return result.changes > 0;
}

export function markPosted(id: number, permalink: string): void {
  const database = getDb();
  database.prepare(
    "UPDATE social_queue SET status = 'posted', posted_at = datetime('now'), permalink = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(permalink, id);
  log.info(`Post ${id} published: ${permalink}`);
}

export function getApprovedPosts(): QueuedPost[] {
  const database = getDb();
  return database.prepare(
    "SELECT * FROM social_queue WHERE status = 'approved' AND (scheduled_at IS NULL OR scheduled_at <= datetime('now')) ORDER BY created_at ASC",
  ).all() as QueuedPost[];
}

export function formatQueue(posts: readonly QueuedPost[]): string {
  if (posts.length === 0) return "No posts in queue.";

  return posts.map((p) => {
    const statusIcon = p.status === "draft" ? "📝" : p.status === "approved" ? "✅" : p.status === "posted" ? "📤" : "❌";
    const scheduled = p.scheduled_at ? ` (scheduled: ${p.scheduled_at})` : "";
    return `${statusIcon} **[${p.id}]** ${p.platform}${scheduled}\n${p.content.slice(0, 200)}${p.content.length > 200 ? "..." : ""}`;
  }).join("\n\n");
}
