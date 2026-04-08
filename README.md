# Jarvis

> Personal AI agent running 24/7 on a MacBook Pro. Controlled via Telegram. Built on Claude.

Jarvis is a self-hosted autonomous agent that serves as a second brain and force multiplier. It handles development tasks, browses the web, trades on Polymarket, monitors GitHub repos, manages memory across sessions, and executes background jobs — all from a Telegram chat.

---

## Architecture

```
Channels (Telegram, Dashboard, Voice, WebSocket clients)
    ↓
Gateway (ws://localhost:18789 — session management, routing, event broadcast)
    ↓
Embedded Runtime (Anthropic SDK streaming — token-by-token, cancellable)
    ↓
Tool Router (57 tools)
    ├── Shell execution
    ├── File read/write
    ├── Browser automation (Playwright)
    ├── Web search + fetch + research
    ├── Polymarket trading (CLOB SDK)
    ├── GitHub operations (gh CLI)
    ├── Google Calendar + Gmail
    ├── macOS automation + iMessage
    ├── Sub-agent spawning
    └── Memory + semantic search
    ↓
Memory + Session persistence
    ↓
Webhook ingress (port 7777)
    ↓
Scheduled programs (cron via node-cron)
```

**Key design decisions:**
- **Embedded runtime** — Anthropic SDK streaming, not CLI subprocess. Token-by-token responses, real-time tool visibility, mid-run cancellation
- **WebSocket gateway** — central control plane. Telegram is just one channel adapter. Dashboard, voice, and external clients connect the same way
- **Max subscription OAuth** — reads OAuth token from macOS Keychain for free usage on Claude Max plan
- All intelligence lives in Claude — tools are thin wrappers
- Memory is Markdown files + SQLite vector store for semantic search
- Sessions are saved/restored across restarts so context survives
- The trading engine runs as a sub-system within the same process

---

## Features

### Embedded Agent Runtime
- **Streaming responses** — tokens arrive one by one via Anthropic SDK `messages.stream()`
- **Real-time tool visibility** — see which tools are being called as they execute
- **Cancellation** — `/cancel` stops the agent mid-response (AbortController propagated to SDK)
- **No cold start** — persistent in-process runtime, no subprocess per message
- **Max subscription** — auto-detects Claude Max OAuth token from macOS Keychain (free)
- **Retry logic** — automatic retries with exponential backoff for 429/5xx errors
- **Tool loop detection** — breaks infinite tool calling cycles

### WebSocket Gateway
- **Port 18789** — persistent WebSocket connections for all clients
- **Typed protocol** — discriminated union message types (chat.send, agent.cancel, agent.status, session.list)
- **Session management** — channel-to-session mapping, conversation persistence
- **Event broadcasting** — runtime events (tokens, tool calls, completions) broadcast to all connected clients
- **Auth** — optional `GATEWAY_TOKEN` for access control
- **Heartbeat** — automatic dead connection detection via ping/pong

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

### Google Integration
- **Calendar** — view today's events, upcoming schedule
- **Gmail** — inbox triage, search, read emails

### Web Dashboard (Full Control Surface)

A real-time command center UI at `http://localhost:4242` — not just display, but full control.

- **WebChat** — chat with Jarvis directly from the browser with streaming responses
- **Agent Control** — cancel running agents, view status, see recent tool calls in real-time
- **Config Editor** — edit SOUL.md, Memory, and Programs directly from the dashboard
- **Live Agent** — streaming view of the agent response as tokens arrive, with active tool indicators
- **Activity Feed** — every tool call, message, trade, and error streams in via SSE
- **Sub-agent tracker** — running/completed background jobs with live output
- **System stats** — CPU, memory, disk, network (live SSE updates via `systeminformation`)
- **Portfolio widget** — Polymarket positions and P&L at a glance
- **iMessage feed** — recent chats surfaced in the dashboard
- **Neural activity** — visual representation of recent tool calls
- **Drag-and-drop layout** — widgets are resizable/repositionable; layout persists in `dashboard-layout.json`
- **HTTP API** — gateway REST API on port 18790 for chat, cancel, config, and status

```bash
npm run dev:full   # agent + dashboard together
npm run dashboard  # dashboard only
```

### Sub-Agents
- Spawn background tasks that don't block the main conversation
- Run through the embedded runtime (same streaming, same tools — no CLI subprocess)
- Cancellable via AbortController — no orphaned processes
- Progress streamed to dashboard in real-time
- Check status, retrieve results, cancel running jobs

