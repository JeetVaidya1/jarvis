/**
 * Chat commands — slash commands that bypass the LLM.
 * Adapted from OpenClaw's command dispatch pattern.
 *
 * /status  — system status
 * /reset   — clear conversation history
 * /compact — force context compaction
 * /history — conversation stats
 * /help    — list available commands
 * /jobs    — list sub-agents and programs
 */

import { createLogger } from "./logger.js";
import { listSubAgents, sweepSubAgents } from "./subagent.js";
import { listPrograms } from "./programs.js";
import {
  startTradingLoop,
  stopTradingLoop,
  isEngineRunning,
  getTradeHistory,
  DEFAULT_CONFIG,
  getBalance,
} from "./trading/index.js";
import { saveSession } from "./session.js";
import { appendDailyLog } from "./memory.js";
import { emit } from "./events.js";
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.MessageParam;

const log = createLogger("commands");

export interface CommandResult {
  handled: boolean;
  reply?: string;
  clearHistory?: boolean;
  cancelAgent?: boolean;
}

type CommandHandler = (
  args: string,
  history: MessageParam[],
) => Promise<CommandResult> | CommandResult;

const commands = new Map<string, CommandHandler>();

// ── /status ──
commands.set("/status", () => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  const memUsage = process.memoryUsage();
  const heapMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
  const rssMB = (memUsage.rss / 1024 / 1024).toFixed(1);

  const subAgents = listSubAgents();
  const running = subAgents.filter((s) => s.status === "running").length;
  const programs = listPrograms();

  return {
    handled: true,
    reply: [
      `**Jarvis Status**`,
      "",
      `**Uptime**: ${hours}h ${mins}m`,
      `**Memory**: ${heapMB}MB heap / ${rssMB}MB RSS`,
      `**Node**: ${process.version}`,
      `**Sub-agents**: ${running} running / ${subAgents.length} total`,
      `**Programs**: ${programs.length} active`,
      `**PID**: ${process.pid}`,
    ].join("\n"),
  };
});

// ── /reset ──
commands.set("/reset", async (_args, _history) => {
  log.info("Conversation history reset by user command");
  await appendDailyLog(`[${new Date().toISOString()}] Conversation reset by /reset command`);
  await emit("session", "reset", {});

  // Clear session file
  await saveSession([]);

  return {
    handled: true,
    reply: "Conversation history cleared. Starting fresh.",
    clearHistory: true,
  };
});

// ── /compact ──
commands.set("/compact", async (_args, history) => {
  if (history.length === 0) {
    return { handled: true, reply: "Nothing to compact — history is empty." };
  }

  // Trigger memory flush
  const { memoryUpdate } = await import("./tools/memory-tool.js");

  // Build a summary of current conversation
  const textParts: string[] = [];
  for (const msg of history.slice(-10)) {
    if (typeof msg.content === "string") {
      textParts.push(`${msg.role}: ${msg.content.slice(0, 200)}`);
    }
  }

  if (textParts.length > 0) {
    const summary = `[Compact] Conversation context saved (${history.length} messages). Recent topics: ${textParts.slice(-3).join("; ").slice(0, 500)}`;
    await memoryUpdate(summary, "append");
  }

  await appendDailyLog(`[${new Date().toISOString()}] Context compacted by /compact command (${history.length} messages)`);

  return {
    handled: true,
    reply: `Compacted ${history.length} messages. Key context saved to memory. History cleared.`,
    clearHistory: true,
  };
});

// ── /history ──
commands.set("/history", (_args, history) => {
  if (history.length === 0) {
    return { handled: true, reply: "No conversation history." };
  }

  const userMsgs = history.filter((m) => m.role === "user").length;
  const asstMsgs = history.filter((m) => m.role === "assistant").length;
  const totalChars = JSON.stringify(history).length;
  const estimatedTokens = Math.round(totalChars / 4);

  return {
    handled: true,
    reply: [
      `**Conversation History**`,
      "",
      `**Messages**: ${history.length} (${userMsgs} user, ${asstMsgs} assistant)`,
      `**Size**: ~${(totalChars / 1024).toFixed(1)}KB (~${estimatedTokens.toLocaleString()} tokens)`,
      `**Context usage**: ~${((estimatedTokens / 200_000) * 100).toFixed(1)}% of window`,
    ].join("\n"),
  };
});

// ── /jobs ──
commands.set("/jobs", () => {
  const subAgents = listSubAgents();
  const programs = listPrograms();

  sweepSubAgents();

  const lines: string[] = ["**Active Jobs**", ""];

  if (programs.length > 0) {
    lines.push("**Programs:**");
    for (const p of programs) {
      lines.push(`  • ${p.name} — \`${p.schedule}\` ${p.enabled ? "✓" : "✗"}`);
    }
    lines.push("");
  }

  if (subAgents.length > 0) {
    lines.push("**Sub-agents:**");
    for (const s of subAgents.slice(0, 10)) {
      const duration = s.completedAt
        ? `${((s.completedAt - s.createdAt) / 1000).toFixed(1)}s`
        : `${((Date.now() - s.createdAt) / 1000).toFixed(0)}s...`;
      lines.push(`  • [${s.id}] ${s.label} — ${s.status} (${duration})`);
    }
  }

  if (programs.length === 0 && subAgents.length === 0) {
    lines.push("No active jobs.");
  }

  return { handled: true, reply: lines.join("\n") };
});

