/**
 * Event system — lightweight hook registry inspired by OpenClaw's internal-hooks.
 * Events fire on agent lifecycle points. Hooks can inject behavior without
 * modifying core code.
 *
 * Event keys use "type:action" format:
 *   "message:received", "message:sent", "agent:response",
 *   "session:reset", "session:start", "tool:call", "heartbeat:ok",
 *   "heartbeat:alert", "webhook:received", "program:run"
 */

import { createLogger } from "./logger.js";

const log = createLogger("events");

export interface JarvisEvent {
  type: string;
  action: string;
  timestamp: Date;
  data: Record<string, unknown>;
}

export type EventHandler = (event: JarvisEvent) => Promise<void> | void;

// Global handler registry: eventKey → handler[]
const handlers = new Map<string, EventHandler[]>();

export function on(eventKey: string, handler: EventHandler): void {
  const existing = handlers.get(eventKey) ?? [];
  existing.push(handler);
  handlers.set(eventKey, existing);
}

export function off(eventKey: string, handler: EventHandler): void {
  const existing = handlers.get(eventKey);
  if (!existing) return;
  const idx = existing.indexOf(handler);
  if (idx !== -1) existing.splice(idx, 1);
}

export async function emit(type: string, action: string, data: Record<string, unknown> = {}): Promise<void> {
  const event: JarvisEvent = { type, action, timestamp: new Date(), data };

  // Fire handlers for both "type" and "type:action"
  const keys = [type, `${type}:${action}`];

  for (const key of keys) {
    const keyHandlers = handlers.get(key);
    if (!keyHandlers) continue;

    for (const handler of keyHandlers) {
      try {
        await handler(event);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`Hook error on "${key}": ${msg}`);
      }
    }
  }
}

export function listHandlers(): Map<string, number> {
  const result = new Map<string, number>();
  for (const [key, list] of handlers) {
    result.set(key, list.length);
  }
  return result;
}
