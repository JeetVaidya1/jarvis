# Jarvis

> Personal AI agent running 24/7 on a MacBook Pro. Controlled via Telegram. Built on Claude.

Jarvis is a self-hosted autonomous agent that serves as a second brain and force multiplier. It handles development tasks, browses the web, trades on Polymarket, monitors GitHub repos, manages memory across sessions, and executes background jobs — all from a Telegram chat.

---

## Architecture

```
Telegram (GrammY)
    ↓
Agent Loop (Claude claude-sonnet-4-6)
    ↓
Tool Router
    ├── Shell execution
    ├── File read/write
    ├── Browser automation (Playwright)
    ├── Web search + fetch
    ├── Polymarket trading (CLOB SDK)
    ├── GitHub operations (gh CLI)
    ├── Claude Code delegation (claude --print)
    └── Sub-agent spawning
    ↓
Memory + Session persistence
    ↓
Webhook ingress (port 7777)
    ↓
Scheduled programs (cron via node-cron)
```

**Key design decisions:**
- All intelligence lives in Claude — tools are thin wrappers
- Memory is Markdown files + SQLite vector store for semantic search
- Sessions are saved/restored across restarts so context survives
- The trading engine runs as a sub-system within the same process
- Claude Code is used for all non-trivial coding tasks (free on Max plan)

---

## Features

### Core Agent
- Conversational AI via Telegram with full tool access
- Persistent memory across sessions (`memory/MEMORY.md` + daily logs)
- Session save/restore — survives restarts without losing context
- Context compaction — large conversations are auto-pruned to stay within limits
- Media understanding — photos (vision), voice (Whisper), documents

### Browser Automation
- Full headless Chrome via Playwright
- Navigate, screenshot, click, type, extract content, run JS
- Claude sees screenshots visually (multimodal)

### Web & Data
- Web search via DuckDuckGo (no API key)
- Fetch + read any URL
- Real-time crypto/stock prices
- **NewsAPI** — top headlines by category (tech, business, sports) + keyword search (`NEWS_API_KEY`)
- **CoinGecko** — trending coins, market overview, deep coin info, DeFi token rankings (no key needed)
- **Alpha Vantage** — stock fundamentals: company overview, earnings history, income statements, valuation multiples (`ALPHA_VANTAGE_KEY`)
- **Weather** — current conditions + hourly forecast for any location via wttr.in (no key needed)
- **Brave Search** — privacy-first real web results, no tracking (`BRAVE_API_KEY`)
- **Firecrawl** — scrape any URL or crawl a site into clean markdown; strips ads/nav/scripts (`FIRECRAWL_API_KEY`)
- **Perplexity** — AI-powered research with cited sources; supports sonar, sonar-pro, sonar-reasoning models (`PERPLEXITY_API_KEY`)

### macOS System Monitor
- CPU load averages (1m/5m/15m), memory (free/total), disk usage, uptime (`jarvis_sys_status`)
- Top processes by CPU (`jarvis_sys_processes`)
- Network status: IP, interfaces, established connections (`jarvis_sys_network`)
- All via macOS built-ins — no npm dependencies

### iMCP — Native macOS Integration
- **iMessage** — list chats, read messages, send iMessages via AppleScript (`jarvis_imessage_*`)
- **Contacts** — search by name, returns phone + email (`jarvis_contacts_search`)
- **Reminders** — get incomplete reminders (filtered by list), create new reminders (`jarvis_reminders_*`)
- Requires Automation permissions in System Settings > Privacy & Security > Automation

### Polymarket Trading
- Full CLOB SDK integration — orderbook, positions, P&L
- Automated trading engine with Claude Opus forecaster
- **Local ML sentiment** — DistilBERT SST-2 runs in-process (~30ms) to pre-signal market sentiment before the full Opus pass; injected into every forecast as an additional feature
- **Parallel forecasting** — all candidate markets are analyzed simultaneously via `Promise.allSettled()`; cycle time drops from ~5min sequential to ~30s regardless of candidate count
- Risk management: max trade size, max deployed capital, position limits
- Always dry-runs before placing real orders
- Edge threshold filtering — only trades with meaningful model edge
- **Outcome feedback loop** — resolved trades stored in `data/trades.jsonl`; LLM-as-Judge review identifies calibration quality, market type patterns, and failure modes, appending dated insights to memory

### GitHub Integration
- Repo status, PRs, issues, commit history
- Trigger workflow runs
- Uses `gh` CLI under the hood

### Claude Code Delegation
- Delegates complex coding tasks to `claude --print` subprocess
- Free on Max plan — preferred over inline code edits for anything non-trivial
- Full file system and web access within the subprocess

### Sub-Agents
- Spawn background tasks that don't block the main conversation
- Check status, retrieve results, cancel running jobs

