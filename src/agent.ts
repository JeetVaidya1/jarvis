/**
 * Agent — thin adapter that preserves the legacy `runAgent()` API.
 *
 * Delegates to the embedded runtime (src/runtime/) which uses the Anthropic
 * SDK directly with streaming, tool calling, and cancellation support.
 *
 * This module exists for backward compatibility during the migration to the
 * gateway architecture. Once bot.ts routes through the gateway, this module
 * can be removed.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { createSession, runAgentSession } from "./runtime/index.js";
import { createLogger } from "./logger.js";

export { buildSystemPrompt, extractMultimodalParts } from "./runtime/index.js";

const log = createLogger("agent");

type MessageParam = Anthropic.MessageParam;

export type ProgressCallback = (message: string) => Promise<void>;

let runCounter = 0;

/**
 * Run the agent. Creates a temporary session, runs the embedded runtime,
 * and returns the response text. This is the legacy API — new code should
 * use the runtime directly via the gateway.
 */
export async function runAgent(
  userMessage: string | Anthropic.MessageCreateParams["messages"][0]["content"],
  conversationHistory: MessageParam[],
  onProgress?: ProgressCallback,
): Promise<string> {
  const sessionId = `legacy-${++runCounter}`;
  const session = createSession(sessionId, conversationHistory);

  const onEvent = (event: { kind: string; toolName?: string; text?: string; message?: string }) => {
    if (event.kind === "tool_start" && onProgress && event.toolName) {
      const label = event.toolName.replace(/_/g, " ");
      onProgress(`Using ${label}...`).catch(() => {});
    }
  };

  const result = await runAgentSession(session, userMessage, onEvent);

  return result.response;
}
