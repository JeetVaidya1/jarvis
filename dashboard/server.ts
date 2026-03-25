/**
 * Jarvis Command Center — Express server.
 * Serves the dashboard UI and exposes REST + SSE endpoints.
 */

import express from "express";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import si from "systeminformation";
import Database from "better-sqlite3";
import { getRecentEvents, getAllSubagents, getStats } from "./db.js";
import { registerSseClient, unregisterSseClient, logEvent, upsertSubagent, broadcastSubagentOutput } from "./logger.js";
import type { Request, Response } from "express";

const DASHBOARD_PORT = 4242;
const PUBLIC_DIR = join(dirname(new URL(import.meta.url).pathname), "public");
const CONFIG_FILE = join(dirname(new URL(import.meta.url).pathname), "../dashboard-layout.json");

// ── System stats (for LobsterBoard system widgets) ──
let cachedSysStats: Record<string, unknown> = {};
const sysStatClients = new Set<Response>();

async function collectSysStats(): Promise<void> {
  try {
    const [cpu, mem, disk, net] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
    ]);
    cachedSysStats = {
      cpu: { usage: Math.round(cpu.currentLoad) },
      memory: {
        used: mem.used,
        total: mem.total,
        percent: Math.round((mem.used / mem.total) * 100),
      },
      disk: (disk as { mount: string; size: number; used: number }[])
        .slice(0, 3)
        .map((d) => ({
          mount: d.mount,
          size: d.size,
          used: d.used,
          percent: d.size > 0 ? Math.round((d.used / d.size) * 100) : 0,
        })),
      network: {
        rx: ((net as { rx_bytes?: number }[])[0]?.rx_bytes ?? 0),
        tx: ((net as { tx_bytes?: number }[])[0]?.tx_bytes ?? 0),
      },
      uptime: Math.floor(process.uptime()),
    };
    const payload = `data: ${JSON.stringify(cachedSysStats)}\n\n`;
    for (const res of sysStatClients) {
      try {
        res.write(payload);
      } catch {
        sysStatClients.delete(res);
      }
    }
  } catch {
    // systeminformation may not be available on all systems
  }
}

setInterval(collectSysStats, 3000);
void collectSysStats();

// ── Polymarket portfolio cache ──
interface PolymarketPosition {
  asset: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
}
let polymarketCache: { data: PolymarketPosition[]; ts: number } | null = null;
const POLYMARKET_CACHE_TTL = 30_000;

async function fetchPolymarketPortfolio(): Promise<{ ok: boolean; data?: PolymarketPosition[]; error?: string }> {
  const address = process.env.POLYMARKET_PROXY_ADDRESS;
  if (!address) {
    return { ok: false, error: "POLYMARKET_PROXY_ADDRESS not configured" };
  }
  const now = Date.now();
  if (polymarketCache && now - polymarketCache.ts < POLYMARKET_CACHE_TTL) {
    return { ok: true, data: polymarketCache.data };
  }
  const url = `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0.01`;
  const resp = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!resp.ok) {
    throw new Error(`Polymarket API error: ${resp.status}`);
  }
  const raw = await resp.json() as Record<string, unknown>[];
  const positions: PolymarketPosition[] = raw.map((p) => ({
    asset: String(p.asset ?? p.conditionId ?? ""),
    title: String(p.title ?? p.question ?? ""),
    outcome: String(p.outcome ?? ""),
    size: Number(p.size ?? p.amount ?? 0),
    avgPrice: Number(p.avgPrice ?? p.averagePrice ?? 0),
    currentValue: Number(p.currentValue ?? p.value ?? 0),
    realizedPnl: Number(p.realizedPnl ?? p.cashPnl ?? 0),
    unrealizedPnl: Number(p.unrealizedPnl ?? p.unrealizedProfit ?? 0),
  }));
  polymarketCache = { data: positions, ts: now };
  return { ok: true, data: positions };
}

// ── iMessage DB helpers ──
const IMESSAGE_DB = `${os.homedir()}/Library/Messages/chat.db`;
const IMESSAGE_QUERY = `
  SELECT
    m.rowid,
    m.text,
    m.date,
    m.is_from_me,
    COALESCE(h.id, c.chat_identifier) as contact,
    c.display_name
  FROM message m
  LEFT JOIN chat_message_join cmj ON m.rowid = cmj.message_id
  LEFT JOIN chat c ON cmj.chat_id = c.rowid
  LEFT JOIN handle h ON m.handle_id = h.rowid
  WHERE m.text IS NOT NULL AND m.text != ''
  ORDER BY m.date DESC
  LIMIT 50
`;
const APPLE_EPOCH_MS = new Date("2001-01-01T00:00:00Z").getTime();

