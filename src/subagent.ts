/**
 * Sub-agent system — spawn background agent runs that don't block
 * the main conversation. Supports two backends:
 *
 *  - "api" — uses the Anthropic API (costs money, has tool calling)
 *  - "cli" — uses Claude Code CLI (FREE on Max plan, full tool access)
 *
 * Default: "cli" because Max plan makes it free.
 */

import { randomUUID } from "node:crypto";
import { runAgent } from "./agent.js";
import { claudeCode, claudeCodeResearch } from "./tools/claude-code.js";
import { createLogger } from "./logger.js";
import { emit } from "./events.js";
import { logEvent, upsertSubagent as dashboardUpsertSubagent, logSubagentOutput } from "./dashboard.js";

const log = createLogger("subagent");

export type SubAgentBackend = "api" | "cli";

export interface SubAgentRun {
  id: string;
  task: string;
  label: string;
  backend: SubAgentBackend;
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
  backend: SubAgentBackend = "cli",
  workingDir?: string,
  model?: string,
): SubAgentRun {
  const id = randomUUID().slice(0, 8);
  const run: SubAgentRun = {
    id,
    task,
    label: label ?? task.slice(0, 50),
    backend,
    status: "running",
    createdAt: Date.now(),
  };

  runs.set(id, run);

  const controller = new AbortController();
  abortControllers.set(id, controller);

  log.info(`Spawned sub-agent ${id} (${backend}): ${run.label}`);

  // Notify dashboard
  dashboardUpsertSubagent({
    id,
    name: run.label,
    status: "running",
    startedAt: new Date(run.createdAt).toISOString(),
    task,
  });
  logEvent({ type: "subagent", summary: `Spawned: ${run.label}`, detail: { id, backend }, status: "pending" });

  // Fire and forget — runs in background
  executeSubAgent(id, task, backend, controller.signal, workingDir, model).catch((err) => {
    log.error(`Sub-agent ${id} crashed: ${err}`);
  });

  return run;
}

async function executeSubAgent(
  id: string,
  task: string,
  backend: SubAgentBackend,
  signal: AbortSignal,
  workingDir?: string,
  model?: string,
): Promise<void> {
  const run = runs.get(id);
  if (!run) return;

  try {
    if (signal.aborted) {
      run.status = "cancelled";
      run.completedAt = Date.now();
      return;
    }

    let result: string;

    if (backend === "cli") {
      // Route through Claude Code CLI — FREE on Max plan
      result = await claudeCodeResearch(task, {
        workingDir,
        model,
        timeout: 300_000,
        onChunk: (chunk: string) => {
          logSubagentOutput(id, chunk);
        },
      });
    } else {
      // Route through Anthropic API — costs money but has Jarvis's tools
      result = await runAgent(task, []);
    }

    if (signal.aborted) {
      run.status = "cancelled";
      run.completedAt = Date.now();
      return;
    }

    run.status = "completed";
    run.result = result;
    run.completedAt = Date.now();

    log.info(`Sub-agent ${id} completed (${((run.completedAt - run.createdAt) / 1000).toFixed(1)}s)`);

    // Notify dashboard
    dashboardUpsertSubagent({
      id,
      name: run.label,
      status: "completed",
      startedAt: new Date(run.createdAt).toISOString(),
      completedAt: new Date(run.completedAt).toISOString(),
      task: run.task,
      result: result.slice(0, 500),
    });
    logEvent({ type: "subagent", summary: `Completed: ${run.label}`, detail: { id }, status: "ok" });

    await emit("subagent", "completed", {
      id,
      label: run.label,
      backend,
      resultPreview: result.slice(0, 200),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    run.status = "failed";
    run.error = msg;
    run.completedAt = Date.now();
    log.error(`Sub-agent ${id} failed: ${msg}`);

    // Notify dashboard
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
  } finally {
    abortControllers.delete(id);
  }
}

export function listSubAgents(): SubAgentRun[] {
  return [...runs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getSubAgent(id: string): SubAgentRun | undefined {
  return runs.get(id);
}

export function cancelSubAgent(id: string): boolean {
  const controller = abortControllers.get(id);
  if (!controller) return false;

  controller.abort();
  const run = runs.get(id);
  if (run && run.status === "running") {
    run.status = "cancelled";
    run.completedAt = Date.now();
  }
  abortControllers.delete(id);
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
