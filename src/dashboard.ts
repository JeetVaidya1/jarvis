/**
 * Jarvis Dashboard integration shim.
 *
 * POSTs events to the dashboard server (http://localhost:4242) over HTTP so
 * the two processes stay fully decoupled. All calls are fire-and-forget —
 * if the dashboard is not running, failures are silently swallowed.
 */

import { createLogger } from "./logger.js";

const log = createLogger("dashboard");
const DASHBOARD_URL = "http://localhost:4242";

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

// ── Helpers ──

function post(path: string, body: unknown): void {
  fetch(`${DASHBOARD_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => {
    log.debug(`Dashboard POST ${path} failed: ${err}`);
  });
}

// ── Public API ──

export function logEvent(event: DashboardEvent): void {
  post("/api/events", event);
}

export function upsertSubagent(agent: SubagentRecord): void {
  post("/api/subagents", agent);
}

export function logSubagentOutput(id: string, chunk: string): void {
  post(`/api/subagents/${encodeURIComponent(id)}/output`, { chunk: chunk.slice(0, 2000) });
}

// ── Streaming events (for live agent response in dashboard) ──

export function broadcastAgentToken(sessionId: string, text: string): void {
  post("/api/agent/stream", { kind: "agent_token", sessionId, text });
}

export function broadcastAgentStatus(sessionId: string, status: string, toolName?: string, toolInput?: Record<string, unknown>): void {
  post("/api/agent/stream", { kind: "agent_status", sessionId, status, toolName, toolInput });
}

export function broadcastAgentComplete(sessionId: string, text: string): void {
  post("/api/agent/stream", { kind: "agent_complete", sessionId, text });
}