export function createServer(): express.Application {
  const app = express();

  // Serve static files from dashboard/public/
  app.use(express.static(PUBLIC_DIR));

  // ── REST endpoints ──

  app.get("/api/events", (_req: Request, res: Response) => {
    try {
      const events = getRecentEvents();
      res.json({ ok: true, data: events });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get("/api/subagents", (_req: Request, res: Response) => {
    try {
      const agents = getAllSubagents();
      res.json({ ok: true, data: agents });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  // Jarvis-specific stats (renamed to avoid conflict with LobsterBoard /api/stats)
  app.get("/api/jarvis/stats", (_req: Request, res: Response) => {
    try {
      const stats = getStats();
      res.json({ ok: true, data: stats });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  // ── LobsterBoard-compatible endpoints ──

  // System stats snapshot
  app.get("/api/stats", (_req: Request, res: Response) => {
    res.json(cachedSysStats);
  });

  // System stats SSE stream
  app.get("/api/stats/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();
    sysStatClients.add(res);
    const ping = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { /* ignore */ }
    }, 25_000);
    req.on("close", () => {
      clearInterval(ping);
      sysStatClients.delete(res);
    });
  });

  // Dashboard layout config persistence
  app.get("/api/config", (_req: Request, res: Response) => {
    try {
      if (existsSync(CONFIG_FILE)) {
        res.json(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
      } else {
        res.json({});
      }
    } catch {
      res.json({});
    }
  });

  app.post("/api/config", express.json({ limit: "2mb" }), (req: Request, res: Response) => {
    try {
      writeFileSync(CONFIG_FILE, JSON.stringify(req.body, null, 2));
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  // Auth status (always authenticated — personal use)
  app.get("/api/auth/status", (_req: Request, res: Response) => {
    res.json({ pin: false, publicMode: false, authenticated: true });
  });

  // Pages (unused)
  app.get("/api/pages", (_req: Request, res: Response) => {
    res.json([]);
  });

  // ── Ingest endpoints (called by Jarvis agent process) ──

  app.post("/api/events", express.json(), (req: Request, res: Response) => {
    try {
      logEvent(req.body as Parameters<typeof logEvent>[0]);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post("/api/subagents", express.json(), (req: Request, res: Response) => {
    try {
      upsertSubagent(req.body as Parameters<typeof upsertSubagent>[0]);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  // ── Polymarket portfolio ──

  app.get("/api/polymarket/portfolio", async (_req: Request, res: Response) => {
    try {
      const result = await fetchPolymarketPortfolio();
      if (!result.ok) {
        res.status(400).json(result);
      } else {
        res.json(result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  // ── iMessage recent messages ──

  app.get("/api/imessage/recent", (_req: Request, res: Response) => {
    try {
      if (!existsSync(IMESSAGE_DB)) {
        res.status(400).json({ ok: false, error: "Messages DB not accessible" });
        return;
      }
      const db = new Database(IMESSAGE_DB, { readonly: true });
      const rows = db.prepare(IMESSAGE_QUERY).all() as {
        rowid: number;
        text: string;
        date: number;
        is_from_me: number;
        contact: string | null;
        display_name: string | null;
      }[];
      db.close();
      const messages = rows.map((row) => ({
        id: row.rowid,
        text: row.text,
        timestamp: new Date(APPLE_EPOCH_MS + row.date / 1_000_000).toISOString(),
        isFromMe: row.is_from_me === 1,
        contact: row.contact ?? "",
        displayName: row.display_name ?? row.contact ?? "",
      }));
      res.json({ ok: true, data: messages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: "Messages DB not accessible: " + message });
    }
  });

  // ── Subagent live output ──

  app.post("/api/subagents/:id/output", express.json({ limit: "16kb" }), (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const body = req.body as { chunk?: string };
    if (id && body.chunk && typeof body.chunk === "string") {
      broadcastSubagentOutput(id, body.chunk.slice(0, 2000));
    }
    res.json({ ok: true });
  });

  // ── SSE endpoint ──

  app.get("/api/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    // Send a keepalive comment immediately
    res.write(": connected\n\n");

    const client = {
      write: (data: string) => res.write(data),
      ended: false,
    };

    registerSseClient(client);

    // Keepalive ping every 25s to prevent proxy timeouts
    const keepalive = setInterval(() => {
      if (!client.ended) {
        res.write(": ping\n\n");
      }
    }, 25_000);

    req.on("close", () => {
      client.ended = true;
      clearInterval(keepalive);
      unregisterSseClient(client);
    });
  });

  return app;
}

export function startServer(): void {
  const app = createServer();

  app.listen(DASHBOARD_PORT, () => {
    console.log(`[dashboard] Jarvis Command Center running at http://localhost:${DASHBOARD_PORT}`);
  });
}