### Dynamic Skill Loading
- Install new tools at runtime from `~/.jarvis/skills/` — no restart needed
- Each skill is a directory with `index.js` exporting `tools` array + `execute` function
- `skill_install` — create skills from inline code
- `skill_list` — view loaded skills and their tools
- `skill_reload` — hot-reload all skills
- Skills are automatically merged into the tool set available to the agent

### Outcome Learning
- Log significant decisions with `outcome_log` (trading, recommendations, forecasts)
- Resolve outcomes later with `outcome_resolve` (score 0.0–1.0)
- Find similar past decisions with `outcome_similar` before making new ones
- Track pending outcomes with `outcome_pending`
- Weekly review program calculates accuracy by domain and identifies biases

### Social Media Autopilot
- Draft posts for X (Twitter) with `social_draft` — human-in-the-loop approval
- Queue management: `/post`, `/post drafts`, `/post approve <id>`, `/post reject <id>`
- Daily content program (opt-in) generates posts from recent insights
- Posts go through: draft → approved → posted (or rejected)

### Self-Improvement Loop
- Weekly cron job analyzes 7 days of logs for patterns
- Identifies: tool failures, slow operations, user corrections, unused capabilities
- Auto-applies low-risk improvements to memory
- Creates GitHub issues for high-risk proposals
- Generates a structured improvement report

### Daemon Management
- **launchd integration** — auto-start on boot, restart on crash
- `scripts/install-daemon.sh` — one-command daemon setup
- `scripts/uninstall-daemon.sh` — clean removal
- Loads `.env` into launchd environment automatically

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
│   ├── agent.ts          # Thin adapter (delegates to runtime)
│   ├── bot.ts            # Telegram channel adapter (routes through gateway)
│   ├── commands.ts       # Slash commands (/status, /cancel, /reset, etc.)
│   ├── config.ts         # Environment config + validation
│   ├── events.ts         # Event bus for cross-module communication
│   ├── runtime/
│   │   ├── types.ts      # RuntimeEvent, AgentSession, RuntimeOptions
│   │   ├── streaming.ts  # Core streaming loop (Anthropic SDK messages.stream())
│   │   ├── agent-runtime.ts # Session management, system prompt, compaction
│   │   └── index.ts      # Barrel exports
│   ├── gateway/
│   │   ├── protocol.ts   # Typed WebSocket message protocol
│   │   ├── session-manager.ts # Session registry, channel mapping, persistence
│   │   ├── server.ts     # WebSocket server (port 18789), auth, broadcast
│   │   └── index.ts      # Barrel exports
│   ├── tools/
│   │   ├── index.ts      # Tool registry + router (57 tools)
│   │   ├── shell.ts      # shell_exec — run terminal commands
│   │   ├── files.ts      # file_read / file_write
│   │   ├── browser.ts    # Playwright browser automation
│   │   ├── websearch.ts  # DuckDuckGo search + URL fetch + prices
│   │   ├── github.ts     # GitHub operations via gh CLI
│   │   ├── polymarket.ts # Polymarket CLOB + Data API tools
│   │   ├── claude-code.ts # claude_code / claude_code_edit / claude_code_review
│   │   ├── news.ts           # NewsAPI — headlines + search
│   │   ├── coingecko.ts      # CoinGecko — trending, markets, coin info, DeFi
│   │   ├── finance.ts        # Alpha Vantage — stock overview, earnings, income
│   │   ├── system-monitor.ts # macOS system monitor — CPU, memory, disk, network
│   │   ├── imcp.ts           # iMCP — iMessage, Contacts, Reminders, Weather
│   │   ├── research.ts       # Brave Search, Firecrawl, Perplexity
│   │   ├── google.ts         # Google Calendar + Gmail tools
│   │   ├── mac-computer.ts   # macOS automation (clicks, typing, screenshots)
│   │   └── memory-tool.ts    # memory_update tool
│   ├── trading/
│   │   ├── index.ts      # Trading engine entry point
│   │   ├── engine.ts     # Main trading loop + lifecycle
│   │   ├── scanner.ts    # Market discovery + filtering
│   │   ├── forecaster.ts # Claude Opus market analysis + edge calculation
│   │   ├── sentiment.ts  # Local ML sentiment (DistilBERT SST-2, ~30ms)
│   │   ├── executor.ts   # Order placement + dry-run logic
│   │   └── risk.ts       # Position limits, capital constraints
│   ├── skills/
│   │   ├── loader.ts     # Dynamic skill loader (~/.jarvis/skills/)
│   │   └── index.ts      # Barrel exports
│   ├── social/
│   │   ├── queue.ts      # Post queue (draft → approved → posted)
│   │   ├── poster.ts     # Post publisher
│   │   └── index.ts      # Barrel exports
│   ├── outcomes.ts       # Outcome learning (log decisions, track results)
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
│   ├── subagent.ts       # Background sub-agent management (embedded runtime)
│   ├── compaction.ts     # Context window compaction logic
│   ├── webhook.ts        # HTTP webhook ingress server
│   ├── dashboard.ts      # Dashboard event emitter (HTTP shim + streaming)
│   └── dashboard-hooks.ts # Wires agent/trade events → dashboard
├── dashboard/            # Web dashboard (Express server + UI)
│   ├── index.ts          # Dashboard entry point
│   ├── server.ts         # Express server — REST + SSE + agent streaming
│   ├── db.ts             # SQLite event store
│   ├── logger.ts         # SSE broadcaster
│   └── public/           # Static UI assets (HTML, JS, CSS)
├── agent/
│   ├── SOUL.md           # System prompt — Jarvis's identity + instructions
│   ├── MEMORY.md         # Index of memory files
│   ├── HEARTBEAT.md      # Heartbeat program config
│   ├── programs/         # Scheduled autonomous tasks (cron + prompt)
│   └── skills/           # Reusable skill prompts (GitHub, Polymarket, etc.)
├── dashboard-layout.json # Persisted widget layout
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
- An Anthropic API key (or Claude Max plan — auto-detected from macOS Keychain)
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

