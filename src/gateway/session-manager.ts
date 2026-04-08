/**
 * Session manager — manages agent sessions for all connected channels.
 *
 * Maps channel identifiers (e.g., Telegram chat ID) to agent sessions.
 * Handles session creation, lookup, persistence, and cleanup.
 */

import { randomUUID } from "node:crypto";
import { createSession, runAgentSession, cancelSession } from "../runtime/index.js";
import { loadSession, saveSession } from "../session.js";
import { createLogger } from "../logger.js";
import type { AgentSession, EventCallback, ContentArray, MessageParam } from "../runtime/types.js";
import type { RuntimeEvent } from "../runtime/types.js";

const log = createLogger("sessions");

const MAX_SESSION_HISTORY = 40;

// ── State ──

// channelKey → sessionId
const channelMap = new Map<string, string>();

// sessionId → session
const sessions = new Map<string, AgentSession>();

// ── Channel Key ──

function channelKey(channelType: string, channelId: string): string {
  return `${channelType}:${channelId}`;
}

// ── Session CRUD ──

export function getOrCreateSession(channelType: string, channelId: string): AgentSession {
  const key = channelKey(channelType, channelId);
  const existingId = channelMap.get(key);

  if (existingId) {
    const session = sessions.get(existingId);
    if (session) return session;
  }

  const id = randomUUID().slice(0, 12);
  const session = createSession(id);
  sessions.set(id, session);
  channelMap.set(key, id);

  log.info(`Created session ${id} for ${key}`);
  return session;
}

export function getSession(sessionId: string): AgentSession | undefined {
  return sessions.get(sessionId);
}

export function getSessionForChannel(channelType: string, channelId: string): AgentSession | undefined {
  const key = channelKey(channelType, channelId);
  const sessionId = channelMap.get(key);
  if (!sessionId) return undefined;
  return sessions.get(sessionId);
}

export function updateSession(session: AgentSession): void {
  sessions.set(session.id, session);
}

export function listSessions(): AgentSession[] {
  return [...sessions.values()];
}

// ── Run Agent on Session ──

export interface HandleMessageResult {
  readonly response: string;
  readonly sessionId: string;
}

/**
 * Send a message to a session's agent. Creates the session if it doesn't exist.
 * Emits runtime events via the callback. Returns the final response.
 */
export async function handleMessage(
  channelType: string,
  channelId: string,
  message: string | ContentArray,
  onEvent: EventCallback,
  model?: string,
): Promise<HandleMessageResult> {
  const session = getOrCreateSession(channelType, channelId);

  if (session.status === "running") {
    onEvent({ kind: "error", message: "Agent is already processing a message. Use /cancel to stop it.", retryable: false });
    return { response: "Agent is busy. Use /cancel to stop the current task.", sessionId: session.id };
  }

  const result = await runAgentSession(session, message, onEvent, model);

  // Trim history to prevent unbounded growth
  let updatedSession = result.session;
  if (updatedSession.messages.length > MAX_SESSION_HISTORY) {
    const trimmed = updatedSession.messages.slice(-MAX_SESSION_HISTORY);
    updatedSession = { ...updatedSession, messages: trimmed };
  }

  // Update session in registry
  updateSession(updatedSession);

  // Persist to disk (fire-and-forget)
  persistSession(updatedSession).catch((err) => {
    log.error(`Session persist failed: ${err}`);
  });

  return { response: result.response, sessionId: session.id };
}

// ── Cancel ──

export function cancelCurrentSession(channelType: string, channelId: string): boolean {
  const session = getSessionForChannel(channelType, channelId);
  if (!session || session.status !== "running") return false;

  const cancelled = cancelSession(session);
  updateSession(cancelled);
  log.info(`Cancelled session ${session.id}`);
  return true;
}

export function cancelSessionById(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "running") return false;

  const cancelled = cancelSession(session);
  updateSession(cancelled);
  log.info(`Cancelled session ${sessionId}`);
  return true;
}

// ── Persistence ──

async function persistSession(session: AgentSession): Promise<void> {
  // Strip base64 images from messages before persisting (session.ts already does this)
  await saveSession([...session.messages] as MessageParam[]);
}

/**
 * Restore the default Telegram session from disk on startup.
 */
export async function restoreSessions(): Promise<void> {
  try {
    const messages = await loadSession();
    if (messages.length > 0) {
      const session = createSession("telegram-default", messages);
      sessions.set(session.id, session);
      channelMap.set("telegram:default", session.id);
      log.info(`Restored session with ${messages.length} messages`);
    }
  } catch (error) {
    log.warn(`Session restore failed: ${error}`);
  }
}

// ── Sweep ──

export function sweepIdleSessions(maxIdleMs: number = 24 * 60 * 60 * 1000): number {
  // For now, sessions are lightweight — just keep them all.
  // This hook exists for future use with multi-channel sessions.
  return 0;
}
