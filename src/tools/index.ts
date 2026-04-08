import type Anthropic from "@anthropic-ai/sdk";
import { logEvent } from "../dashboard.js";
import { shellExec } from "./shell.js";
import { fileRead, fileWrite } from "./files.js";
import { memoryUpdate } from "./memory-tool.js";
import {
  browserNavigate,
  browserScreenshot,
  browserClick,
  browserType,
  browserGetContent,
  browserWait,
  browserEvaluate,
  browserClose,
} from "./browser.js";
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
  polymarketAnalyzeMarket,
  polymarketGetTags,
} from "./polymarket.js";
import type { PlaceOrderParams } from "./polymarket.js";
import { webSearch, webFetch, webGetPrice } from "./websearch.js";
import {
  spawnSubAgent,
  listSubAgents,
  getSubAgent,
  cancelSubAgent,
} from "../subagent.js";
import {
  claudeCode,
  claudeCodeEdit,
  claudeCodeReview,
} from "./claude-code.js";
import { searchMemory } from "../memory-search.js";
import {
  githubStatus,
  githubGetPrs,
  githubCreateIssue,
  githubGetCommits,
  githubRunWorkflow,
} from "./github.js";

export type ToolDefinition = Anthropic.Tool;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  // ── Core tools ──
  {
    name: "shell_exec",
    description:
      "Execute a shell command on Jeet's MacBook Pro. Returns stdout+stderr. Default timeout is 2 minutes. Use a longer timeout (e.g. 300000) for long-running commands like claude --print. Some destructive commands are blocked for safety.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        working_dir: {
          type: "string",
          description:
            "Working directory for the command. Defaults to home directory.",
        },
        timeout: {
          type: "number",
          description:
            "Timeout in milliseconds. Defaults to 120000 (2 minutes). Use 300000 (5 minutes) for long-running commands like claude --print.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "file_read",
    description:
      "Read a file from the filesystem. Supports absolute paths, ~ paths, and relative paths (resolved from home dir).",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the file to read",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "file_write",
    description:
      "Write content to a file. Creates parent directories if they don't exist. Supports absolute paths, ~ paths, and relative paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to write the file to",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "memory_update",
    description:
      "Update Jarvis's long-term memory (MEMORY.md). Use 'append' to add new information, 'overwrite' to replace entirely. Also logs to today's daily log.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "Content to write to memory",
        },
        mode: {
          type: "string",
          enum: ["append", "overwrite"],
          description:
            "append: add to existing memory with timestamp. overwrite: replace entire MEMORY.md.",
        },
      },
      required: ["content", "mode"],
    },
  },

  // ── Browser tools ──
  {
    name: "browser_navigate",
    description:
      "Navigate headless Chrome to a URL. Returns page title and current URL. Auto-starts browser if needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Take a screenshot of the current browser page. Returns base64 image that Claude can see visually. Use this to understand what's on screen.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "browser_click",
    description:
      'Click an element on the page. Accepts CSS selector (e.g. "#submit") or natural language description (e.g. "the Sign In button"). Tries selector first, then text/role matching.',
    input_schema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "CSS selector or natural language description of the element to click",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into an input field on the page. Clears existing content first. Accepts CSS selector or natural language description for the target field.",
    input_schema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "CSS selector or description of the input field",
        },
        text: {
          type: "string",
          description: "The text to type",
        },
      },
      required: ["target", "text"],
    },
  },
  {
    name: "browser_get_content",
    description:
      "Get readable text content of the current browser page. Strips scripts, styles, and navigation. Truncates to 8000 chars.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "browser_wait",
    description:
      "Wait for specified milliseconds (max 10000ms). Use when a page needs time to load dynamic content.",
    input_schema: {
      type: "object" as const,
      properties: {
        ms: {
          type: "number",
          description: "Milliseconds to wait (max 10000)",
        },
      },
      required: ["ms"],
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Execute JavaScript on the current browser page and return the result. Useful for extracting specific data from the DOM.",
    input_schema: {
      type: "object" as const,
      properties: {
        script: {
          type: "string",
          description: "JavaScript code to execute in the browser context",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "browser_close",
    description: "Close the browser and clean up. Next browser call will re-initialize.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },

  // ── Polymarket tools ──
  {
    name: "polymarket_get_positions",
    description:
      "Get all open Polymarket positions with current P&L, entry price, and size.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "polymarket_search",
    description:
      "Search Polymarket markets by keyword. Returns matching active markets with YES probability, volume, and end date.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g. 'bitcoin', 'election', 'trump')",
        },
        active: {
          type: "boolean",
          description: "Only show active markets (default true)",
        },
        limit: {
          type: "number",
          description: "Max results (default 20, max 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "polymarket_get_active_markets",
    description:
      "Get active Polymarket markets by category or timeframe. Use timeframe '5min' for 5-minute markets. Sort by volume.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Market category (e.g. 'crypto', 'politics', 'sports')",
        },
        timeframe: {
          type: "string",
          description: "Use '5min' for 5-minute resolution markets",
        },
      },
      required: [],
    },
  },
  {
    name: "polymarket_get_market",
    description:
      "Get detailed info on a specific Polymarket market including YES/NO prices, volume, description, and token IDs.",
    input_schema: {
      type: "object" as const,
      properties: {
        condition_id: {
          type: "string",
          description: "The market condition ID",
        },
      },
      required: ["condition_id"],
    },
  },
  {
    name: "polymarket_get_orderbook",
    description:
      "Get the order book for a Polymarket token. Shows top 5 bids and asks, spread, tick size, last trade price.",
    input_schema: {
      type: "object" as const,
      properties: {
        token_id: {
          type: "string",
          description: "The token ID to get the order book for",
        },
      },
      required: ["token_id"],
    },
  },
  {
    name: "polymarket_place_order",
    description:
      "Place a Polymarket order. ALWAYS set dryRun:true first to simulate. Never place a live order without Jeet's explicit confirmation.",
    input_schema: {
      type: "object" as const,
      properties: {
        condition_id: {
          type: "string",
          description: "The market condition ID",
        },
        side: {
          type: "string",
          enum: ["YES", "NO"],
          description: "Which side to buy",
        },
        size: {
          type: "number",
          description: "Order size in USDC",
        },
        price: {
          type: "number",
          description: "Limit price (0-1). Required for LIMIT orders.",
        },
        order_type: {
          type: "string",
          enum: ["MARKET", "LIMIT"],
          description: "MARKET for immediate fill, LIMIT for price target",
        },
        dry_run: {
          type: "boolean",
          description:
            "If true, simulate the order without placing it. ALWAYS use true first.",
        },
      },
      required: ["condition_id", "side", "size", "order_type", "dry_run"],
    },
  },
  {
    name: "polymarket_cancel_order",
    description: "Cancel an open Polymarket order by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id: {
          type: "string",
          description: "The order ID to cancel",
        },
      },
      required: ["order_id"],
    },
  },
  {
    name: "polymarket_get_portfolio_summary",
    description:
      "Get Polymarket portfolio overview: total deployed, total P&L, win rate, open positions count.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "polymarket_get_trades",
    description:
      "Get recent Polymarket trade history. Optionally filter by market condition ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        market: {
          type: "string",
          description: "Optional market condition ID to filter trades",
        },
      },
      required: [],
    },
  },
  {
    name: "polymarket_analyze_market",
    description:
      "Deep analysis of a Polymarket market using Claude Opus. Returns probability assessment, edge calculation, trade recommendation, and risk factors.",
    input_schema: {
      type: "object" as const,
      properties: {
        condition_id: {
          type: "string",
          description: "The market condition ID to analyze",
        },
      },
      required: ["condition_id"],
    },
  },
  {
    name: "polymarket_get_tags",
    description:
      "Get all available Polymarket market tags with their IDs, labels, and slugs. Use this to find valid tag IDs for filtering markets by category.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },

  // ── Web search tools ──
  {
    name: "web_search",
    description:
      "Search the web using DuckDuckGo. Returns titles, URLs, and snippets. No API key needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        num_results: {
          type: "number",
          description: "Number of results to return (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch and read content from a URL. Returns readable text (HTML stripped). Truncated to 10000 chars.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "web_get_price",
    description:
      "Get current price for crypto (BTC, ETH, SOL, etc.) or stocks (AAPL, TSLA, etc.). Returns price in USD with 24h change.",
    input_schema: {
      type: "object" as const,
      properties: {
        asset: {
          type: "string",
          description:
            "Asset symbol — crypto (BTC, ETH, SOL) or stock ticker (AAPL, TSLA)",
        },
      },
      required: ["asset"],
    },
  },

  // ── GitHub tools ──
  {
    name: "github_status",
    description:
      "Get GitHub repo status: recent commits, open PRs, open issues. Without repo arg, lists all repos.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description:
            "Repository in owner/name format (e.g. 'jeetvaidya/jarvis'). Optional — omit to list all repos.",
        },
      },
      required: [],
    },
  },
  {
    name: "github_get_prs",
    description:
      "List open pull requests for a GitHub repo with status check info.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/name format",
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_create_issue",
    description: "Create a new GitHub issue in a repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/name format",
        },
        title: {
          type: "string",
          description: "Issue title",
        },
        body: {
          type: "string",
          description: "Issue body (markdown)",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Optional labels to add",
        },
      },
      required: ["repo", "title", "body"],
    },
  },
  {
    name: "github_get_commits",
    description: "Get recent commits for a GitHub repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/name format",
        },
        limit: {
          type: "number",
          description: "Number of commits to return (default 10, max 50)",
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_run_workflow",
    description:
      "Trigger a GitHub Actions workflow. Requires workflow ID or filename.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/name format",
        },
        workflow_id: {
          type: "string",
          description:
            "Workflow ID or filename (e.g. 'deploy.yml')",
        },
      },
      required: ["repo", "workflow_id"],
    },
  },

  // ── Sub-agent tools ──
  {
    name: "subagent_spawn",
    description:
      "Spawn a background sub-agent to handle a task without blocking the conversation. Returns immediately with a run ID. The sub-agent has access to all of Jarvis's tools (Polymarket, browser, web search, etc).",
    input_schema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description: "The task/prompt for the sub-agent to execute",
        },
        label: {
          type: "string",
          description: "Short label for this job (for tracking)",
        },
        model: {
          type: "string",
          description: "Model override: 'claude-sonnet-4-6' (default), 'claude-opus-4-6'",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "subagent_status",
    description:
      "Check the status and result of a spawned sub-agent. Pass the run ID, or omit to list all.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Sub-agent run ID. Omit to list all sub-agents.",
        },
      },
      required: [],
    },
  },
  {
    name: "subagent_cancel",
    description: "Cancel a running sub-agent by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Sub-agent run ID to cancel",
        },
      },
      required: ["id"],
    },
  },

  // ── Claude Code tools (FREE on Max plan) ──
  {
    name: "claude_code",
    description:
      "Run a task through Claude Code CLI. FREE on Max plan — use this for heavy coding, research, and analysis instead of doing it yourself. Claude Code has full access to the filesystem, can edit files, run commands, search the web. Use for any task that needs deep work.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description: "The task/prompt for Claude Code to execute",
        },
        working_dir: {
          type: "string",
          description: "Working directory (project root). Required for coding tasks.",
        },
        model: {
          type: "string",
          description: "Model to use: 'sonnet' (default, fast), 'opus' (deep reasoning), 'haiku' (quick tasks)",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "max"],
          description: "Effort level. Use 'high' or 'max' for complex tasks.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "claude_code_edit",
    description:
      "Use Claude Code to edit files in a project. FREE on Max plan. Give it a coding task and a project directory — it reads, edits, and writes files directly. Best for bug fixes, refactoring, adding features.",
    input_schema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description: "What to do (e.g. 'Fix the RLS policy bug in the auth middleware')",
        },
        project_dir: {
          type: "string",
          description: "Absolute path to the project root",
        },
        model: {
          type: "string",
          description: "Model: 'sonnet' (default), 'opus' (complex changes), 'haiku' (simple edits)",
        },
      },
      required: ["task", "project_dir"],
    },
  },
  {
    name: "claude_code_review",
    description:
      "Use Claude Code to review code in a project. Read-only — makes no changes. FREE on Max plan. Returns structured analysis of code quality, bugs, security issues.",
    input_schema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description: "What to review (e.g. 'Review the auth module for security issues')",
        },
        project_dir: {
          type: "string",
          description: "Absolute path to the project root",
        },
        model: {
          type: "string",
          description: "Model: 'opus' (thorough), 'sonnet' (default), 'haiku' (quick scan)",
        },
      },
      required: ["task", "project_dir"],
    },
  },
  // ── Think tool (reasoning scratchpad) ──
  {
    name: "think",
    description:
      "Use this tool to think through complex problems step by step before acting. Write your reasoning here — it won't be shown to Jeet or executed. Use it before multi-step decisions, trade analysis, debugging, or any task requiring careful reasoning.",
    input_schema: {
      type: "object" as const,
      properties: {
        thought: {
          type: "string",
          description: "Your internal reasoning, analysis, or planning notes",
        },
      },
      required: ["thought"],
    },
  },

  // ── Memory search tool ──
  {
    name: "memory_search",
    description:
      "Search Jarvis's long-term memory and today's log by keywords. Returns relevant matching entries instead of the entire memory. Use this instead of reading all memory when you need to find specific information (e.g. 'trade history', 'phantom defender', 'ESP32').",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Keywords to search for (space-separated, case-insensitive)",
        },
        max_results: {
          type: "number",
          description: "Max number of matches to return (default 20)",
        },
      },
      required: ["query"],
    },
  },
] as const;

