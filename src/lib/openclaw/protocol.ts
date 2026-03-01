/**
 * OpenClaw Gateway Protocol — TypeScript types and helpers.
 *
 * Implements the wire format used by Clawsses (AR glasses bridge).
 * All WebSocket frames are JSON. Three message types:
 * - req  (client → server): method calls
 * - res  (server → client): method responses
 * - event (server → client): server-pushed events
 */

import type { ServerWebSocket } from "bun";

// ---------------------------------------------------------------------------
// Wire format types
// ---------------------------------------------------------------------------

export interface OpenClawRequest {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface OpenClawResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface OpenClawEvent {
  type: "event";
  event: string;
  payload: Record<string, unknown>;
  seq?: number;
  stateVersion?: number;
}

// ---------------------------------------------------------------------------
// Method constants
// ---------------------------------------------------------------------------

export const Methods = {
  CONNECT: "connect",
  CHAT_SEND: "chat.send",
  SESSION_LIST: "session.list",
  SESSION_CREATE: "session.create",
  SESSION_RUN: "session.run",
} as const;

export const Events = {
  CONNECT_CHALLENGE: "connect.challenge",
  CHAT: "chat",
  PRESENCE: "presence",
} as const;

// ---------------------------------------------------------------------------
// Typed params / payloads
// ---------------------------------------------------------------------------

export interface ChatSendParams {
  sessionKey: string;
  message: string;
  idempotencyKey?: string;
  images?: Array<{ base64: string; mediaType: string }>;
}

export interface ChatDeltaPayload {
  state: "delta" | "final";
  text: string;
  runId: string;
}

export interface SessionInfo {
  key: string;
  name: string;
  agentName: string;
  createdAt: string;
}

export interface ConnectParams {
  client?: {
    id?: string;
    mode?: string;
    role?: string;
    scopes?: string[];
  };
  auth?: {
    kind?: string;
    token?: string;
    deviceId?: string;
    device?: {
      publicKey?: string;
      signature?: string;
    };
    nonce?: string;
  };
  protocol?: number;
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

export interface ConnectionData {
  authenticated: boolean;
  deviceToken?: string;
  activeSessionKey?: string;
  nonce?: string;
  /** Abort controller for the currently-running Claude subprocess. */
  abortController?: AbortController;
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

export function sendResponse<T extends Record<string, unknown>>(
  ws: ServerWebSocket<ConnectionData>,
  id: string,
  ok: boolean,
  payload?: T
): void {
  const msg: OpenClawResponse = { type: "res", id, ok };
  if (payload) msg.payload = payload;
  ws.send(JSON.stringify(msg));
}

export function sendError(
  ws: ServerWebSocket<ConnectionData>,
  id: string,
  code: string,
  message: string
): void {
  const msg: OpenClawResponse = {
    type: "res",
    id,
    ok: false,
    error: { code, message },
  };
  ws.send(JSON.stringify(msg));
}

export function sendEvent(
  ws: ServerWebSocket<ConnectionData>,
  event: string,
  payload: Record<string, unknown>,
  seq?: number
): void {
  const msg: OpenClawEvent = { type: "event", event, payload };
  if (seq !== undefined) msg.seq = seq;
  ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

export function parseMessage(
  raw: string | Buffer
): OpenClawRequest | null {
  try {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const parsed = JSON.parse(data);
    if (parsed && parsed.type === "req" && parsed.id && parsed.method) {
      return parsed as OpenClawRequest;
    }
    return null;
  } catch {
    return null;
  }
}
