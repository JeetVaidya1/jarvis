import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "./logger.js";

type MessageParam = Anthropic.MessageParam;

const log = createLogger("session");

const SESSION_DIR = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "sessions",
);
const SESSION_FILE = join(SESSION_DIR, "current.json");
const MAX_PERSISTED_MESSAGES = 40;

/**
 * Load conversation history from disk.
 * Returns empty array if no session file exists.
 */
export async function loadSession(): Promise<MessageParam[]> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    const data = JSON.parse(content) as MessageParam[];

    if (!Array.isArray(data)) {
      log.warn("Session file is not an array — starting fresh");
      return [];
    }

    log.info(`Restored ${data.length} messages from session`);
    return data;
  } catch {
    // File doesn't exist or is corrupt — start fresh
    return [];
  }
}

/**
 * Save conversation history to disk.
 * Only keeps the most recent MAX_PERSISTED_MESSAGES messages.
 */
export async function saveSession(
  history: readonly MessageParam[],
): Promise<void> {
  try {
    await mkdir(SESSION_DIR, { recursive: true });

    // Keep only recent messages to avoid unbounded growth
    const toSave = history.slice(-MAX_PERSISTED_MESSAGES);

    // Strip base64 images from persisted data (they're huge and not needed for context)
    const cleaned = toSave.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

      const cleanedContent = msg.content.map((block) => {
        if (
          typeof block === "object" &&
          "type" in block &&
          block.type === "tool_result"
        ) {
          const toolResult = block as Anthropic.ToolResultBlockParam;
          if (Array.isArray(toolResult.content)) {
            const filtered = toolResult.content.filter(
              (c) =>
                !(
                  typeof c === "object" &&
                  "type" in c &&
                  c.type === "image"
                ),
            );
            return { ...toolResult, content: filtered.length > 0 ? filtered : "(image removed from session)" };
          }
        }
        return block;
      });

      return { ...msg, content: cleanedContent };
    });

    await writeFile(SESSION_FILE, JSON.stringify(cleaned, null, 2), "utf-8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Failed to save session: ${msg}`);
  }
}
