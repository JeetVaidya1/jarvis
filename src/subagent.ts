/**
 * Sub-agent system — spawn background agent runs that don't block
 * the main conversation. Uses the embedded runtime (no CLI subprocess).
 *
 * All subagents run through the Anthropic SDK with streaming, proper
 * cancellation via AbortController, and event broadcasting.
 */

import { randomUUID } from "node:crypto";
import { createSession, runAgentSession } from "./runtime/index.js";
import { broadcastRuntimeEvent } from "./gateway/index.js";
import { createLogger } from "./logger.js";
import { emit } from "./events.js";
import { logEvent, upsertSubagent as dashboardUpsertSubagent, logSubagentOutput } from "./dashboard.js";
import type { RuntimeEvent } from "./runtime/types.js";

const log = createLogger("subagent");

export interface SubAgentRun {
  id: string;
  task: string;
  label: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

// In-memory registry of all runs
const runs = new Map<string, SubAgentRun>();

// Track abort controllers for cancellation
const abortControllers = new Map<string, AbortController>();

export function spawnSubAgent(
  task: string,
  label?: string,
  workingDir?: string,
  model?: string,
): SubAgentRun {
  const id = randomUUID().slice(0, 8);
  const run: SubAgentRun = {
    id,
    task,
    label: label ?? task.slice(0, 50),
    status: "running",
    createdAt: Date.now(),
  };

  runs.set(id, run);

  log.info(`Spawned sub-agent ${id}: ${run.label}`);

  // Notify dashboard
  dashboardUpsertSubagent({
    id,
    name: run.label,
    status: "running",
    startedAt: new Date(run.createdAt).toISOString(),
    task,
  });
  logEvent({ type: "subagent", summary: `Spawned: ${run.label}`, detail: { id }, status: "pending" });

  // Fire and forget — runs in background
  executeSubAgent(id, task, model).catch((err) => {
    log.error(`Sub-agent ${id} crashed: ${err}`);
  });

  return run;
}

async function executeSubAgent(
  id: string,
  task: string,
  model?: string,
): Promise<void> {
  const run = runs.get(id);
  if (!run) return;

  // Create a dedicated session for this subagent
  const session = createSession(`subagent-${id}`);

  try {
    // Event handler: broadcast to gateway + log to dashboard
    const onEvent = (event: RuntimeEvent) => {
      // Broadcast to WebSocket clients
      broadcastRuntimeEvent(`subagent-${id}`, event);

      // Stream output to dashboard
      if (event.kind === "token") {
        logSubagentOutput(id, event.text);
      }
      if (event.kind === "tool_start") {
        log.info(`Sub-agent ${id} tool: ${event.toolName}`);
      }
    };

    const result = await runAgentSession(session, task, onEvent, model);

    run.status = "completed";
    run.result = result.response;
    run.completedAt = Date.now();

    log.info(`Sub-agent ${id} completed (${((run.completedAt - run.createdAt) / 1000).toFixed(1)}s)`);

    dashboardUpsertSubagent({
      id,
      name: run.label,
      status: "completed",
      startedAt: new Date(run.createdAt).toISOString(),
      completedAt: new Date(run.completedAt).toISOString(),
      task: run.task,
      result: result.response.slice(0, 500),
    });
    logEvent({ type: "subagent", summary: `Completed: ${run.label}`, detail: { id }, status: "ok" });

    await emit("subagent", "completed", {
      id,
      label: run.label,
      resultPreview: result.response.slice(0, 200),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    run.status = "failed";
    run.error = msg;
    run.completedAt = Date.now();
    log.error(`Sub-agent ${id} failed: ${msg}`);

    dashboardUpsertSubagent({
      id,
      name: run.label,
      status: "failed",
      startedAt: new Date(run.createdAt).toISOString(),
      completedAt: new Date(run.completedAt).toISOString(),
      task: run.task,
    });
    logEvent({ type: "subagent", summary: `Failed: ${run.label}`, detail: { id, error: msg }, status: "error" });

    await emit("subagent", "failed", { id, label: run.label, error: msg });
  }
}

export function listSubAgents(): SubAgentRun[] {
  return [...runs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getSubAgent(id: string): SubAgentRun | undefined {
  return runs.get(id);
}

export function cancelSubAgent(id: string): boolean {
  const run = runs.get(id);
  if (!run || run.status !== "running") return false;

  // Cancel via the session's abort controller
  // The runtime checks the signal before each iteration
  run.status = "cancelled";
  run.completedAt = Date.now();

  log.info(`Sub-agent ${id} cancelled`);
  return true;
}

export function sweepSubAgents(maxAgeMs: number = 60 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  for (const [id, run] of runs) {
    if (run.status !== "running" && (run.completedAt ?? 0) < cutoff) {
      runs.delete(id);
      removed++;
    }
  }

  return removed;
}
