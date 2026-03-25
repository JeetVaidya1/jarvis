/**
 * Dashboard database layer — SQLite via better-sqlite3.
 * Stores events and sub-agent records for the Jarvis Command Center.
 */

import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

const DB_DIR = join(dirname(new URL(import.meta.url).pathname));
const DB_PATH = join(DB_DIR, "jarvis-dashboard.db");

mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    type      TEXT NOT NULL,
    tool      TEXT,
    summary   TEXT NOT NULL,
    detail    TEXT,
    status    TEXT NOT NULL DEFAULT 'ok'
  );

  CREATE TABLE IF NOT EXISTS subagents (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    status       TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    completed_at TEXT,
    task         TEXT,
    result       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
`);

// ── Types ──

export interface EventRow {
  id: number;
  timestamp: string;
  type: string;
  tool: string | null;
  summary: string;
  detail: string | null;
  status: string;
}

export interface SubagentRow {
  id: string;
  name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  task: string | null;
  result: string | null;
}

// ── Prepared statements ──

const stmtInsertEvent = db.prepare<{
  timestamp: string;
  type: string;
  tool: string | null;
  summary: string;
  detail: string | null;
  status: string;
}>(`
  INSERT INTO events (timestamp, type, tool, summary, detail, status)
  VALUES (@timestamp, @type, @tool, @summary, @detail, @status)
`);

const stmtRecentEvents = db.prepare<[], EventRow>(`
  SELECT * FROM events ORDER BY id DESC LIMIT 200
`);

const stmtUpsertSubagent = db.prepare<{
  id: string;
  name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  task: string | null;
  result: string | null;
}>(`
  INSERT INTO subagents (id, name, status, started_at, completed_at, task, result)
  VALUES (@id, @name, @status, @started_at, @completed_at, @task, @result)
  ON CONFLICT(id) DO UPDATE SET
    name         = excluded.name,
    status       = excluded.status,
    completed_at = excluded.completed_at,
    result       = excluded.result
`);

const stmtAllSubagents = db.prepare<[], SubagentRow>(`
  SELECT * FROM subagents ORDER BY started_at DESC
`);

const stmtStatsTotalEvents = db.prepare<[], { count: number }>(`
  SELECT COUNT(*) as count FROM events
`);

const stmtStatsEventsToday = db.prepare<[], { count: number }>(`
  SELECT COUNT(*) as count FROM events
  WHERE timestamp >= date('now')
`);

const stmtStatsActiveAgents = db.prepare<[], { count: number }>(`
  SELECT COUNT(*) as count FROM subagents WHERE status = 'running'
`);

const stmtStatsLastHeartbeat = db.prepare<[], { timestamp: string | null }>(`
  SELECT timestamp FROM events WHERE type = 'heartbeat' ORDER BY id DESC LIMIT 1
`);

const stmtStatsEventsLastHour = db.prepare<[], { count: number }>(`
  SELECT COUNT(*) as count FROM events
  WHERE timestamp >= datetime('now', '-1 hour')
`);

// ── Public API ──

export function insertEvent(row: Omit<EventRow, "id">): void {
  stmtInsertEvent.run(row);
}

export function getRecentEvents(): EventRow[] {
  return stmtRecentEvents.all();
}

export function upsertSubagentRow(row: SubagentRow): void {
  stmtUpsertSubagent.run(row);
}

export function getAllSubagents(): SubagentRow[] {
  return stmtAllSubagents.all();
}

export interface StatsResult {
  totalEvents: number;
  eventsToday: number;
  activeAgents: number;
  lastHeartbeat: string | null;
  eventsLastHour: number;
}

export function getStats(): StatsResult {
  const total = stmtStatsTotalEvents.get();
  const today = stmtStatsEventsToday.get();
  const active = stmtStatsActiveAgents.get();
  const heartbeat = stmtStatsLastHeartbeat.get();
  const lastHour = stmtStatsEventsLastHour.get();

  return {
    totalEvents: total?.count ?? 0,
    eventsToday: today?.count ?? 0,
    activeAgents: active?.count ?? 0,
    lastHeartbeat: heartbeat?.timestamp ?? null,
    eventsLastHour: lastHour?.count ?? 0,
  };
}

// Not exported by default — use the exported functions above
