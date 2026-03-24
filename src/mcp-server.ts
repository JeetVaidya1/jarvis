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
import { searchMemory } from "./memory-search.js";
import { webGetPrice } from "./tools/websearch.js";
import { newsHeadlines, newsSearch } from "./tools/news.js";
import { cryptoTrending, cryptoMarkets, cryptoCoinInfo, cryptoDefiTvl } from "./tools/coingecko.js";
import { stockOverview, stockEarnings, stockIncomeStatement, stockValuation } from "./tools/finance.js";
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
import {
  googleAuth,
  calendarToday,
  calendarUpcoming,
  gmailTriage,
  gmailSearch,
} from "./tools/google.js";
import {
  macScreenshot,
  macClick,
  macType,
  macKeyPress,
  macOpenApp,
  macGetFocusedApp,
  macRunScript,
} from "./tools/mac-computer.js";
import { sysGetStatus, sysGetProcesses, sysGetNetwork } from "./tools/system-monitor.js";
import {
  iMessageGetChats,
  iMessageGetMessages,
  iMessageSend,
  contactsSearch,
  remindersGet,
  remindersCreate,
  weatherGet,
} from "./tools/imcp.js";
import { reviewOutcomes, getPerformanceSummary } from "./trading/feedback.js";

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

server.tool(
  "jarvis_memory_search",
  "Search Jarvis memory by keywords. Returns relevant matches instead of entire memory dump.",
  { query: z.string(), max_results: z.number().optional() },
  async ({ query, max_results }) => ({
    content: [{ type: "text" as const, text: await searchMemory(query, max_results) }],
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

// ── Google Calendar + Gmail tools ──

server.tool(
  "jarvis_google_auth",
  "Start Google OAuth flow to connect Calendar and Gmail. Returns a URL to open in browser. Run once to authenticate.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await googleAuth() }],
  }),
);

server.tool(
  "jarvis_calendar_today",
  "Get today's calendar events (next 24 hours). Shows time, title, location, and Meet links.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await calendarToday() }],
  }),
);

server.tool(
  "jarvis_calendar_upcoming",
  "Get upcoming calendar events. Default: next 7 days.",
  { days: z.number().optional().describe("Number of days to look ahead (default 7)") },
  async ({ days }) => ({
    content: [{ type: "text" as const, text: await calendarUpcoming(days) }],
  }),
);

server.tool(
  "jarvis_gmail_triage",
  "Get unread emails from inbox with sender, subject, and preview. Use to surface action-required items.",
  { max_emails: z.number().optional().describe("Max emails to return (default 20)") },
  async ({ max_emails }) => ({
    content: [{ type: "text" as const, text: await gmailTriage(max_emails) }],
  }),
);

server.tool(
  "jarvis_gmail_search",
  "Search Gmail messages by query (same syntax as Gmail search bar).",
  {
    query: z.string().describe("Gmail search query, e.g. 'from:amazon.com' or 'subject:invoice'"),
    max_results: z.number().optional(),
  },
  async ({ query, max_results }) => ({
    content: [{ type: "text" as const, text: await gmailSearch(query, max_results) }],
  }),
);

// ── Mac computer use tools ──

server.tool(
  "jarvis_mac_screenshot",
  "Take a screenshot of the Mac desktop. Returns the image visually. Optionally focus a specific window.",
  { window_title: z.string().optional().describe("Optional: capture a specific window by title") },
  async ({ window_title }) => {
    const result = await macScreenshot(window_title);
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
  "jarvis_mac_click",
  "Click at screen coordinates (x, y). Requires Accessibility permissions for the terminal in System Preferences.",
  {
    x: z.number().describe("X coordinate in pixels"),
    y: z.number().describe("Y coordinate in pixels"),
    button: z.enum(["left", "right"]).optional().describe("Mouse button (default: left)"),
  },
  async ({ x, y, button }) => ({
    content: [{ type: "text" as const, text: await macClick(x, y, button) }],
  }),
);

server.tool(
  "jarvis_mac_type",
  "Type text at the current cursor position.",
  { text: z.string().describe("Text to type") },
  async ({ text }) => ({
    content: [{ type: "text" as const, text: await macType(text) }],
  }),
);

server.tool(
  "jarvis_mac_key",
  "Press a key or keyboard shortcut. Examples: 'return', 'escape', 'command+c', 'command+shift+4'.",
  { key: z.string().describe("Key or shortcut to press") },
  async ({ key }) => ({
    content: [{ type: "text" as const, text: await macKeyPress(key) }],
  }),
);

server.tool(
  "jarvis_mac_open_app",
  "Open a Mac application by name.",
  { app_name: z.string().describe("Application name, e.g. 'Xcode', 'Figma', 'Notes'") },
  async ({ app_name }) => ({
    content: [{ type: "text" as const, text: await macOpenApp(app_name) }],
  }),
);

server.tool(
  "jarvis_mac_focused_app",
  "Get the currently focused application and window title.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await macGetFocusedApp() }],
  }),
);

