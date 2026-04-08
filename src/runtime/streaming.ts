/**
 * Streaming agent runner — core execution loop using Anthropic SDK streaming.
 *
 * Replaces the CLI subprocess approach with direct SDK usage.
 * Emits RuntimeEvents for every token, tool call, and completion.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { executeTool } from "../tools/index.js";
import { logEvent } from "../dashboard.js";
import { createLogger } from "../logger.js";
import type {
  RuntimeOptions,
  RuntimeEvent,
  MessageParam,
  ContentBlock,
  ToolResultBlockParam,
  ToolResult,
} from "./types.js";

const log = createLogger("runtime");

// ── Config ──

const MAX_API_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);
const TOOL_LOOP_THRESHOLD = 3;

// ── Singleton client ──

let client: Anthropic | null = null;

/**
 * Get the Anthropic client. Prefers the Max subscription OAuth token
 * from the macOS Keychain (free), falls back to ANTHROPIC_API_KEY.
 */
function getClient(): Anthropic {
  if (!client) {
    const oauthToken = loadOAuthToken();
    if (oauthToken) {
      log.info("Using Max subscription OAuth token");
      client = new Anthropic({ apiKey: oauthToken });
    } else {
      log.info("Using ANTHROPIC_API_KEY");
      client = new Anthropic();
    }
  }
  return client;
}

function loadOAuthToken(): string | null {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    const creds = JSON.parse(raw);
    const token = creds?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.startsWith("sk-ant-")) {
      return token;
    }
  } catch {
    // Keychain not available or no credentials — fall back to API key
  }
  return null;
}

// ── Retry logic ──

function isRetryableError(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    return RETRYABLE_STATUS_CODES.has(error.status);
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("fetch failed");
  }
  return false;
}

async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_API_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error)) throw error;
      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
      log.warn(`API retry ${attempt + 1}/${MAX_API_RETRIES} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ── Tool result formatting ──

function buildToolResultContent(
  toolName: string,
  result: ToolResult,
): ToolResultBlockParam["content"] {
  if (toolName === "browser_screenshot" && result.base64Image) {
    return [
      { type: "text", text: result.text },
      { type: "image", source: { type: "base64", media_type: "image/png", data: result.base64Image } },
    ];
  }
  const text = result.text.length > 50_000
    ? result.text.slice(0, 50_000) + "\n...(truncated)"
    : result.text;
  return text;
}

function hashToolCall(name: string, input: Record<string, unknown>): string {
  return createHash("md5").update(name + ":" + JSON.stringify(input)).digest("hex");
}

// ── Main streaming runner ──

/**
 * Run the agent loop with streaming. Emits RuntimeEvents for every token,
 * tool call start/end, and completion. Returns the final assembled text.
 */
export async function runStreaming(
  systemPrompt: string,
  messages: readonly MessageParam[],
  tools: readonly Anthropic.Tool[],
  options: RuntimeOptions,
): Promise<string> {
  const anthropic = getClient();
  const { model, maxTokens, maxIterations, signal, onEvent } = options;

  // Mutable working copy of messages for the tool loop
  const workingMessages: MessageParam[] = [...messages];

  let iterations = 0;
  let totalToolCalls = 0;
  const toolCallCounts = new Map<string, number>();

  while (iterations < maxIterations) {
    iterations++;

    // Check abort before each iteration
    if (signal?.aborted) {
      onEvent({ kind: "status", message: "Cancelled" });
      return "(cancelled)";
    }

    // Stream the response with retry logic wrapping the full lifecycle
    let responseText = "";
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

    const response = await callWithRetry(async () => {
      // Reset for each retry attempt
      responseText = "";
      toolUseBlocks.length = 0;

      const stream = anthropic.messages.stream({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: tools as Anthropic.Tool[],
        messages: workingMessages,
      });

      stream.on("text", (text: string) => {
        responseText += text;
        onEvent({ kind: "token", text });
      });

      return stream.finalMessage();
    });

    // Extract tool_use blocks from the final message
    for (const block of response.content) {
      if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      }
    }

    // No tool calls — we're done
    if (toolUseBlocks.length === 0) {
      onEvent({
        kind: "message_complete",
        text: responseText,
        toolCalls: totalToolCalls,
        iterations,
      });
      return responseText || "(no response)";
    }

    // Add assistant message to working history
    workingMessages.push({
      role: "assistant",
      content: response.content as ContentBlock[],
    });

    // Check for tool loops
    let loopDetected = false;
    for (const tool of toolUseBlocks) {
      const hash = hashToolCall(tool.name, tool.input as Record<string, unknown>);
      const count = (toolCallCounts.get(hash) ?? 0) + 1;
      toolCallCounts.set(hash, count);
      if (count >= TOOL_LOOP_THRESHOLD) loopDetected = true;
    }

    if (loopDetected) {
      onEvent({ kind: "status", message: "Loop detected — forcing new approach" });
      workingMessages.push({
        role: "user",
        content: toolUseBlocks.map((t) => ({
          type: "tool_result" as const,
          tool_use_id: t.id,
          content: "LOOP DETECTED: Try a different approach.",
        })),
      });
    } else {
      // Execute tools
      const results: ToolResultBlockParam[] = [];

      for (const tool of toolUseBlocks) {
        // Check abort before each tool
        if (signal?.aborted) {
          onEvent({ kind: "status", message: "Cancelled during tool execution" });
          return responseText || "(cancelled)";
        }

        const toolInput = tool.input as Record<string, unknown>;

        onEvent({
          kind: "tool_start",
          toolName: tool.name,
          toolInput,
          toolUseId: tool.id,
        });

        const result = await executeTool(tool.name, toolInput);
        const isError = result.text.startsWith("ERROR");

        onEvent({
          kind: "tool_end",
          toolName: tool.name,
          toolUseId: tool.id,
          result: result.text.slice(0, 500),
          isError,
        });

        logEvent({
          type: "tool_call",
          tool: tool.name,
          summary: `Tool: ${tool.name}`,
          detail: { input: toolInput, ok: !isError },
          status: isError ? "error" : "ok",
        });

        results.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: buildToolResultContent(tool.name, result),
        });
      }

      workingMessages.push({ role: "user", content: results });
    }

    totalToolCalls += toolUseBlocks.length;
  }

  const msg = `Hit tool call limit (${maxIterations} iterations). Try breaking the task into smaller pieces.`;
  onEvent({ kind: "error", message: msg, retryable: false });
  return msg;
}
