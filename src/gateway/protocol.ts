/**
 * Gateway protocol — typed message definitions for WebSocket communication.
 *
 * Uses discriminated unions (no Zod) for type safety. The `type` field
 * is the discriminant. Manual type guards provide runtime validation.
 */

// ── Media Attachments ──

export interface MediaAttachment {
  readonly kind: "image" | "document";
  readonly base64: string;
  readonly mimeType: string;
  readonly filename?: string;
}

// ── Session Info ──

export interface SessionInfo {
  readonly id: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly status: string;
  readonly messageCount: number;
  readonly createdAt: string;
}

// ── Client → Gateway Messages ──

export type ClientMessage =
  | { readonly type: "chat.send"; readonly id: string; readonly sessionId: string; readonly text: string; readonly media?: readonly MediaAttachment[] }
  | { readonly type: "agent.cancel"; readonly sessionId: string }
  | { readonly type: "agent.status"; readonly sessionId: string }
  | { readonly type: "session.list" }
  | { readonly type: "session.create"; readonly channelType: string; readonly channelId: string }
  | { readonly type: "auth"; readonly token: string };

// ── Gateway → Client Messages ──

export type ServerMessage =
  | { readonly type: "chat.token"; readonly sessionId: string; readonly text: string }
  | { readonly type: "chat.tool_start"; readonly sessionId: string; readonly toolName: string; readonly toolInput: Record<string, unknown> }
  | { readonly type: "chat.tool_end"; readonly sessionId: string; readonly toolName: string; readonly result: string; readonly isError: boolean }
  | { readonly type: "chat.complete"; readonly sessionId: string; readonly text: string }
  | { readonly type: "chat.error"; readonly sessionId: string; readonly error: string }
  | { readonly type: "agent.status"; readonly sessionId: string; readonly status: string }
  | { readonly type: "session.list"; readonly sessions: readonly SessionInfo[] }
  | { readonly type: "session.created"; readonly sessionId: string }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "auth.ok" }
  | { readonly type: "auth.fail"; readonly message: string };

// ── Type Guards ──

const CLIENT_MESSAGE_TYPES = new Set([
  "chat.send", "agent.cancel", "agent.status",
  "session.list", "session.create", "auth",
]);

export function isClientMessage(msg: unknown): msg is ClientMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  if (typeof obj["type"] !== "string") return false;
  if (!CLIENT_MESSAGE_TYPES.has(obj["type"])) return false;

  switch (obj["type"]) {
    case "chat.send":
      return typeof obj["id"] === "string" &&
             typeof obj["sessionId"] === "string" &&
             typeof obj["text"] === "string";
    case "agent.cancel":
    case "agent.status":
      return typeof obj["sessionId"] === "string";
    case "session.list":
      return true;
    case "session.create":
      return typeof obj["channelType"] === "string" &&
             typeof obj["channelId"] === "string";
    case "auth":
      return typeof obj["token"] === "string";
    default:
      return false;
  }
}

export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
