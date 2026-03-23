import { Bot, Context } from "grammy";
import { runAgent } from "./agent.js";
import { loadSession, saveSession } from "./session.js";
import { createLogger } from "./logger.js";
import { handleCommand } from "./commands.js";
import { startTradingLoop, type TradingConfig } from "./trading/index.js";
import { processPhoto, processVoice, processDocument } from "./media.js";
import { expandLinks } from "./links.js";
import { emit } from "./events.js";
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.MessageParam;

const log = createLogger("bot");

const MAX_HISTORY = 20;
const MAX_MESSAGE_LENGTH = 10_000;

let conversationHistory: MessageParam[] = [];

function trimHistory(): void {
  while (conversationHistory.length > MAX_HISTORY * 2) {
    conversationHistory.splice(0, 2);
  }
}

function isAllowedUser(ctx: Context): boolean {
  const allowedId = process.env["TELEGRAM_ALLOWED_USER_ID"];
  if (!allowedId) return false;
  const senderId = ctx.from?.id?.toString();
  return senderId === allowedId;
}

export async function initBot(): Promise<void> {
  conversationHistory = await loadSession();
  trimHistory();
}

export function clearHistory(): void {
  conversationHistory.length = 0;
}

async function handleAgentResponse(
  ctx: Context,
  userContent: string | Anthropic.MessageCreateParams["messages"][0]["content"],
  onProgress: (msg: string) => Promise<void>,
): Promise<void> {
  // Build user message — handle both text and multimodal
  const userText = typeof userContent === "string" ? userContent : "[media message]";

  const response = await runAgent(
    userContent,
    conversationHistory,
    onProgress,
  );

  // Update and persist conversation history
  conversationHistory.push(
    { role: "user", content: userContent },
    { role: "assistant", content: response },
  );
  trimHistory();
  saveSession(conversationHistory).catch((err) => {
    log.error(`Session save failed: ${err}`);
  });

  await emit("message", "sent", { preview: response.slice(0, 100) });

  // Send response
  await sendResponse(ctx, response);
}

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

    // Input validation
    if (userText.length > MAX_MESSAGE_LENGTH) {
      log.warn(`Message truncated: ${userText.length} -> ${MAX_MESSAGE_LENGTH}`);
      userText = userText.slice(0, MAX_MESSAGE_LENGTH) +
        "\n\n(message truncated — original was " + ctx.message.text.length + " chars)";
    }

    await emit("message", "received", { type: "text", length: userText.length });

    // Check for slash commands first (bypass LLM)
    const cmdResult = await handleCommand(userText, conversationHistory) as unknown as Record<string, unknown>;
    if (cmdResult.handled) {
      if (cmdResult.clearHistory) {
        clearHistory();
      }
      if (cmdResult.reply) {
        await sendResponse(ctx, cmdResult.reply as string);
      }
      // Handle /trade start — kick off the trading loop with Telegram callback
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
      return;
    }

    try {
      // Send immediate acknowledgment so Jeet knows it's working
      const thinkingMsg = await ctx.reply("Thinking...").catch(() => null);

      await ctx.replyWithChatAction("typing");
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4_000);

      const onProgress = async (msg: string) => {
        await ctx.reply(msg).catch(() => {});
      };

      // Auto-expand links in the message
      const linkContent = await expandLinks(userText);
      const enrichedText = linkContent ? userText + linkContent : userText;

      await handleAgentResponse(ctx, enrichedText, onProgress);

      clearInterval(typingInterval);

      // Delete the "Thinking..." message now that we've responded
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

      // Build multimodal message content
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

      const onProgress = async (msg: string) => {
        await ctx.reply(msg).catch(() => {});
      };

      await handleAgentResponse(ctx, content, onProgress);
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

      const onProgress = async (msg: string) => {
        await ctx.reply(msg).catch(() => {});
      };

      await handleAgentResponse(ctx, media.text, onProgress);
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

      const onProgress = async (msg: string) => {
        await ctx.reply(msg).catch(() => {});
      };

      await handleAgentResponse(ctx, media.text, onProgress);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Document handler error: ${msg}`);
      await ctx.reply(`Error processing document: ${msg.slice(0, 200)}`);
    }
  });

  bot.catch((err) => {
    log.error(`Bot error: ${err.message}`);
  });

  return bot;
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

export function getConversationHistory(): readonly MessageParam[] {
  return conversationHistory;
}
