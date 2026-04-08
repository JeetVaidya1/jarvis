/**
 * Dashboard logger — inserts events into SQLite and broadcasts via SSE.
 * Import logEvent / upsertSubagent anywhere in Jarvis to push data to the dashboard.
 */

import { insertEvent, upsertSubagentRow } from "./db.js";
import type { SubagentRow } from "./db.js";

// ── Types ──

export type EventType = "tool_call" | "message" | "subagent" | "trade" | "error" | "heartbeat";
export type EventStatus = "ok" | "error" | "pending";

export interface DashboardEvent {
  type: EventType;
  tool?: string;
  summary: string;
  detail?: Record<string, unknown>;
  status?: EventStatus;
}

export interface SubagentRecord {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  task?: string;
  result?: string;
}

// SSE client registry — populated by server.ts
type SseClient = { write: (data: string) => void; ended: boolean };
const sseClients = new Set<SseClient>();

export function registerSseClient(client: SseClient): void {
  sseClients.add(client);
}

export function unregisterSseClient(client: SseClient): void {
  sseClients.delete(client);
}

export function broadcast(payload: Record<string, unknown>): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    if (!client.ended) {
      try {
        client.write(data);
      } catch {
        // Client disconnected mid-write — will be cleaned up on close event
      }
    }
  }
}

// ── Public API ──

export function logEvent(event: DashboardEvent): void {
  const timestamp = new Date().toISOString();
  const status = event.status ?? "ok";
  const detail = event.detail ? JSON.stringify(event.detail) : null;

  insertEvent({
    timestamp,
    type: event.type,
    tool: event.tool ?? null,
    summary: event.summary,
    detail,
    status,
  });

  broadcast({
    kind: "event",
    timestamp,
    type: event.type,
    tool: event.tool ?? null,
    summary: event.summary,
    detail: event.detail ?? null,
    status,
  });
}

export function broadcastSubagentOutput(id: string, chunk: string): void {
  broadcast({ kind: "subagent_output", id, chunk });
}

export function upsertSubagent(agent: SubagentRecord): void {
  const row: SubagentRow = {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    started_at: agent.startedAt,
    completed_at: agent.completedAt ?? null,
    task: agent.task ?? null,
    result: agent.result ?? null,
  };

  upsertSubagentRow(row);

  broadcast({
    kind: "subagent",
    id: agent.id,
    name: agent.name,
    status: agent.status,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt ?? null,
    task: agent.task ?? null,
    result: agent.result ?? null,
  });
}
