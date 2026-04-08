/**
 * Telegram bot — channel adapter that routes messages through the gateway.
 *
 * The bot is a thin translation layer: Telegram messages → gateway, and
 * runtime events → Telegram replies. The gateway owns agent sessions.
 */

import { Bot, Context } from "grammy";
import { handleMessage, restoreSessions, cancelCurrentSession } from "./gateway/index.js";
import { broadcastRuntimeEvent } from "./gateway/index.js";
import { handleCommand } from "./commands.js";
import { startTradingLoop, type TradingConfig } from "./trading/index.js";
import { processPhoto, processVoice, processDocument } from "./media.js";
import { expandLinks } from "./links.js";
import { emit } from "./events.js";
import { createLogger } from "./logger.js";
import { broadcastAgentToken, broadcastAgentStatus, broadcastAgentComplete } from "./dashboard.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { RuntimeEvent } from "./runtime/types.js";

const log = createLogger("bot");

const MAX_MESSAGE_LENGTH = 10_000;
const CHANNEL_TYPE = "telegram";
const CHANNEL_ID = "default";

function isAllowedUser(ctx: Context): boolean {
  const allowedId = process.env["TELEGRAM_ALLOWED_USER_ID"];
  if (!allowedId) return false;
  return ctx.from?.id?.toString() === allowedId;
}

// ── Response Sending ──

