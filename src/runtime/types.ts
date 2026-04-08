/**
 * Runtime types — shared type definitions for the embedded agent runtime.
 */

import type Anthropic from "@anthropic-ai/sdk";

// ── Runtime Events ──

export type RuntimeEvent =
  | { readonly kind: "token"; readonly text: string }
  | {
      readonly kind: "tool_start";
      readonly toolName: string;
      readonly toolInput: Record<string, unknown>;
      readonly toolUseId: string;
    }
  | {
      readonly kind: "tool_end";
      readonly toolName: string;
      readonly toolUseId: string;
      readonly result: string;
      readonly isError: boolean;
    }
  | {
      readonly kind: "message_complete";
      readonly text: string;
      readonly toolCalls: number;
      readonly iterations: number;
    }
  | { readonly kind: "error"; readonly message: string; readonly retryable: boolean }
  | { readonly kind: "status"; readonly message: string };

export type EventCallback = (event: RuntimeEvent) => void;

// ── Runtime Options ──

export interface RuntimeOptions {
  readonly model: string;
  readonly maxTokens: number;
  readonly maxIterations: number;
  readonly signal?: AbortSignal;
  readonly onEvent: EventCallback;
}

// ── Agent Session ──

export type SessionStatus = "idle" | "running" | "cancelled";

export type MessageParam = Anthropic.MessageParam;
export type ContentBlock = Anthropic.ContentBlock;
export type ToolResultBlockParam = Anthropic.ToolResultBlockParam;
export type ContentArray = Anthropic.MessageCreateParams["messages"][0]["content"];

export interface AgentSession {
  readonly id: string;
  readonly messages: readonly MessageParam[];
  readonly status: SessionStatus;
  readonly abortController: AbortController | null;
}

// ── Tool Result ──

export interface ToolResult {
  text: string;
  base64Image?: string;
}