### Scheduled Programs
- Markdown files in `agent/programs/` define autonomous cron tasks
- Each file has a schedule and a prompt — Jarvis executes them automatically
- Results delivered to Telegram
- **Built-in programs:** morning briefing (8am — weather, portfolio, crypto, calendar, Gmail, GitHub PRs), portfolio review (10am/2pm/6pm), end-of-day summary (8pm), weekly outcome review (Mon 9am)

### Webhook Ingress
- External systems can POST to `http://localhost:7777/webhook`
- Jarvis processes the event and responds to Telegram
- HMAC-signed for security

---

## Project Structure

```
jarvis/
├── src/
│   ├── index.ts          # Entry point — boots everything
│   ├── agent.ts          # Main agent loop (Claude API calls)
│   ├── bot.ts            # Telegram bot setup (GrammY)
│   ├── commands.ts       # Slash commands (/status, /reset, etc.)
│   ├── config.ts         # Environment config + validation
│   ├── events.ts         # Event bus for cross-module communication
│   ├── heartbeat.ts      # 30-min system health checks
│   ├── links.ts          # URL auto-expansion in messages
│   ├── logger.ts         # Structured logging to daily log files
│   ├── mcp-server.ts     # MCP server exposing tools to Claude Code
│   ├── media.ts          # Photo/voice/document handling
│   ├── memory.ts         # Read/write MEMORY.md + daily logs
│   ├── memory-search.ts  # Semantic + keyword memory search
│   ├── semantic-memory.ts # Vector embeddings + sqlite-vec store
│   ├── programs.ts       # Scheduled autonomous programs
│   ├── session.ts        # Session save/restore across restarts
│   ├── subagent.ts       # Background sub-agent management
│   ├── compaction.ts     # Context window compaction logic
│   ├── webhook.ts        # HTTP webhook ingress server
│   ├── tools/
│   │   ├── index.ts      # Tool registry + router
│   │   ├── shell.ts      # shell_exec — run terminal commands
│   │   ├── files.ts      # file_read / file_write
│   │   ├── browser.ts    # Playwright browser automation
│   │   ├── websearch.ts  # DuckDuckGo search + URL fetch + prices
│   │   ├── github.ts     # GitHub operations via gh CLI
│   │   ├── polymarket.ts # Polymarket CLOB + Data API tools
│   │   ├── claude-code.ts # claude_code / claude_code_edit / claude_code_review
│   │   ├── news.ts           # NewsAPI — headlines + search
│   │   ├── coingecko.ts      # CoinGecko — trending, markets, coin info, DeFi
│   │   ├── finance.ts        # Alpha Vantage — stock overview, earnings, income, valuation
│   │   ├── system-monitor.ts # macOS system monitor — CPU, memory, disk, processes, network
│   │   ├── imcp.ts           # iMCP — iMessage, Contacts, Reminders, Weather
│   │   ├── research.ts       # Brave Search, Firecrawl, Perplexity
│   │   └── memory-tool.ts    # memory_update tool
│   └── trading/
│       ├── index.ts      # Trading engine entry point
│       ├── engine.ts     # Main trading loop + lifecycle
│       ├── scanner.ts    # Market discovery + filtering
│       ├── forecaster.ts # Claude Opus market analysis + edge calculation
│       ├── sentiment.ts  # Local ML sentiment (DistilBERT SST-2, ~30ms)
│       ├── executor.ts   # Order placement + dry-run logic
│       └── risk.ts       # Position limits, capital constraints
├── agent/
│   ├── SOUL.md           # System prompt — Jarvis's identity + instructions
│   ├── MEMORY.md         # Index of memory files
│   ├── HEARTBEAT.md      # Heartbeat program config
│   ├── programs/         # Scheduled autonomous tasks (cron + prompt)
│   └── skills/           # Reusable skill prompts (GitHub, Polymarket, etc.)
├── memory/               # Persistent memory files (gitignored except .gitkeep)
├── logs/                 # Daily log files (gitignored)
├── sessions/             # Session state files (gitignored)
├── .env.example          # Environment variable template
├── tsconfig.json         # TypeScript config
└── package.json
```

---

## Setup