# Gateway auth (optional — protects WebSocket gateway)
GATEWAY_TOKEN=

# NewsAPI (optional — enables jarvis_news_headlines + jarvis_news_search)
NEWS_API_KEY=

# Alpha Vantage (optional — enables stock fundamentals tools)
ALPHA_VANTAGE_KEY=

# Brave Search (optional — enables jarvis_brave_search)
BRAVE_API_KEY=

# Firecrawl (optional — enables jarvis_firecrawl_scrape + jarvis_firecrawl_crawl)
FIRECRAWL_API_KEY=

# Perplexity (optional — enables jarvis_perplexity_search)
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

# Development with dashboard
npm run dev:full

# Production
npm run build && npm start
```

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | System status: memory, uptime, active jobs |
| `/cancel` | Cancel the current agent task mid-response |
| `/reset` | Clear conversation context |
| `/compact` | Force context compaction |
| `/history` | Show recent conversation summary |
| `/jobs` | List running background sub-agents |
| `/trade start` | Start autonomous trading engine |
| `/trade stop` | Stop trading engine |
| `/trade status` | Trading status and history |
| `/post` | View social media post queue |
| `/post approve <id>` | Approve a draft post for publishing |
| `/post reject <id>` | Reject a draft post |
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

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22, TypeScript |
| AI | Anthropic Claude (claude-sonnet-4-6 for agent, claude-opus-4-6 for trading forecasts) |
| Agent Runtime | Anthropic SDK streaming (`messages.stream()`) |
| Gateway | WebSocket (`ws`) on port 18789 |
| Telegram | GrammY |
| Browser | Playwright (headless Chromium) |
| Trading | @polymarket/clob-client |
| Scheduling | node-cron |
| MCP | @modelcontextprotocol/sdk |
| Crypto | ethers.js v6 |
| Embeddings | @huggingface/transformers (ONNX, in-process) |
| Vector DB | sqlite-vec + better-sqlite3 |
| Dashboard | Express + SSE + systeminformation |

---

## Security Notes

- Only the `TELEGRAM_ALLOWED_USER_ID` can interact with Jarvis — all other users are rejected
- `.env` is gitignored — never committed
- Webhook requests are HMAC-verified
- WebSocket gateway supports token-based auth via `GATEWAY_TOKEN`
- Polymarket orders always dry-run first; orders over $50 require extra confirmation
- No secrets are ever logged or included in responses
- OAuth tokens read from macOS Keychain — never stored in config files

---

## License

Private — personal use only.
