/**
 * Agent — routes all work through Claude Code CLI (FREE on Max plan).
 *
 * Architecture:
 *   User message → build system prompt → claude -p --mcp-config → response
 *
 * Claude Code handles: agentic loop, tool calling, retries, context management.
 * Jarvis's custom tools (Polymarket, browser, memory, etc.) are exposed via MCP.
 * Claude Code's built-in tools (Read, Write, Edit, Bash, Grep, WebSearch) are
 * available natively — no need to duplicate them.
 *
 * Fallback: if CLI fails, falls back to the Anthropic API with tool definitions.
 */

import Anthropic from "@anthropic-ai/sdk";
import { join, dirname } from "node:path";
import { loadSOUL, loadMemory, loadDailyLog, appendDailyLog } from "./memory.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools/index.js";
import type { ToolResult } from "./tools/index.js";
import { createLogger } from "./logger.js";
import { createHash } from "node:crypto";
import { pruneMessages } from "./compaction.js";
import { emit } from "./events.js";
import { shellExec } from "./tools/shell.js";

const log = createLogger("agent");

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const MCP_CONFIG = join(PROJECT_ROOT, "jarvis-mcp.json");

const MODEL = "sonnet";
const MAX_OUTPUT_TOKENS = 4096;
const CLI_TIMEOUT = 300_000; // 5 minutes
const PROGRESS_THRESHOLD = 5;

// API fallback config
const MAX_ITERATIONS = 25;
const MAX_API_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);
const TOOL_LOOP_THRESHOLD = 3;

type MessageParam = Anthropic.MessageParam;
type ContentBlock = Anthropic.ContentBlock;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

export type ProgressCallback = (message: string) => Promise<void>;

// ── System Prompt ──