server.tool(
  "jarvis_mac_run_script",
  "Run an AppleScript on the Mac. Use for complex automation that needs direct macOS integration.",
  { script: z.string().describe("AppleScript code to execute") },
  async ({ script }) => ({
    content: [{ type: "text" as const, text: await macRunScript(script) }],
  }),
);

// ── Outcome feedback loop ──

server.tool(
  "jarvis_outcome_review",
  "Run the LLM-as-Judge outcome review loop on resolved Polymarket trades. Loads trade history, asks Claude to identify patterns (calibration, market types, failure modes), and appends dated insights to MEMORY.md. Pass full:true for deep review, or omit for quick performance summary.",
  { full: z.boolean().optional().describe("Run full LLM review (true) or just show stats (default: stats only)") },
  async ({ full }) => {
    if (full) {
      const report = await reviewOutcomes();
      const text = [
        `Outcome review complete.`,
        `Resolved trades: ${report.resolvedCount}`,
        `Win rate: ${(report.winRate * 100).toFixed(1)}%`,
        `Brier score: ${report.brierScore.toFixed(3)}`,
        ``,
        `Insights appended to memory.`,
        ``,
        report.insights,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    } else {
      const summary = await getPerformanceSummary();
      return { content: [{ type: "text" as const, text: summary }] };
    }
  },
);

// ── News tools ──

server.tool(
  "jarvis_news_headlines",
  "Get top news headlines by category (technology, business, sports, health, science, entertainment, general) and country.",
  {
    category: z.string().optional().describe("Category: technology, business, sports, health, science, entertainment, general"),
    country: z.string().optional().describe("2-letter country code (default: us). Options: us, ca, gb, au"),
  },
  async ({ category, country }) => ({
    content: [{ type: "text" as const, text: await newsHeadlines(category, country) }],
  }),
);

server.tool(
  "jarvis_news_search",
  "Search news articles by keyword across all sources. Optionally filter by date range.",
  {
    query: z.string().describe("Search query (e.g. 'bitcoin ETF', 'OpenAI', 'Apple earnings')"),
    from: z.string().optional().describe("Start date in YYYY-MM-DD format"),
    to: z.string().optional().describe("End date in YYYY-MM-DD format"),
    page_size: z.number().optional().describe("Number of results (default 10, max 20)"),
  },
  async ({ query, from, to, page_size }) => ({
    content: [{ type: "text" as const, text: await newsSearch(query, from, to, page_size) }],
  }),
);

// ── CoinGecko crypto tools ──

server.tool(
  "jarvis_crypto_trending",
  "Get the 7 trending coins on CoinGecko right now (based on search traffic and trading activity).",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await cryptoTrending() }],
  }),
);

server.tool(
  "jarvis_crypto_markets",
  "Get crypto market overview — top coins ranked by market cap, volume, or 24h price change.",
  {
    vs_currency: z.string().optional().describe("Quote currency (default: usd)"),
    order: z.string().optional().describe("Sort order: market_cap_desc (default), volume_desc, price_change_percentage_24h_desc"),
    per_page: z.number().optional().describe("Number of coins (default 10, max 25)"),
  },
  async ({ vs_currency, order, per_page }) => ({
    content: [{ type: "text" as const, text: await cryptoMarkets(vs_currency, order, per_page) }],
  }),
);

server.tool(
  "jarvis_crypto_coin",
  "Deep info on a specific coin — price, market cap, ATH/ATL, supply, links, description. Use CoinGecko ID (e.g. bitcoin, ethereum, solana).",
  {
    coin_id: z.string().describe("CoinGecko coin ID (e.g. 'bitcoin', 'ethereum', 'solana', 'chainlink')"),
  },
  async ({ coin_id }) => ({
    content: [{ type: "text" as const, text: await cryptoCoinInfo(coin_id) }],
  }),
);

server.tool(
  "jarvis_crypto_defi",
  "Top DeFi protocol tokens by market cap — market cap, price, and 24h change.",
  {
    top: z.number().optional().describe("Number of DeFi tokens to return (default 10, max 25)"),
  },
  async ({ top }) => ({
    content: [{ type: "text" as const, text: await cryptoDefiTvl(top) }],
  }),
);

// ── Stock fundamentals tools ──

server.tool(
  "jarvis_stock_overview",
  "Stock company overview — sector, market cap, P/E, EPS, dividend yield, 52-week range, beta, analyst target price.",
  {
    symbol: z.string().describe("Stock ticker symbol (e.g. AAPL, TSLA, NVDA)"),
  },
  async ({ symbol }) => ({
    content: [{ type: "text" as const, text: await stockOverview(symbol) }],
  }),
);

server.tool(
  "jarvis_stock_earnings",
  "Last 4 quarters of earnings — reported EPS vs estimated EPS and surprise percentage.",
  {
    symbol: z.string().describe("Stock ticker symbol (e.g. AAPL, TSLA, NVDA)"),
  },
  async ({ symbol }) => ({
    content: [{ type: "text" as const, text: await stockEarnings(symbol) }],
  }),
);

