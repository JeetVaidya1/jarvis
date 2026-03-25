/**
 * Dashboard hooks — bridges the internal event system to the dashboard logEvent API.
 *
 * Call registerDashboardHooks() once at startup (in index.ts) to wire everything up.
 * After that, every emit() call automatically produces a dashboard event.
 */

import { on } from "./events.js";
import { logEvent } from "./dashboard.js";

export function registerDashboardHooks(): void {
  // ── Incoming messages ──
  on("message:received", (e) => {
    const msgType = (e.data["type"] as string) ?? "text";
    logEvent({
      type: "message",
      summary: `Message received (${msgType})`,
      detail: e.data,
      status: "ok",
    });
  });

  // ── Agent responses ──
  on("message:sent", (e) => {
    const preview = (e.data["preview"] as string) ?? "";
    logEvent({
      type: "message",
      summary: `Agent: ${preview}`,
      detail: e.data,
      status: "ok",
    });
  });

  on("agent:response", (e) => {
    const backend = (e.data["backend"] as string) ?? "unknown";
    const iterations = e.data["iterations"] as number | undefined;
    const toolCalls = e.data["toolCalls"] as number | undefined;
    const summary = iterations !== undefined
      ? `Agent response via ${backend} (${iterations} iter, ${toolCalls} tools)`
      : `Agent response via ${backend}`;
    logEvent({
      type: "message",
      summary,
      detail: e.data,
      status: "ok",
    });
  });

  // ── Sub-agents ──
  on("subagent:completed", (e) => {
    const label = (e.data["label"] as string) ?? "unknown";
    logEvent({
      type: "subagent",
      summary: `Sub-agent completed: ${label}`,
      detail: e.data,
      status: "ok",
    });
  });

  on("subagent:failed", (e) => {
    const label = (e.data["label"] as string) ?? "unknown";
    const error = (e.data["error"] as string) ?? "";
    logEvent({
      type: "subagent",
      summary: `Sub-agent failed: ${label} — ${error}`,
      detail: e.data,
      status: "error",
    });
  });

  // ── Programs ──
  on("program:run", (e) => {
    const name = (e.data["name"] as string) ?? "unknown";
    logEvent({
      type: "message",
      summary: `Program started: ${name}`,
      detail: e.data,
      status: "ok",
    });
  });

  on("program:completed", (e) => {
    const name = (e.data["name"] as string) ?? "unknown";
    logEvent({
      type: "message",
      summary: `Program completed: ${name}`,
      detail: e.data,
      status: "ok",
    });
  });

  on("program:failed", (e) => {
    const name = (e.data["name"] as string) ?? "unknown";
    const error = (e.data["error"] as string) ?? "";
    logEvent({
      type: "error",
      summary: `Program failed: ${name} — ${error}`,
      detail: e.data,
      status: "error",
    });
  });

  // ── Webhooks ──
  on("webhook:received", (e) => {
    const event = (e.data["event"] as string) ?? "unknown";
    logEvent({
      type: "message",
      summary: `Webhook: ${event}`,
      detail: e.data,
      status: "ok",
    });
  });

  // ── Trading ──
  on("trading:trade", (e) => {
    const outcome = (e.data["outcome"] as string) ?? "trade";
    logEvent({
      type: "trade",
      summary: `Trade: ${outcome}`,
      detail: e.data,
      status: "ok",
    });
  });

  // ── Session ──
  on("session:reset", (_e) => {
    logEvent({
      type: "message",
      summary: "Session reset",
      status: "ok",
    });
  });
}