async function sendResponse(ctx: Context, response: string): Promise<void> {
  if (response.length <= 4096) {
    await ctx.reply(response, { parse_mode: "Markdown" }).catch(async () => {
      await ctx.reply(response);
    });
  } else {
    const chunks = splitMessage(response, 4096);
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(async () => {
        await ctx.reply(chunk);
      });
    }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n", maxLen);
    if (splitIndex === -1 || splitIndex < maxLen * 0.5) {
      splitIndex = maxLen;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  return chunks;
}

// ── Agent Response Handler ──

async function handleAgentResponse(
  ctx: Context,
  userContent: string | Anthropic.MessageCreateParams["messages"][0]["content"],
): Promise<void> {
  const sessionId = `telegram-${CHANNEL_ID}`;

  // Build event handler that translates runtime events → Telegram + Dashboard
  const onEvent = (event: RuntimeEvent) => {
    // Broadcast through WebSocket gateway for WS clients
    broadcastRuntimeEvent(sessionId, event);

    // Broadcast to dashboard via HTTP for SSE rendering
    switch (event.kind) {
      case "token":
        broadcastAgentToken(sessionId, event.text);
        break;
      case "tool_start": {
        const label = event.toolName.replace(/_/g, " ");
        broadcastAgentStatus(sessionId, "tool_call", event.toolName, event.toolInput);
        ctx.reply(`Using ${label}...`).catch(() => {});
        break;
      }
      case "tool_end":
        broadcastAgentStatus(sessionId, "tool_done", event.toolName);
        break;
      case "message_complete":
        broadcastAgentComplete(sessionId, event.text);
        break;
      case "error":
        log.error(`Runtime error: ${event.message}`);
        break;
    }
  };

  const result = await handleMessage(CHANNEL_TYPE, CHANNEL_ID, userContent, onEvent);

  await emit("message", "sent", { preview: result.response.slice(0, 100) });
  await sendResponse(ctx, result.response);
}

// ── Bot Initialization ──

export async function initBot(): Promise<void> {
  await restoreSessions();
}

export function createBot(): Bot {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }

  const bot = new Bot(token);

  // ── Text messages ──
  bot.on("message:text", async (ctx) => {
    if (!isAllowedUser(ctx)) return;

    let userText = ctx.message.text;

    if (userText.length > MAX_MESSAGE_LENGTH) {
      log.warn(`Message truncated: ${userText.length} -> ${MAX_MESSAGE_LENGTH}`);
      userText = userText.slice(0, MAX_MESSAGE_LENGTH) +
        "\n\n(message truncated — original was " + ctx.message.text.length + " chars)";
    }

    await emit("message", "received", { type: "text", length: userText.length });

    // Check for slash commands (bypass LLM)
    const cmdResult = await handleCommand(userText) as unknown as Record<string, unknown>;
    if (cmdResult.handled) {
      if (cmdResult.clearHistory) {
        // Session history is managed by gateway — no-op for now
      }
      if (cmdResult.reply) {
        await sendResponse(ctx, cmdResult.reply as string);
      }
      if (cmdResult.startTrading) {
        const tradingConfig = cmdResult.startTrading as TradingConfig;
        const onTradeUpdate = async (msg: string) => {
          await ctx.reply(msg).catch(() => {});
        };
        startTradingLoop(tradingConfig, onTradeUpdate).catch((err) => {
          log.error(`Trading loop crashed: ${err}`);
          ctx.reply(`Trading engine crashed: ${err}`).catch(() => {});
        });
      }
      if (cmdResult.cancelAgent) {
        const cancelled = cancelCurrentSession(CHANNEL_TYPE, CHANNEL_ID);
        await ctx.reply(cancelled ? "Cancelled." : "Nothing to cancel.");
      }
      return;
    }

    try {
      const thinkingMsg = await ctx.reply("Thinking...").catch(() => null);

      await ctx.replyWithChatAction("typing");
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4_000);

      const linkContent = await expandLinks(userText);
      const enrichedText = linkContent ? userText + linkContent : userText;

      await handleAgentResponse(ctx, enrichedText);

      clearInterval(typingInterval);

      if (thinkingMsg) {
        await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Agent error: ${msg}`);
      await ctx.reply(`Error: ${msg.slice(0, 500)}`);
    }
  });

  // ── Photo messages ──
  bot.on("message:photo", async (ctx) => {
    if (!isAllowedUser(ctx)) return;

    await emit("message", "received", { type: "photo" });

    try {
      await ctx.replyWithChatAction("typing");

      const media = await processPhoto(ctx);
      if (!media) {
        await ctx.reply("Couldn't process that photo.");
        return;
      }

      const content: Anthropic.MessageCreateParams["messages"][0]["content"] = [
        { type: "text", text: media.text },
      ];

      if (media.base64 && media.mimeType) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: media.mimeType as "image/jpeg",
            data: media.base64,
          },
        });
      }

      await handleAgentResponse(ctx, content);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Photo handler error: ${msg}`);
      await ctx.reply(`Error processing photo: ${msg.slice(0, 200)}`);
    }
  });

  // ── Voice messages ──
  bot.on(["message:voice", "message:audio"], async (ctx) => {
    if (!isAllowedUser(ctx)) return;

    await emit("message", "received", { type: "voice" });

    try {
      await ctx.replyWithChatAction("typing");

      const media = await processVoice(ctx);
      if (!media) {
        await ctx.reply("Couldn't process that voice message.");
        return;
      }

      await handleAgentResponse(ctx, media.text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Voice handler error: ${msg}`);
      await ctx.reply(`Error processing voice: ${msg.slice(0, 200)}`);
    }
  });

  // ── Document messages ──
  bot.on("message:document", async (ctx) => {
    if (!isAllowedUser(ctx)) return;

    await emit("message", "received", { type: "document" });

    try {
      await ctx.replyWithChatAction("typing");

      const media = await processDocument(ctx);
      if (!media) {
        await ctx.reply("Couldn't process that document.");
        return;
      }

      await handleAgentResponse(ctx, media.text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Document handler error: ${msg}`);
      await ctx.reply(`Error processing document: ${msg.slice(0, 200)}`);
    }
  });

  // Register commands with Telegram
  bot.api.setMyCommands([
    { command: "status", description: "System status (uptime, memory, jobs)" },
    { command: "help", description: "List all available commands" },
    { command: "jobs", description: "List programs and sub-agents" },
    { command: "history", description: "Conversation stats and token usage" },
    { command: "trade", description: "Trading engine (start/stop/status)" },
    { command: "cancel", description: "Cancel the current agent task" },
    { command: "reset", description: "Clear conversation history" },
    { command: "compact", description: "Save context to memory and clear history" },
  ]).catch((err) => {
    log.warn(`setMyCommands failed: ${err.message}`);
  });

  bot.catch((err) => {
    log.error(`Bot error: ${err.message}`);
  });

  return bot;
}
