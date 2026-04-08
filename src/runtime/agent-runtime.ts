/**
 * Agent runtime — manages agent sessions with conversation history,
 * system prompt composition, context compaction, and lifecycle management.
 *
 * Wraps the streaming runner with session state. All operations are
 * immutable — functions return new session objects, never mutate.
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSOUL, loadMemory, loadDailyLog, appendDailyLog } from "../memory.js";
import { TOOL_DEFINITIONS } from "../tools/index.js";
import { getSkillTools } from "../skills/index.js";
import { pruneMessages } from "../compaction.js";
import { emit } from "../events.js";
import { createLogger } from "../logger.js";
import { runStreaming } from "./streaming.js";
import type {
  AgentSession,
  MessageParam,
  RuntimeEvent,
  EventCallback,
  ContentArray,
} from "./types.js";

const log = createLogger("runtime");

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_ITERATIONS = 25;

// ── System Prompt ──

export async function buildSystemPrompt(): Promise<string> {
  const [soul, memory, dailyLog] = await Promise.all([
    loadSOUL(),
    loadMemory(),
    loadDailyLog(),
  ]);

  const parts = [soul];

  if (memory) {
    parts.push("\n\n---\n\n# Current Memory\n\n" + memory);
  }

  if (dailyLog) {
    parts.push("\n\n---\n\n# Today's Log\n\n" + dailyLog);
  }

  parts.push(
    "\n\n---\n\n_Current time: " +
    new Date().toLocaleString("en-CA", { timeZone: "America/Vancouver" }) +
    " Pacific_",
  );

  return parts.join("");
}

// ── Multimodal Helpers ──

/**
 * Decompose multimodal content into text + temp file paths.
 * Images and PDFs are written to temp files for tool-based reading.
 */
export function extractMultimodalParts(content: ContentArray): {
  text: string;
  tempPaths: string[];
} {
  if (typeof content === "string") return { text: content, tempPaths: [] };

  const textParts: string[] = [];
  const tempPaths: string[] = [];

  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "image") {
      const src = block.source;
      if (src.type === "base64") {
        const ext = src.media_type === "image/jpeg" ? "jpg"
          : src.media_type === "image/gif" ? "gif"
          : src.media_type === "image/webp" ? "webp"
          : "png";
        const tmpPath = join(tmpdir(), `jarvis-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        writeFileSync(tmpPath, Buffer.from(src.data, "base64"));
        tempPaths.push(tmpPath);
        textParts.push(`[Image saved to: ${tmpPath} — analyze it visually]`);
      } else if (src.type === "url") {
        textParts.push(`[Image URL: ${src.url}]`);
      }
    } else if (block.type === "document") {
      const src = (block as { type: "document"; source: { type: string; data?: string; media_type?: string; url?: string } }).source;
      if (src.type === "base64" && src.data) {
        const ext = src.media_type === "application/pdf" ? "pdf" : "bin";
        const tmpPath = join(tmpdir(), `jarvis-doc-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        writeFileSync(tmpPath, Buffer.from(src.data, "base64"));
        tempPaths.push(tmpPath);
        textParts.push(`[Document saved to: ${tmpPath} — use the Read tool to open it]`);
      } else if (src.type === "url" && src.url) {
        textParts.push(`[Document URL: ${src.url} — use WebFetch or Read tool to open it]`);
      }
    }
  }

  return { text: textParts.join("\n"), tempPaths };
}

// ── Session Management ──

export function createSession(id: string, messages: readonly MessageParam[] = []): AgentSession {
  return {
    id,
    messages,
    status: "idle",
    abortController: null,
  };
}

export function cancelSession(session: AgentSession): AgentSession {
  if (session.abortController) {
    session.abortController.abort();
  }
  return { ...session, status: "cancelled", abortController: null };
}

// ── Run Agent ──

export interface RunResult {
  readonly response: string;
  readonly session: AgentSession;
}

/**
 * Run the agent on a session. Returns the response text and a new session
 * with updated conversation history. Never mutates the input session.
 */
export async function runAgentSession(
  session: AgentSession,
  userMessage: string | ContentArray,
  onEvent: EventCallback,
  model?: string,
): Promise<RunResult> {
  const abortController = new AbortController();

  // Mark session as running
  let currentSession: AgentSession = {
    ...session,
    status: "running",
    abortController,
  };

  // Handle multimodal content
  let textMessage: string;
  let tempPaths: string[] = [];

  if (typeof userMessage !== "string") {
    const parts = extractMultimodalParts(userMessage);
    textMessage = parts.text;
    tempPaths = parts.tempPaths;
    log.info(`Multimodal input: ${tempPaths.length} file(s)`);
  } else {
    textMessage = userMessage;
  }

  try {
    const systemPrompt = await buildSystemPrompt();

    // Build messages with compaction
    const prunedHistory = pruneMessages([...session.messages]);
    const messages: MessageParam[] = [
      ...prunedHistory,
      { role: "user", content: textMessage },
    ];

    log.info(`Agent run: ${textMessage.slice(0, 80)}...`);

    const response = await runStreaming(
      systemPrompt,
      messages,
      [...TOOL_DEFINITIONS, ...getSkillTools()] as Anthropic.Tool[],
      {
        model: model ?? DEFAULT_MODEL,
        maxTokens: DEFAULT_MAX_TOKENS,
        maxIterations: DEFAULT_MAX_ITERATIONS,
        signal: abortController.signal,
        onEvent,
      },
    );

    // Log to daily log
    await appendDailyLog(
      `[${new Date().toISOString()}] Agent response (streaming): ${response.slice(0, 100)}...`,
    );
    await emit("agent", "response", { backend: "streaming" });

    // Return new session with updated history
    const updatedMessages: MessageParam[] = [
      ...session.messages,
      { role: "user", content: userMessage },
      { role: "assistant", content: response },
    ];

    currentSession = {
      ...currentSession,
      messages: updatedMessages,
      status: "idle",
      abortController: null,
    };

    return { response, session: currentSession };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Agent run failed: ${msg}`);

    onEvent({ kind: "error", message: msg, retryable: false });

    currentSession = {
      ...currentSession,
      status: "idle",
      abortController: null,
    };

    return {
      response: `Error: ${msg}`,
      session: currentSession,
    };
  } finally {
    // Clean up temp files
    for (const p of tempPaths) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}
