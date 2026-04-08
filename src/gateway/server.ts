/**
 * WebSocket Gateway — central control plane for all Jarvis clients.
 *
 * Telegram, Dashboard, and Voice connect as channel adapters. The gateway
 * owns agent sessions, routes messages, and broadcasts runtime events.
 */

import { WebSocketServer, WebSocket } from "ws";
import { createLogger } from "../logger.js";
import {
  handleMessage,
  cancelSessionById,
  getSession,
  listSessions,
  getOrCreateSession,
} from "./session-manager.js";
import {
  isClientMessage,
  serializeServerMessage,
} from "./protocol.js";
import type { ClientMessage, ServerMessage, SessionInfo } from "./protocol.js";
import type { RuntimeEvent } from "../runtime/types.js";

const log = createLogger("gateway");

const DEFAULT_PORT = 18789;
const HEARTBEAT_INTERVAL = 30_000;

// ── Connection state ──

interface ClientConnection {
  readonly ws: WebSocket;
  readonly id: string;
  authenticated: boolean;
  alive: boolean;
  readonly subscribedSessions: Set<string>;
}

const connections = new Map<string, ClientConnection>();

let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// ── Broadcast ──

function broadcast(msg: ServerMessage, sessionId?: string): void {
  const data = serializeServerMessage(msg);

  for (const conn of connections.values()) {
    if (!conn.authenticated) continue;
    if (conn.ws.readyState !== WebSocket.OPEN) continue;

    // If sessionId is specified, only send to clients subscribed to that session
    if (sessionId && !conn.subscribedSessions.has(sessionId) && conn.subscribedSessions.size > 0) {
      continue;
    }

    conn.ws.send(data);
  }
}

/**
 * Broadcast a runtime event as a ServerMessage. Called by the session
 * manager during agent runs. Also available for in-process use.
 */
export function broadcastRuntimeEvent(sessionId: string, event: RuntimeEvent): void {
  switch (event.kind) {
    case "token":
      broadcast({ type: "chat.token", sessionId, text: event.text }, sessionId);
      break;
    case "tool_start":
      broadcast({
        type: "chat.tool_start",
        sessionId,
        toolName: event.toolName,
        toolInput: event.toolInput,
      }, sessionId);
      break;
    case "tool_end":
      broadcast({
        type: "chat.tool_end",
        sessionId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      }, sessionId);
      break;
    case "message_complete":
      broadcast({ type: "chat.complete", sessionId, text: event.text }, sessionId);
      break;
    case "error":
      broadcast({ type: "chat.error", sessionId, error: event.message }, sessionId);
      break;
  }
}

// ── Message Handlers ──

async function handleClientMessage(conn: ClientConnection, msg: ClientMessage): Promise<void> {
  // Auth must come first
  if (msg.type === "auth") {
    const expectedToken = process.env["GATEWAY_TOKEN"];
    if (!expectedToken || msg.token === expectedToken) {
      conn.authenticated = true;
      send(conn, { type: "auth.ok" });
      log.info(`Client ${conn.id} authenticated`);
    } else {
      send(conn, { type: "auth.fail", message: "Invalid token" });
    }
    return;
  }

  // All other messages require auth
  if (!conn.authenticated) {
    send(conn, { type: "error", code: "UNAUTHORIZED", message: "Must authenticate first" });
    return;
  }

  switch (msg.type) {
    case "chat.send": {
      // Subscribe to this session for streaming updates
      conn.subscribedSessions.add(msg.sessionId);

      // Find the session's channel info or create a new one
      const session = getSession(msg.sessionId);
      if (!session) {
        send(conn, { type: "chat.error", sessionId: msg.sessionId, error: "Session not found" });
        return;
      }

      // Run agent with event broadcasting
      const onEvent = (event: RuntimeEvent) => {
        broadcastRuntimeEvent(msg.sessionId, event);
      };

      try {
        const result = await handleMessage("websocket", conn.id, msg.text, onEvent);
        // chat.complete is already sent via onEvent
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        send(conn, { type: "chat.error", sessionId: msg.sessionId, error: errMsg });
      }
      break;
    }

    case "agent.cancel": {
      const success = cancelSessionById(msg.sessionId);
      send(conn, {
        type: "agent.status",
        sessionId: msg.sessionId,
        status: success ? "cancelled" : "not_running",
      });
      break;
    }

    case "agent.status": {
      const session = getSession(msg.sessionId);
      send(conn, {
        type: "agent.status",
        sessionId: msg.sessionId,
        status: session?.status ?? "not_found",
      });
      break;
    }

    case "session.list": {
      const sessions = listSessions();
      const infos: SessionInfo[] = sessions.map((s) => ({
        id: s.id,
        channelType: "unknown",
        channelId: "unknown",
        status: s.status,
        messageCount: s.messages.length,
        createdAt: new Date().toISOString(),
      }));
      send(conn, { type: "session.list", sessions: infos });
      break;
    }

    case "session.create": {
      const session = getOrCreateSession(msg.channelType, msg.channelId);
      conn.subscribedSessions.add(session.id);
      send(conn, { type: "session.created", sessionId: session.id });
      break;
    }
  }
}

function send(conn: ClientConnection, msg: ServerMessage): void {
  if (conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(serializeServerMessage(msg));
  }
}

// ── Server Lifecycle ──

export function startGateway(): void {
  const port = parseInt(process.env["GATEWAY_PORT"] ?? String(DEFAULT_PORT), 10);

  wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    const id = Math.random().toString(36).slice(2, 10);
    const conn: ClientConnection = {
      ws,
      id,
      authenticated: !process.env["GATEWAY_TOKEN"], // auto-auth if no token set
      alive: true,
      subscribedSessions: new Set(),
    };

    connections.set(id, conn);
    log.info(`Client connected: ${id} (auto-auth: ${conn.authenticated})`);

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (isClientMessage(parsed)) {
          handleClientMessage(conn, parsed).catch((err) => {
            log.error(`Handler error: ${err}`);
          });
        } else {
          send(conn, { type: "error", code: "INVALID_MESSAGE", message: "Unknown message type" });
        }
      } catch {
        send(conn, { type: "error", code: "PARSE_ERROR", message: "Invalid JSON" });
      }
    });

    ws.on("pong", () => {
      conn.alive = true;
    });

    ws.on("close", () => {
      connections.delete(id);
      log.debug(`Client disconnected: ${id}`);
    });

    ws.on("error", (err) => {
      log.error(`WebSocket error for ${id}: ${err.message}`);
    });
  });

  // Heartbeat — detect dead connections
  heartbeatTimer = setInterval(() => {
    for (const [id, conn] of connections) {
      if (!conn.alive) {
        conn.ws.terminate();
        connections.delete(id);
        log.debug(`Terminated dead connection: ${id}`);
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  wss.on("listening", () => {
    log.info(`Gateway listening on ws://localhost:${port}`);
  });

  wss.on("error", (err) => {
    log.error(`Gateway server error: ${err.message}`);
  });
}

export function stopGateway(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  for (const conn of connections.values()) {
    conn.ws.close(1001, "Server shutting down");
  }
  connections.clear();

  if (wss) {
    wss.close();
    wss = null;
    log.info("Gateway stopped");
  }
}

export function getConnectionCount(): number {
  return connections.size;
}