server.tool(
  "jarvis_stock_income",
  "Last 2 annual income statements — revenue, gross profit, operating income, net income.",
  {
    symbol: z.string().describe("Stock ticker symbol (e.g. AAPL, TSLA, NVDA)"),
  },
  async ({ symbol }) => ({
    content: [{ type: "text" as const, text: await stockIncomeStatement(symbol) }],
  }),
);

server.tool(
  "jarvis_stock_valuation",
  "Stock valuation multiples — P/E, forward P/E, PEG, price/book, price/sales, EV/EBITDA, ROE, profit margin.",
  {
    symbol: z.string().describe("Stock ticker symbol (e.g. AAPL, TSLA, NVDA)"),
  },
  async ({ symbol }) => ({
    content: [{ type: "text" as const, text: await stockValuation(symbol) }],
  }),
);

// ── System Monitor tools ──

server.tool(
  "jarvis_sys_status",
  "macOS system status: CPU load averages, memory (free/total), disk usage, and uptime.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await sysGetStatus() }],
  }),
);

server.tool(
  "jarvis_sys_processes",
  "Top processes by CPU usage on macOS. Shows PID, CPU%, memory%, and process name.",
  {
    limit: z.number().int().min(5).max(30).optional().describe("Number of processes to show (default: 10)"),
  },
  async ({ limit }) => ({
    content: [{ type: "text" as const, text: await sysGetProcesses(limit ?? 10) }],
  }),
);

server.tool(
  "jarvis_sys_network",
  "macOS network status: primary IP, active interfaces, and established connection count.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: await sysGetNetwork() }],
  }),
);

// ── iMCP tools ──

server.tool(
  "jarvis_imessage_chats",
  "List recent iMessage/SMS conversations from the Messages app.",
  {
    limit: z.number().int().min(1).max(50).optional().describe("Max conversations to list (default: 10)"),
  },
  async ({ limit }) => ({
    content: [{ type: "text" as const, text: await iMessageGetChats(limit ?? 10) }],
  }),
);

server.tool(
  "jarvis_imessage_read",
  "Read recent messages from a specific iMessage contact or group chat.",
  {
    contact: z.string().describe("Contact name, phone number, or partial chat name to search for"),
    limit: z.number().int().min(1).max(50).optional().describe("Number of messages to retrieve (default: 10)"),
  },
  async ({ contact, limit }) => ({
    content: [{ type: "text" as const, text: await iMessageGetMessages(contact, limit ?? 10) }],
  }),
);

server.tool(
  "jarvis_imessage_send",
  "Send an iMessage to a contact. Recipient must be an iMessage-capable phone number or Apple ID email. ALWAYS confirm with Jeet before sending.",
  {
    recipient: z.string().describe("Phone number (+1...) or Apple ID email of the recipient"),
    message: z.string().describe("Message text to send"),
  },
  async ({ recipient, message }) => ({
    content: [{ type: "text" as const, text: await iMessageSend(recipient, message) }],
  }),
);

server.tool(
  "jarvis_contacts_search",
  "Search macOS Contacts by name. Returns phone number and email for matching contacts.",
  {
    query: z.string().describe("Name or partial name to search for"),
  },
  async ({ query }) => ({
    content: [{ type: "text" as const, text: await contactsSearch(query) }],
  }),
);

server.tool(
  "jarvis_reminders_get",
  "Get incomplete reminders from macOS Reminders app. Optionally filter by list name.",
  {
    list: z.string().optional().describe("List name to filter by (e.g. 'Work', 'Personal'). Omit for all lists."),
  },
  async ({ list }) => ({
    content: [{ type: "text" as const, text: await remindersGet(list) }],
  }),
);

server.tool(
  "jarvis_reminders_create",
  "Create a new reminder in macOS Reminders app.",
  {
    title: z.string().describe("Reminder title/text"),
    list: z.string().optional().describe("List to add to (default: 'Reminders')"),
    due_date: z.string().optional().describe("Due date as natural string, e.g. 'March 25, 2026 9:00 AM'"),
  },
  async ({ title, list, due_date }) => ({
    content: [{ type: "text" as const, text: await remindersCreate(title, list ?? "Reminders", due_date) }],
  }),
);

server.tool(
  "jarvis_weather",
  "Current weather and today's forecast for any location. Defaults to Kelowna, BC. No API key needed.",
  {
    location: z.string().optional().describe("City name or 'City,Region' (default: 'Kelowna,BC')"),
  },
  async ({ location }) => ({
    content: [{ type: "text" as const, text: await weatherGet(location ?? "Kelowna,BC") }],
  }),
);

// ── Think tool (reasoning scratchpad) ──

server.tool(
  "jarvis_think",
  "Use this tool to think through complex problems step by step before acting. Write your reasoning here — it won't be executed. Use before multi-step decisions, trade analysis, debugging, or any task requiring careful reasoning.",
  { thought: z.string() },
  async ({ thought: _thought }) => ({
    content: [{ type: "text" as const, text: "Thought noted." }],
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