### Prerequisites
- Node.js 22+
- A Telegram bot token ([@BotFather](https://t.me/BotFather))
- An Anthropic API key (or Claude Max plan with `claude` CLI installed)
- `gh` CLI installed and authenticated (for GitHub tools)
- Playwright browsers: `npx playwright install chromium`

### Install

```bash
git clone https://github.com/jeetvaidya/jarvis.git
cd jarvis
npm install
npx playwright install chromium
```

### Configure

```bash
cp .env.example .env
```

Fill in `.env`:

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ALLOWED_USER_ID=123456789   # Your Telegram user ID

# Polymarket (optional — enables trading tools)
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=
POLYMARKET_WALLET_PRIVATE_KEY=
POLYMARKET_PROXY_ADDRESS=

# GitHub (optional — fallback if gh CLI not available)
GITHUB_TOKEN=

# NewsAPI (optional — enables jarvis_news_headlines + jarvis_news_search)
# Free tier: 100 req/day. Get key at https://newsapi.org
NEWS_API_KEY=

# Alpha Vantage (optional — enables stock fundamentals tools)
# Free tier: 25 req/day. Get key at https://www.alphavantage.co/support/#api-key
ALPHA_VANTAGE_KEY=

# Brave Search (optional — enables jarvis_brave_search)
# Get key at https://brave.com/search/api/
BRAVE_API_KEY=

# Firecrawl (optional — enables jarvis_firecrawl_scrape + jarvis_firecrawl_crawl)
# Get key at https://firecrawl.dev
FIRECRAWL_API_KEY=

# Perplexity (optional — enables jarvis_perplexity_search)
# Get key at https://www.perplexity.ai/settings/api
PERPLEXITY_API_KEY=

# Google OAuth (optional — enables Calendar + Gmail tools)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Webhook server (optional)
JARVIS_WEBHOOK_SECRET=your-hmac-secret
JARVIS_WEBHOOK_PORT=7777
```

### Run

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | System status: memory, uptime, active jobs |
| `/reset` | Clear conversation context |
| `/compact` | Force context compaction |
| `/history` | Show recent conversation summary |
| `/jobs` | List running background sub-agents |
| `/help` | Show available commands |

---

## Trading Engine

The trading engine lives in `src/trading/` and runs as part of the main process.

**Flow per cycle:**
1. `scanner.ts` — fetches active Polymarket markets, filters by category/liquidity/time
2. `forecaster.ts` — **all candidates forecasted in parallel** via `Promise.allSettled()`:
   a. `sentiment.ts` — local DistilBERT classifies market question sentiment (~30ms, in-process)
   b. Claude Opus receives the sentiment signal + live crypto data + calibration stats → produces probability estimate
3. Edge calculation: `edge = |model_prob - market_price|`; results ranked by edge descending
4. `risk.ts` — checks capital limits, max positions, min edge threshold
5. Devil's advocate eval on the top opportunity — argues the bear case before committing
6. `executor.ts` — dry-runs the order, then places it if Jeet hasn't paused trading

**Config (set via Telegram):**
- `maxTrade` — max USDC per trade (default $8)
- `maxDeployed` — max total capital deployed (default $20)
- `minEdge` — minimum edge required (default 4%)
- `maxPositions` — max concurrent open positions (default 4)

**Start/stop via Telegram:**
```
/trade start
/trade stop
/trade status
```

---

## Memory System

Memory is stored as plain Markdown files in `memory/`. The agent reads `memory/MEMORY.md` (an index) at startup and appends to it throughout the session.

Types of memory:
- **user** — who Jeet is, preferences, communication style
- **feedback** — corrections and confirmations from past sessions
- **project** — active work, decisions, deadlines
- **reference** — pointers to external resources

### Semantic Search

Memory search uses vector embeddings (not just keywords). When you search for "prediction market", it finds entries about Polymarket even with zero word overlap.

**Stack:**
- `@huggingface/transformers` — runs `all-MiniLM-L6-v2` (384-dim ONNX model) in-process
- `sqlite-vec` — vector similarity extension for SQLite, zero infra
- `better-sqlite3` — sync SQLite interface

**Flow:**
1. On memory write → chunks text by paragraph → embeds each chunk → stores in `memory/vectors.db`
2. On memory search → embeds query → `SELECT ... WHERE embedding MATCH ? ORDER BY distance LIMIT k`
3. Falls back to keyword search if vector store is empty (first run before any indexing)

Logs are written to `logs/YYYY-MM-DD.log` and include every agent response, tool call result, and trade event.

---

## MCP Server

Jarvis exposes its tools as an MCP (Model Context Protocol) server at `jarvis-mcp.json`. This lets Claude Code instances connect to Jarvis's tool set directly — enabling Claude Code to call `polymarket_get_positions`, `jarvis_browser_screenshot`, etc. from within a VS Code session.

```bash
# The MCP server runs automatically alongside Jarvis
# Config: jarvis-mcp.json
node dist/mcp-server.js
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22, TypeScript |
| AI | Anthropic Claude (claude-sonnet-4-6 for agent, claude-opus-4-6 for trading forecasts) |
| Telegram | GrammY |
| Browser | Playwright (headless Chromium) |
| Trading | @polymarket/clob-client |
| Scheduling | node-cron |
| MCP | @modelcontextprotocol/sdk |
| Crypto | ethers.js v6 |
| Embeddings | @huggingface/transformers (ONNX, in-process) |
| Vector DB | sqlite-vec + better-sqlite3 |

---

## Security Notes

- Only the `TELEGRAM_ALLOWED_USER_ID` can interact with Jarvis — all other users are rejected
- `.env` is gitignored — never committed
- Webhook requests are HMAC-verified
- Polymarket orders always dry-run first; orders over $50 require extra confirmation
- No secrets are ever logged or included in responses

---

## License

Private — personal use only.
