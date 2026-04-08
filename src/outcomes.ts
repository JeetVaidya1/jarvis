/**
 * Outcome learning — log decisions, resolve outcomes, find similar past decisions.
 *
 * Generalizes the trading feedback loop to all agent decisions.
 * Uses SQLite for storage and the existing embedding infrastructure
 * for similarity search.
 */

import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createLogger } from "./logger.js";

const log = createLogger("outcomes");

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DB_PATH = join(PROJECT_ROOT, "data", "outcomes.db");

// ── Database Setup ──

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
    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      domain TEXT NOT NULL,
      input_summary TEXT NOT NULL,
      decision TEXT NOT NULL,
      reasoning TEXT,
      outcome TEXT,
      score REAL,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_outcomes_domain ON outcomes(domain);
    CREATE INDEX IF NOT EXISTS idx_outcomes_resolved ON outcomes(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_outcomes_timestamp ON outcomes(timestamp);
  `);

  log.info("Outcomes database initialized");
  return db;
}

// ── Types ──

export interface Outcome {
  readonly id: number;
  readonly timestamp: string;
  readonly domain: string;
  readonly input_summary: string;
  readonly decision: string;
  readonly reasoning: string | null;
  readonly outcome: string | null;
  readonly score: number | null;
  readonly resolved_at: string | null;
}

// ── Public API ──

/**
 * Log a decision that should be tracked for outcome learning.
 * Returns the outcome ID for later resolution.
 */
export function logOutcome(
  domain: string,
  inputSummary: string,
  decision: string,
  reasoning?: string,
): number {
  const database = getDb();
  const stmt = database.prepare(
    "INSERT INTO outcomes (domain, input_summary, decision, reasoning) VALUES (?, ?, ?, ?)",
  );
  const result = stmt.run(domain, inputSummary, decision, reasoning ?? null);

  log.info(`Outcome logged [${domain}]: ${decision.slice(0, 80)}`);
  return result.lastInsertRowid as number;
}

/**
 * Resolve an outcome with the actual result.
 * Score: 1.0 = perfect, 0.0 = completely wrong.
 */
export function resolveOutcome(
  id: number,
  outcome: string,
  score: number,
): boolean {
  const database = getDb();
  const stmt = database.prepare(
    "UPDATE outcomes SET outcome = ?, score = ?, resolved_at = datetime('now') WHERE id = ?",
  );
  const result = stmt.run(outcome, score, id);

  if (result.changes > 0) {
    log.info(`Outcome ${id} resolved: score=${score.toFixed(2)}`);
    return true;
  }
  return false;
}

/**
 * Find similar past decisions by keyword matching.
 * Uses simple text search on input_summary and decision fields.
 */
export function findSimilar(
  query: string,
  domain?: string,
  limit: number = 5,
): Outcome[] {
  const database = getDb();

  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
  if (keywords.length === 0) return [];

  const whereClause = domain
    ? "WHERE domain = ? AND outcome IS NOT NULL"
    : "WHERE outcome IS NOT NULL";

  const rows = domain
    ? database.prepare(
        `SELECT * FROM outcomes ${whereClause} ORDER BY timestamp DESC LIMIT 100`,
      ).all(domain) as Outcome[]
    : database.prepare(
        `SELECT * FROM outcomes ${whereClause} ORDER BY timestamp DESC LIMIT 100`,
      ).all() as Outcome[];

  // Score by keyword overlap
  const scored = rows.map((row) => {
    const text = `${row.input_summary} ${row.decision}`.toLowerCase();
    const matches = keywords.filter((k) => text.includes(k)).length;
    return { row, score: matches / keywords.length };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.row);
}

/**
 * Get recent unresolved outcomes (pending follow-up).
 */
export function getPendingOutcomes(limit: number = 10): Outcome[] {
  const database = getDb();
  return database.prepare(
    "SELECT * FROM outcomes WHERE outcome IS NULL ORDER BY timestamp DESC LIMIT ?",
  ).all(limit) as Outcome[];
}

/**
 * Get resolved outcomes for a time range (for weekly review).
 */
export function getResolvedOutcomes(days: number = 7): Outcome[] {
  const database = getDb();
  return database.prepare(
    "SELECT * FROM outcomes WHERE outcome IS NOT NULL AND resolved_at >= datetime('now', '-' || ? || ' days') ORDER BY timestamp DESC",
  ).all(days) as Outcome[];
}

/**
 * Get accuracy stats by domain.
 */
export function getAccuracyByDomain(): Array<{ domain: string; count: number; avgScore: number }> {
  const database = getDb();
  return database.prepare(
    "SELECT domain, COUNT(*) as count, AVG(score) as avgScore FROM outcomes WHERE score IS NOT NULL GROUP BY domain ORDER BY count DESC",
  ).all() as Array<{ domain: string; count: number; avgScore: number }>;
}

/**
 * Format outcomes for display.
 */
export function formatOutcomes(outcomes: readonly Outcome[]): string {
  if (outcomes.length === 0) return "No outcomes found.";

  return outcomes.map((o) => {
    const status = o.outcome ? `Resolved (${o.score?.toFixed(2) ?? "?"})` : "Pending";
    return [
      `**[${o.id}] ${o.domain}** — ${status}`,
      `  Input: ${o.input_summary.slice(0, 100)}`,
      `  Decision: ${o.decision.slice(0, 100)}`,
      o.outcome ? `  Outcome: ${o.outcome.slice(0, 100)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}