async function buildSystemPrompt(): Promise<string> {
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

/**
 * Build conversation context as a single text block for CLI mode.
 * CLI is single-turn, so we embed recent history in the prompt.
 */
function buildConversationContext(history: readonly MessageParam[]): string {
  if (history.length === 0) return "";

  const recent = history.slice(-10); // Last 5 exchanges
  const parts: string[] = ["\n\n---\n\n# Recent Conversation\n"];

  for (const msg of recent) {
    const role = msg.role === "user" ? "Jeet" : "Jarvis";
    if (typeof msg.content === "string") {
      const truncated = msg.content.length > 500
        ? msg.content.slice(0, 500) + "..."
        : msg.content;
      parts.push(`**${role}**: ${truncated}`);
    }
  }

  return parts.join("\n");
}

function escapeForHeredoc(str: string): string {
  // Replace any occurrence of our delimiter to avoid premature termination
  return str.replace(/JARVIS_EOF/g, "JARVIS_E_O_F");
}

// ══════════════════════════════════════════════
// Primary path: Claude Code CLI (FREE on Max plan)
// ══════════════════════════════════════════════

async function runViaCLI(
  userMessage: string,
  conversationHistory: readonly MessageParam[],
): Promise<string> {
  const systemPrompt = await buildSystemPrompt();
  const context = buildConversationContext(conversationHistory);

  const fullPrompt = escapeForHeredoc(
    systemPrompt + context + "\n\n---\n\n# Current Message from Jeet\n\n" + userMessage,
  );

  const command = [
    "claude", "-p",
    "--model", MODEL,
    "--dangerously-skip-permissions",
    "--mcp-config", MCP_CONFIG,
    "--no-session-persistence",
    `<<'JARVIS_EOF'\n${fullPrompt}\nJARVIS_EOF`,
  ].join(" ");

  log.info(`CLI agent: ${userMessage.slice(0, 80)}...`);

  // Strip ANTHROPIC_API_KEY so the CLI uses the Max subscription, not API credits
  const cliEnv = { ...process.env } as Record<string, string | undefined>;
  delete cliEnv["ANTHROPIC_API_KEY"];

  const result = await shellExec(command, PROJECT_ROOT, CLI_TIMEOUT, cliEnv);

  if (result.startsWith("ERROR")) {
    throw new Error(`CLI failed: ${result.slice(0, 300)}`);
  }

  log.info(`CLI response: ${result.length} chars`);
  await appendDailyLog(
    `[${new Date().toISOString()}] Agent response (CLI): ${result.slice(0, 100)}...`,
  );
  await emit("agent", "response", { backend: "cli" });

  return result;
}

// ══════════════════════════════════════════════
// Fallback path: Anthropic API (metered)
// ══════════════════════════════════════════════

let apiClient: Anthropic | null = null;

function getApiClient(): Anthropic {
  if (!apiClient) {
    apiClient = new Anthropic();
  }
  return apiClient;
}

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

async function callWithRetry(
  fn: () => Promise<Anthropic.Message>,
): Promise<Anthropic.Message> {
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

function extractTextContent(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function hasToolUse(content: readonly ContentBlock[]): boolean {
  return content.some((b) => b.type === "tool_use");
}

function getToolUseBlocks(content: readonly ContentBlock[]): Anthropic.ToolUseBlock[] {
  return content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
}

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

async function runViaAPI(
  userMessage: string | Anthropic.MessageCreateParams["messages"][0]["content"],
  conversationHistory: MessageParam[],
  onProgress?: ProgressCallback,
): Promise<string> {
  const anthropic = getApiClient();
  const systemPrompt = await buildSystemPrompt();

  const messages: MessageParam[] = [
    ...pruneMessages(conversationHistory),
    { role: "user", content: userMessage },
  ];

  let iterations = 0;
  let totalToolCalls = 0;
  let progressSent = false;
  const toolCallCounts = new Map<string, number>();

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await callWithRetry(() =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        tools: TOOL_DEFINITIONS as Anthropic.Tool[],
        messages,
      }),
    );

    if (!hasToolUse(response.content)) {
      const text = extractTextContent(response.content);
      log.info(`API response: ${iterations} iterations, ${totalToolCalls} tool calls`);
      await appendDailyLog(
        `[${new Date().toISOString()}] Agent response (API fallback, ${iterations} iters, ${totalToolCalls} tools): ${text.slice(0, 100)}...`,
      );
      await emit("agent", "response", { backend: "api", iterations, toolCalls: totalToolCalls });
      return text || "(no response)";
    }

    messages.push({ role: "assistant", content: response.content as ContentBlock[] });
    const toolBlocks = getToolUseBlocks(response.content);

    let loopDetected = false;
    for (const tool of toolBlocks) {
      const hash = hashToolCall(tool.name, tool.input as Record<string, unknown>);
      const count = (toolCallCounts.get(hash) ?? 0) + 1;
      toolCallCounts.set(hash, count);
      if (count >= TOOL_LOOP_THRESHOLD) loopDetected = true;
    }

    if (loopDetected) {
      messages.push({
        role: "user",
        content: toolBlocks.map((t) => ({
          type: "tool_result" as const,
          tool_use_id: t.id,
          content: "LOOP DETECTED: Try a different approach.",
        })),
      });
    } else {
      const results: ToolResultBlockParam[] = [];
      for (const tool of toolBlocks) {
        // Report which tool is running
        if (onProgress) {
          const toolLabel = tool.name.replace(/_/g, " ");
          await onProgress(`Using ${toolLabel}...`).catch(() => {});
        }
        const result = await executeTool(tool.name, tool.input as Record<string, unknown>);
        results.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: buildToolResultContent(tool.name, result),
        });
      }
      messages.push({ role: "user", content: results });
    }

    totalToolCalls += toolBlocks.length;
  }

  return `Hit tool call limit (${MAX_ITERATIONS} iterations). Try breaking the task into smaller pieces.`;
}

// ══════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════

/**
 * Run the agent. Primary path is Claude Code CLI (free on Max plan).
 * Falls back to Anthropic API if CLI fails or if content is multimodal.
 */
export async function runAgent(
  userMessage: string | Anthropic.MessageCreateParams["messages"][0]["content"],
  conversationHistory: MessageParam[],
  onProgress?: ProgressCallback,
): Promise<string> {
  // Multimodal content (images) must go through API — CLI is text-only
  if (typeof userMessage !== "string") {
    log.info("Multimodal input — using API fallback");
    return runViaAPI(userMessage, conversationHistory, onProgress);
  }

  // Try CLI first (free)
  try {
    return await runViaCLI(userMessage, conversationHistory);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`CLI failed, falling back to API: ${msg.slice(0, 100)}`);

    // Fall back to API
    return runViaAPI(userMessage, conversationHistory, onProgress);
  }
}