// ── Input interfaces ──

interface ShellExecInput {
  command: string;
  working_dir?: string;
  timeout?: number;
}

interface FileReadInput {
  path: string;
}

interface FileWriteInput {
  path: string;
  content: string;
}

interface MemoryUpdateInput {
  content: string;
  mode: "append" | "overwrite";
}

interface BrowserNavigateInput {
  url: string;
}

interface BrowserClickInput {
  target: string;
}

interface BrowserTypeInput {
  target: string;
  text: string;
}

interface BrowserWaitInput {
  ms: number;
}

interface BrowserEvaluateInput {
  script: string;
}

interface PolymarketSearchInput {
  query: string;
  active?: boolean;
  limit?: number;
}

interface PolymarketGetActiveMarketsInput {
  category?: string;
  timeframe?: string;
}

interface PolymarketGetMarketInput {
  condition_id: string;
}

interface PolymarketGetOrderbookInput {
  token_id: string;
}

interface PolymarketPlaceOrderInput {
  condition_id: string;
  side: "YES" | "NO";
  size: number;
  price?: number;
  order_type: "MARKET" | "LIMIT";
  dry_run: boolean;
}

interface PolymarketCancelOrderInput {
  order_id: string;
}

interface PolymarketGetTradesInput {
  market?: string;
}

