/**
 * Webhook HTTP server — external systems can POST events to wake Jarvis.
 * Adapted from OpenClaw's hooks.ts gateway pattern.
 *
 * POST /webhook — send a message to the agent
 * Auth: Bearer token via JARVIS_WEBHOOK_SECRET env var
 *
 * Example:
 *   curl -X POST http://localhost:7777/webhook \
 *     -H "Authorization: Bearer your-secret" \
 *     -H "Content-Type: application/json" \
 *     -d '{"message": "Deploy succeeded for phantom-defender", "source": "railway"}'
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger } from "./logger.js";
import { emit } from "./events.js";
import { runAgent } from "./agent.js";
import type { Bot } from "grammy";

const log = createLogger("webhook");

const DEFAULT_PORT = 7777;
const MAX_BODY_BYTES = 256 * 1024; // 256KB

interface WebhookPayload {
  message: string;
  source?: string;
  respond?: boolean; // default true — send response to Telegram
}

let server: ReturnType<typeof createServer> | null = null;
let botRef: Bot | null = null;
let chatIdRef: number | null = null;

function getSecret(): string | null {
  return process.env["JARVIS_WEBHOOK_SECRET"] ?? null;
}

function authenticate(req: IncomingMessage): boolean {
  const secret = getSecret();
  if (!secret) return false; // No secret configured = webhooks disabled

  const authHeader = req.headers["authorization"];
  if (!authHeader) return false;

  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return false;

  // Constant-time comparison
  if (!token || token.length !== secret.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= (token.charCodeAt(i) ?? 0) ^ (secret.charCodeAt(i) ?? 0);
  }
  return mismatch === 0;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (!authenticate(req)) {
    log.warn(`Unauthorized webhook attempt from ${req.socket.remoteAddress}`);
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body) as WebhookPayload;

    if (!payload.message || typeof payload.message !== "string") {
      sendJson(res, 400, { error: "Missing 'message' field" });
      return;
    }

    const source = payload.source ?? "webhook";
    const respond = payload.respond !== false;

    log.info(`Webhook from "${source}": ${payload.message.slice(0, 100)}`);

    await emit("webhook", "received", {
      source,
      message: payload.message,
    });

    // Acknowledge immediately
    sendJson(res, 202, { status: "accepted", source });

    // Process in background
    const prefixedMessage = `[Webhook from ${source}]: ${payload.message}`;
    const response = await runAgent(prefixedMessage, []);

    if (respond && botRef && chatIdRef) {
      await botRef.api.sendMessage(chatIdRef, response).catch((err) => {
        log.error(`Failed to send webhook response to Telegram: ${err}`);
      });
    }

    await emit("webhook", "processed", {
      source,
      responsePreview: response.slice(0, 200),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Webhook error: ${msg}`);
    sendJson(res, 500, { error: "Internal error" });
  }
}

export function startWebhookServer(bot: Bot): void {
  const secret = getSecret();
  if (!secret) {
    log.info("JARVIS_WEBHOOK_SECRET not set — webhook server disabled");
    return;
  }

  const allowedUserId = process.env["TELEGRAM_ALLOWED_USER_ID"];
  if (allowedUserId) {
    botRef = bot;
    chatIdRef = Number(allowedUserId);
  }

  const port = Number(process.env["JARVIS_WEBHOOK_PORT"] ?? DEFAULT_PORT);

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/webhook") {
      handleWebhook(req, res).catch((err) => {
        log.error(`Unhandled webhook error: ${err}`);
        if (!res.headersSent) {
          sendJson(res, 500, { error: "Internal error" });
        }
      });
    } else if (url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", uptime: process.uptime() });
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    log.info(`Webhook server listening on http://127.0.0.1:${port}`);
  });
}

export function stopWebhookServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      log.info("Webhook server stopped");
      resolve();
    });
  });
}
