#!/usr/bin/env node
/**
 * MCP server exposing Jarvis's custom tools to Claude Code CLI.
 * Runs over stdio — Claude Code spawns this as a subprocess.
 *
 * This gives Claude Code access to tools it doesn't have natively:
 * Polymarket, memory, browser, GitHub, price checks, sub-agents.
 *
 * Claude Code already has: Read, Write, Edit, Bash, Glob, Grep,
 * WebSearch, WebFetch — so we don't expose those here.
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { memoryUpdate } from "./tools/memory-tool.js";
import { loadMemory, loadDailyLog } from "./memory.js";
import { webGetPrice } from "./tools/websearch.js";
import {
  browserNavigate,
  browserScreenshot,
  browserClick,
  browserType,
  browserGetContent,
  browserWait,
  browserEvaluate,
  browserClose,
} from "./tools/browser.js";
import {
  polymarketGetPositions,
  polymarketSearch,
  polymarketGetActiveMarkets,
  polymarketGetMarket,
  polymarketGetOrderbook,
  polymarketPlaceOrder,
  polymarketCancelOrder,
  polymarketGetPortfolioSummary,
  polymarketGetTrades,
  polymarketGetTags,
} from "./tools/polymarket.js";
import type { PlaceOrderParams } from "./tools/polymarket.js";
import {
  githubStatus,
  githubGetPrs,
  githubCreateIssue,
  githubGetCommits,
  githubRunWorkflow,
} from "./tools/github.js";

const server = new McpServer({
  name: "jarvis-tools",
  version: "1.0.0",
});

// ── Memory tools ──

server.tool(
  "jarvis_memory_read",
  "Read Jarvis's long-term memory (MEMORY.md) and today's daily log.",
  {},
  async () => {
    const [memory, dailyLog] = await Promise.all([loadMemory(), loadDailyLog()]);
    return {
      content: [{
        type: "text" as const,
        text: `# Memory\n${memory || "(empty)"}\n\n# Today's Log\n${dailyLog || "(empty)"}`,
      }],
    };
  },
);

server.tool(
  "jarvis_memory_update",
  "Update Jarvis's long-term memory. Use 'append' to add, 'overwrite' to replace.",
  { content: z.string(), mode: z.enum(["append", "overwrite"]) },
  async ({ content, mode }) => ({
    content: [{ type: "text" as const, text: await memoryUpdate(content, mode) }],
  }),
);

// ── Price tool ──

server.tool(
  "jarvis_get_price",
  "Get current price for crypto (BTC, ETH, SOL) or stocks (AAPL, TSLA).",
  { asset: z.string() },
  async ({ asset }) => ({
    content: [{ type: "text" as const, text: await webGetPrice(asset) }],
  }),
);

// ── Browser tools ──

server.tool(
  "jarvis_browser_navigate",
  "Navigate headless Chrome to a URL.",
  { url: z.string() },
  async ({ url }) => ({
    content: [{ type: "text" as const, text: await browserNavigate(url) }],
  }),
);

server.tool(
  "jarvis_browser_screenshot",
  "Take a screenshot of the current browser page.",
  {},
  async () => {
    const result = await browserScreenshot();
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text" as const, text: result.text },
    ];
    if (result.base64) {
      content.push({ type: "image" as const, data: result.base64, mimeType: "image/png" });
    }
    return { content };
  },
);

server.tool(
  "jarvis_browser_click",
  "Click an element by CSS selector or description.",
  { target: z.string() },
  async ({ target }) => ({
    content: [{ type: "text" as const, text: await browserClick(target) }],
  }),
);

server.tool(
  "jarvis_browser_type",
  "Type text into an input field.",
  { target: z.string(), text: z.string() },
  async ({ target, text }) => ({
    content: [{ type: "text" as const, text: await browserType(target, text) }],
  }),
);

server.tool(
  "jarvis_browser_content",
  "Get readable text content of current page.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await browserGetContent() }],
  }),
);

server.tool(
  "jarvis_browser_wait",
  "Wait for milliseconds (max 10000).",
  { ms: z.number() },
  async ({ ms }) => ({
    content: [{ type: "text" as const, text: await browserWait(ms) }],
  }),
);

server.tool(
  "jarvis_browser_eval",
  "Execute JavaScript on the current page.",
  { script: z.string() },
  async ({ script }) => ({
    content: [{ type: "text" as const, text: await browserEvaluate(script) }],
  }),
);

server.tool(
  "jarvis_browser_close",
  "Close the browser.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await browserClose() }],
  }),
);

// ── Polymarket tools ──

server.tool(
  "jarvis_polymarket_positions",
  "Get all open Polymarket positions with P&L.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await polymarketGetPositions() }],
  }),
);

server.tool(
  "jarvis_polymarket_search",
  "Search Polymarket markets by keyword.",
  { query: z.string() },
  async ({ query }) => ({
    content: [{ type: "text" as const, text: await polymarketSearch(query) }],
  }),
);

server.tool(
  "jarvis_polymarket_active_markets",
  "Get active markets by category or timeframe.",
  { category: z.string().optional(), timeframe: z.string().optional() },
  async ({ category, timeframe }) => ({
    content: [{ type: "text" as const, text: await polymarketGetActiveMarkets(category, timeframe) }],
  }),
);

server.tool(
  "jarvis_polymarket_market",
  "Get detailed info on a specific market.",
  { condition_id: z.string() },
  async ({ condition_id }) => ({
    content: [{ type: "text" as const, text: await polymarketGetMarket(condition_id) }],
  }),
);

server.tool(
  "jarvis_polymarket_orderbook",
  "Get order book for a market token.",
  { token_id: z.string() },
  async ({ token_id }) => ({
    content: [{ type: "text" as const, text: await polymarketGetOrderbook(token_id) }],
  }),
);

server.tool(
  "jarvis_polymarket_place_order",
  "Place a Polymarket order. ALWAYS set dry_run:true first.",
  {
    condition_id: z.string(),
    side: z.enum(["YES", "NO"]),
    size: z.number(),
    price: z.number().optional(),
    order_type: z.enum(["MARKET", "LIMIT"]),
    dry_run: z.boolean(),
  },
  async (params) => {
    const orderParams: PlaceOrderParams = {
      conditionId: params.condition_id,
      side: params.side,
      size: params.size,
      price: params.price,
      orderType: params.order_type,
      dryRun: params.dry_run,
    };
    return {
      content: [{ type: "text" as const, text: await polymarketPlaceOrder(orderParams) }],
    };
  },
);

server.tool(
  "jarvis_polymarket_cancel_order",
  "Cancel an open order.",
  { order_id: z.string() },
  async ({ order_id }) => ({
    content: [{ type: "text" as const, text: await polymarketCancelOrder(order_id) }],
  }),
);

server.tool(
  "jarvis_polymarket_portfolio",
  "Get portfolio summary.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await polymarketGetPortfolioSummary() }],
  }),
);

server.tool(
  "jarvis_polymarket_trades",
  "Get recent trade history.",
  { market: z.string().optional() },
  async ({ market }) => ({
    content: [{ type: "text" as const, text: await polymarketGetTrades(market) }],
  }),
);

server.tool(
  "jarvis_polymarket_tags",
  "Get all market tags with IDs.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await polymarketGetTags() }],
  }),
);

// ── GitHub tools ──

server.tool(
  "jarvis_github_status",
  "Get repo status or list all repos.",
  { repo: z.string().optional() },
  async ({ repo }) => ({
    content: [{ type: "text" as const, text: await githubStatus(repo) }],
  }),
);

server.tool(
  "jarvis_github_prs",
  "List open pull requests.",
  { repo: z.string() },
  async ({ repo }) => ({
    content: [{ type: "text" as const, text: await githubGetPrs(repo) }],
  }),
);

server.tool(
  "jarvis_github_create_issue",
  "Create a GitHub issue.",
  { repo: z.string(), title: z.string(), body: z.string() },
  async ({ repo, title, body }) => ({
    content: [{ type: "text" as const, text: await githubCreateIssue(repo, title, body) }],
  }),
);

server.tool(
  "jarvis_github_commits",
  "Get recent commits.",
  { repo: z.string(), limit: z.number().optional() },
  async ({ repo, limit }) => ({
    content: [{ type: "text" as const, text: await githubGetCommits(repo, limit) }],
  }),
);

server.tool(
  "jarvis_github_run_workflow",
  "Trigger a GitHub Actions workflow.",
  { repo: z.string(), workflow_id: z.string() },
  async ({ repo, workflow_id }) => ({
    content: [{ type: "text" as const, text: await githubRunWorkflow(repo, workflow_id) }],
  }),
);

// ── Start server ──

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