// ── /trade ──
commands.set("/trade", async (args) => {
  const subcommand = args.split(" ")[0]?.toLowerCase() ?? "";

  if (subcommand === "start") {
    if (isEngineRunning()) {
      return { handled: true, reply: "Trading engine is already running." };
    }

    const balance = await getBalance();

    // Parse optional config from args: /trade start maxTrade=10 minEdge=5
    const config = { ...DEFAULT_CONFIG, dryRun: false };
    const argParts = args.split(" ").slice(1);
    for (const part of argParts) {
      const [k, v] = part.split("=");
      if (k === "maxTrade" && v) config.maxTradeSize = parseFloat(v);
      if (k === "maxTotal" && v) config.maxTotalDeployed = parseFloat(v);
      if (k === "minEdge" && v) config.minEdge = parseFloat(v) / 100;
      if (k === "dryRun" && v) config.dryRun = v === "true";
    }

    // Store onUpdate callback reference for later use
    // The trading loop will be started from bot.ts which has ctx access
    return {
      handled: true,
      reply: [
        `**Starting Trading Engine**`,
        "",
        `Balance: $${balance.toFixed(2)} USDC`,
        `Max per trade: $${config.maxTradeSize}`,
        `Max total deployed: $${config.maxTotalDeployed}`,
        `Min edge: ${(config.minEdge * 100).toFixed(0)}%`,
        `Kelly fraction: ${config.kellyFraction}`,
        `Fast markets: ${config.enableFastMarkets ? "YES" : "NO"}`,
        `Dry run: ${config.dryRun ? "YES (simulation)" : "NO (LIVE)"}`,
        `Cycle: every ${config.cycleSleepMs / 1000}s`,
        "",
        `Engine starting now...`,
      ].join("\n"),
      startTrading: config,
    } as CommandResult & { startTrading: typeof config };
  }

  if (subcommand === "stop") {
    if (!isEngineRunning()) {
      return { handled: true, reply: "Trading engine is not running." };
    }
    stopTradingLoop();
    return { handled: true, reply: "Trading engine stopping after current cycle..." };
  }

  if (subcommand === "status") {
    const running = isEngineRunning();
    const history = getTradeHistory();
    const balance = await getBalance();
    const wins = history.filter((t) => t.status === "placed").length;
    const sims = history.filter((t) => t.status === "simulated").length;

    return {
      handled: true,
      reply: [
        `**Trading Engine ${running ? "RUNNING" : "STOPPED"}**`,
        "",
        `Balance: $${balance.toFixed(2)} USDC`,
        `Trades placed: ${wins}`,
        `Simulations: ${sims}`,
        `Total evaluated: ${history.length}`,
        "",
        history.slice(-5).map((t) =>
          `${t.status === "placed" ? "✓" : t.status === "simulated" ? "~" : "✗"} ${t.side} ${t.market.slice(0, 35)} | $${t.size.toFixed(2)} | Edge: ${(t.edge * 100).toFixed(1)}%`
        ).join("\n") || "No trades yet",
      ].join("\n"),
    };
  }

  // Default: show usage
  return {
    handled: true,
    reply: [
      "**Trading Commands**",
      "",
      "`/trade start` — Start autonomous trading (LIVE)",
      "`/trade start dryRun=true` — Start in simulation mode",
      "`/trade start maxTrade=5 minEdge=4` — Custom config",
      "`/trade stop` — Stop trading",
      "`/trade status` — Show engine status and recent trades",
    ].join("\n"),
  };
});

// ── /cancel ──
commands.set("/cancel", () => ({
  handled: true,
  cancelAgent: true,
}));

// ── /help ──
commands.set("/help", () => ({
  handled: true,
  reply: [
    "**Jarvis Commands**",
    "",
    "`/status` — System status (uptime, memory, jobs)",
    "`/cancel` — Cancel the current agent task",
    "`/reset` — Clear conversation history",
    "`/compact` — Save context to memory and clear history",
    "`/history` — Conversation stats and token usage",
    "`/jobs` — List programs and sub-agents",
    "`/trade start` — Start autonomous trading engine",
    "`/trade stop` — Stop trading engine",
    "`/trade status` — Trading status and history",
    "`/help` — This help message",
    "",
    "Everything else goes to the AI agent.",
  ].join("\n"),
}));

// ── Dispatcher ──

export async function handleCommand(
  text: string,
  history: MessageParam[] = [],
): Promise<CommandResult> {
  const trimmed = text.trim();

  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  const handler = commands.get(command);
  if (!handler) {
    return { handled: false }; // Unknown command — pass to agent
  }

  log.info(`Command: ${command} ${args}`);
  return handler(args, history);
}
