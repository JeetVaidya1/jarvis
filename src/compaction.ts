/**
 * Context compaction — smart pruning of conversation history.
 * Adapted from OpenClaw's context-pruning extension.
 *
 * Two phases:
 * 1. Soft trim: truncate large tool results (keep head + tail)
 * 2. Hard clear: replace old tool results with placeholder
 *
 * Preserves the last N assistant messages and never touches
 * messages before the first user message.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "./logger.js";

type MessageParam = Anthropic.MessageParam;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

const log = createLogger("compaction");

// Config
const SOFT_TRIM_RATIO = 0.3;   // Trigger soft trim at 30% of context window
const HARD_CLEAR_RATIO = 0.5;  // Hard clear at 50%
const CONTEXT_WINDOW = 200_000; // Claude's context window in tokens
const CHARS_PER_TOKEN = 4;
const KEEP_LAST_ASSISTANTS = 3;
const MIN_PRUNABLE_CHARS = 5_000;
const SOFT_TRIM_HEAD = 1_500;
const SOFT_TRIM_TAIL = 1_500;
const SOFT_TRIM_MAX = 4_000;

function estimateTokens(messages: readonly MessageParam[]): number {
  const chars = JSON.stringify(messages).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function getContextRatio(messages: readonly MessageParam[]): number {
  return estimateTokens(messages) / CONTEXT_WINDOW;
}

/**
 * Find the index of the last N assistant messages.
 * Messages at or after this index are protected from pruning.
 */
function findProtectedCutoff(messages: readonly MessageParam[]): number {
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      assistantCount++;
      if (assistantCount >= KEEP_LAST_ASSISTANTS) {
        return i;
      }
    }
  }
  return 0;
}

/**
 * Extract text from a tool result content block.
 */
function getToolResultText(content: ToolResultBlockParam["content"]): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  return content
    .filter((c): c is Anthropic.TextBlockParam =>
      typeof c === "object" && "type" in c && c.type === "text",
    )
    .map((c) => c.text)
    .join("\n");
}

/**
 * Soft trim a text: keep head + tail, replace middle.
 */
function softTrimText(text: string): string {
  if (text.length <= SOFT_TRIM_MAX) return text;

  const head = text.slice(0, SOFT_TRIM_HEAD);
  const tail = text.slice(-SOFT_TRIM_TAIL);
  const removedChars = text.length - SOFT_TRIM_HEAD - SOFT_TRIM_TAIL;

  return `${head}\n\n[... ${removedChars} chars trimmed ...]\n\n${tail}`;
}

/**
 * Prune conversation messages to fit within context budget.
 * Returns a new array — never mutates the input.
 */
export function pruneMessages(messages: readonly MessageParam[]): MessageParam[] {
  const ratio = getContextRatio(messages);

  // No pruning needed
  if (ratio < SOFT_TRIM_RATIO) {
    return [...messages];
  }

  log.info(`Context at ${(ratio * 100).toFixed(0)}% — pruning`);

  const protectedIdx = findProtectedCutoff(messages);
  const result: MessageParam[] = [];

  // Phase 1: Soft trim large tool results
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    // Protected zone — keep as-is
    if (i >= protectedIdx) {
      result.push(msg);
      continue;
    }

    // Only prune user messages with tool results
    if (msg.role !== "user" || !Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    const prunedContent = msg.content.map((block) => {
      if (
        typeof block !== "object" ||
        !("type" in block) ||
        block.type !== "tool_result"
      ) {
        return block;
      }

      const toolResult = block as ToolResultBlockParam;

      // Remove images
      if (Array.isArray(toolResult.content)) {
        const filtered = toolResult.content.filter(
          (c) => !(typeof c === "object" && "type" in c && c.type === "image"),
        );

        if (filtered.length === 0) {
          return { ...toolResult, content: "[image removed during compaction]" };
        }

        // Soft trim text blocks
        const trimmed = filtered.map((c) => {
          if (typeof c === "object" && "type" in c && c.type === "text") {
            const textBlock = c as Anthropic.TextBlockParam;
            if (textBlock.text.length > MIN_PRUNABLE_CHARS) {
              return { ...textBlock, text: softTrimText(textBlock.text) };
            }
          }
          return c;
        });

        return { ...toolResult, content: trimmed };
      }

      // String content
      if (typeof toolResult.content === "string" && toolResult.content.length > MIN_PRUNABLE_CHARS) {
        return { ...toolResult, content: softTrimText(toolResult.content) };
      }

      return toolResult;
    });

    result.push({ ...msg, content: prunedContent });
  }

  // Phase 2: Hard clear if still over budget
  const afterSoftRatio = getContextRatio(result);

  if (afterSoftRatio >= HARD_CLEAR_RATIO) {
    log.info(`Still at ${(afterSoftRatio * 100).toFixed(0)}% after soft trim — hard clearing`);

    for (let i = 0; i < protectedIdx && i < result.length; i++) {
      const msg = result[i];
      if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) continue;

      const cleared = msg.content.map((block) => {
        if (
          typeof block === "object" &&
          "type" in block &&
          block.type === "tool_result"
        ) {
          return { ...block, content: "[old tool result cleared]" };
        }
        return block;
      });

      result[i] = { ...msg, content: cleared };

      // Check if we're below threshold now
      if (getContextRatio(result) < SOFT_TRIM_RATIO) break;
    }
  }

  const finalRatio = getContextRatio(result);
  log.info(`Compaction complete: ${(ratio * 100).toFixed(0)}% → ${(finalRatio * 100).toFixed(0)}%`);

  return result;
}