interface PolymarketAnalyzeMarketInput {
  condition_id: string;
}

interface WebSearchInput {
  query: string;
  num_results?: number;
}

interface WebFetchInput {
  url: string;
}

interface WebGetPriceInput {
  asset: string;
}

interface GithubStatusInput {
  repo?: string;
}

interface GithubGetPrsInput {
  repo: string;
}

interface GithubCreateIssueInput {
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

interface GithubGetCommitsInput {
  repo: string;
  limit?: number;
}

interface GithubRunWorkflowInput {
  repo: string;
  workflow_id: string;
}

interface MemorySearchInput {
  query: string;
  max_results?: number;
}

// ── Tool result types ──

export interface ToolResult {
  text: string;
  base64Image?: string;
}

async function executeToolImpl(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<ToolResult> {
  switch (toolName) {
    // Core
    case "shell_exec": {
      const input = toolInput as unknown as ShellExecInput;
      return { text: await shellExec(input.command, input.working_dir, input.timeout) };
    }
    case "file_read": {
      const input = toolInput as unknown as FileReadInput;
      return { text: await fileRead(input.path) };
    }
    case "file_write": {
      const input = toolInput as unknown as FileWriteInput;
      return { text: await fileWrite(input.path, input.content) };
    }
    case "memory_update": {
      const input = toolInput as unknown as MemoryUpdateInput;
      return { text: await memoryUpdate(input.content, input.mode) };
    }

    // Browser
    case "browser_navigate": {
      const input = toolInput as unknown as BrowserNavigateInput;
      return { text: await browserNavigate(input.url) };
    }
    case "browser_screenshot": {
      const result = await browserScreenshot();
      return {
        text: result.text,
        base64Image: result.base64 ?? undefined,
      };
    }
    case "browser_click": {
      const input = toolInput as unknown as BrowserClickInput;
      return { text: await browserClick(input.target) };
    }
    case "browser_type": {
      const input = toolInput as unknown as BrowserTypeInput;
      return { text: await browserType(input.target, input.text) };
    }
    case "browser_get_content": {
      return { text: await browserGetContent() };
    }
    case "browser_wait": {
      const input = toolInput as unknown as BrowserWaitInput;
      return { text: await browserWait(input.ms) };
    }
    case "browser_evaluate": {
      const input = toolInput as unknown as BrowserEvaluateInput;
      return { text: await browserEvaluate(input.script) };
    }
    case "browser_close": {
      return { text: await browserClose() };
    }

    // Polymarket
    case "polymarket_get_positions": {
      return { text: await polymarketGetPositions() };
    }
    case "polymarket_search": {
      const input = toolInput as unknown as PolymarketSearchInput;
      return { text: await polymarketSearch(input.query, { active: input.active, limit: input.limit }) };
    }
    case "polymarket_get_active_markets": {
      const input = toolInput as unknown as PolymarketGetActiveMarketsInput;
      return { text: await polymarketGetActiveMarkets(input.category, input.timeframe) };
    }
    case "polymarket_get_market": {
      const input = toolInput as unknown as PolymarketGetMarketInput;
      return { text: await polymarketGetMarket(input.condition_id) };
    }
    case "polymarket_get_orderbook": {
      const input = toolInput as unknown as PolymarketGetOrderbookInput;
      return { text: await polymarketGetOrderbook(input.token_id) };
    }
    case "polymarket_place_order": {
      const input = toolInput as unknown as PolymarketPlaceOrderInput;
      const params: PlaceOrderParams = {
        conditionId: input.condition_id,
        side: input.side,
        size: input.size,
        price: input.price,
        orderType: input.order_type,
        dryRun: input.dry_run,
      };
      return { text: await polymarketPlaceOrder(params) };
    }
    case "polymarket_cancel_order": {
      const input = toolInput as unknown as PolymarketCancelOrderInput;
      return { text: await polymarketCancelOrder(input.order_id) };
    }
    case "polymarket_get_portfolio_summary": {
      return { text: await polymarketGetPortfolioSummary() };
    }
    case "polymarket_get_trades": {
      const input = toolInput as unknown as PolymarketGetTradesInput;
      return { text: await polymarketGetTrades(input.market) };
    }
    case "polymarket_analyze_market": {
      const input = toolInput as unknown as PolymarketAnalyzeMarketInput;
      return { text: await polymarketAnalyzeMarket(input.condition_id) };
    }
    case "polymarket_get_tags": {
      return { text: await polymarketGetTags() };
    }

    // Web search
    case "web_search": {
      const input = toolInput as unknown as WebSearchInput;
      return { text: await webSearch(input.query, input.num_results) };
    }
    case "web_fetch": {
      const input = toolInput as unknown as WebFetchInput;
      return { text: await webFetch(input.url) };
    }
    case "web_get_price": {
      const input = toolInput as unknown as WebGetPriceInput;
      return { text: await webGetPrice(input.asset) };
    }

    // GitHub
    case "github_status": {
      const input = toolInput as unknown as GithubStatusInput;
      return { text: await githubStatus(input.repo) };
    }
    case "github_get_prs": {
      const input = toolInput as unknown as GithubGetPrsInput;
      return { text: await githubGetPrs(input.repo) };
    }
    case "github_create_issue": {
      const input = toolInput as unknown as GithubCreateIssueInput;
      return { text: await githubCreateIssue(input.repo, input.title, input.body, input.labels) };
    }
    case "github_get_commits": {
      const input = toolInput as unknown as GithubGetCommitsInput;
      return { text: await githubGetCommits(input.repo, input.limit) };
    }
    case "github_run_workflow": {
      const input = toolInput as unknown as GithubRunWorkflowInput;
      return { text: await githubRunWorkflow(input.repo, input.workflow_id) };
    }

    // Sub-agents
    case "subagent_spawn": {
      const input = toolInput as unknown as { task: string; label?: string; model?: string };
      const run = spawnSubAgent(input.task, input.label, undefined, input.model);
      return { text: `Sub-agent spawned: ${run.id} (${run.label})\nStatus: ${run.status}\nUse subagent_status to check results.` };
    }
    case "subagent_status": {
      const input = toolInput as unknown as { id?: string };
      if (input.id) {
        const run = getSubAgent(input.id);
        if (!run) return { text: `No sub-agent found with ID: ${input.id}` };
        const duration = run.completedAt
          ? `${((run.completedAt - run.createdAt) / 1000).toFixed(1)}s`
          : `${((Date.now() - run.createdAt) / 1000).toFixed(0)}s (running)`;
        let text = `**Sub-agent ${run.id}**: ${run.label}\n**Status**: ${run.status}\n**Duration**: ${duration}`;
        if (run.result) text += `\n\n**Result**:\n${run.result}`;
        if (run.error) text += `\n\n**Error**: ${run.error}`;
        return { text };
      }
      const all = listSubAgents();
      if (all.length === 0) return { text: "No sub-agents." };
      const lines = all.map((r) => {
        const status = r.status === "running" ? "⏳" : r.status === "completed" ? "✓" : "✗";
        return `${status} [${r.id}] ${r.label} — ${r.status}`;
      });
      return { text: `**Sub-agents (${all.length})**:\n${lines.join("\n")}` };
    }
    case "subagent_cancel": {
      const input = toolInput as unknown as { id: string };
      const success = cancelSubAgent(input.id);
      return { text: success ? `Sub-agent ${input.id} cancelled.` : `No running sub-agent with ID: ${input.id}` };
    }

    // Claude Code (FREE on Max plan)
    case "claude_code": {
      const input = toolInput as unknown as { prompt: string; working_dir?: string; model?: string; effort?: string };
      return { text: await claudeCode(input.prompt, {
        workingDir: input.working_dir,
        model: input.model,
        effort: input.effort as "low" | "medium" | "high" | "max" | undefined,
      }) };
    }
    case "claude_code_edit": {
      const input = toolInput as unknown as { task: string; project_dir: string; model?: string };
      return { text: await claudeCodeEdit(input.task, input.project_dir, { model: input.model }) };
    }
    case "claude_code_review": {
      const input = toolInput as unknown as { task: string; project_dir: string; model?: string };
      return { text: await claudeCodeReview(input.task, input.project_dir, { model: input.model }) };
    }

    case "think": {
      // No-op reasoning scratchpad — Claude uses this to think before acting
      return { text: "Thought noted." };
    }

    case "memory_search": {
      const input = toolInput as unknown as MemorySearchInput;
      return { text: await searchMemory(input.query, input.max_results) };
    }

    default:
      return { text: `ERROR: Unknown tool '${toolName}'` };
  }
}

export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<ToolResult> {
  // Build a brief summary from the most relevant input field
  const summaryInput = (
    (toolInput["command"] as string | undefined) ??
    (toolInput["query"] as string | undefined) ??
    (toolInput["url"] as string | undefined) ??
    (toolInput["task"] as string | undefined) ??
    (toolInput["prompt"] as string | undefined) ??
    (toolInput["path"] as string | undefined) ??
    JSON.stringify(toolInput).slice(0, 80)
  );

  try {
    const result = await executeToolImpl(toolName, toolInput);
    const isError = result.text.startsWith("ERROR");
    logEvent({
      type: "tool_call",
      tool: toolName,
      summary: String(summaryInput).slice(0, 120),
      detail: { input: toolInput },
      status: isError ? "error" : "ok",
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent({
      type: "tool_call",
      tool: toolName,
      summary: String(summaryInput).slice(0, 120),
      detail: { input: toolInput, error: message },
      status: "error",
    });
    throw err;
  }
}
