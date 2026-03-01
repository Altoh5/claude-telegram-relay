/**
 * Go - OpenClaw WebSocket Gateway
 *
 * WebSocket server that implements the OpenClaw protocol, enabling
 * Clawsses (Rokid AR glasses bridge) to connect to GoBot's Claude pipeline.
 *
 * Same agents, memory, streaming, and tools as the Telegram bot —
 * just over WebSocket instead of Telegram.
 *
 * Usage: bun run openclaw
 *
 * Env vars:
 *   OPENCLAW_PORT         — WebSocket port (default: 18789)
 *   OPENCLAW_HOST         — Bind address (default: 127.0.0.1)
 *   OPENCLAW_AUTH_TOKEN   — Shared secret for authentication (required)
 */

import { loadEnv, optionalEnv } from "./lib/env";
import {
  type ConnectionData,
  type OpenClawRequest,
  type ConnectParams,
  type ChatSendParams,
  Methods,
  Events,
  sendResponse,
  sendEvent,
  sendError,
  parseMessage,
} from "./lib/openclaw/protocol";
import {
  createDefaultSessions,
  createSession,
  listSessions,
  getDefaultSessionKey,
  type Session,
} from "./lib/openclaw/session-manager";
import { handleChatSend } from "./lib/openclaw/chat-handler";

// ---------------------------------------------------------------------------
// 1. Load Environment
// ---------------------------------------------------------------------------

await loadEnv();

const PORT = parseInt(optionalEnv("OPENCLAW_PORT", "18789"), 10);
const HOST = optionalEnv("OPENCLAW_HOST", "127.0.0.1");
const AUTH_TOKEN = optionalEnv("OPENCLAW_AUTH_TOKEN", "");

if (!AUTH_TOKEN) {
  console.error(
    "[openclaw] WARNING: OPENCLAW_AUTH_TOKEN is not set. " +
      "Any client can connect without authentication. " +
      "Set OPENCLAW_AUTH_TOKEN in .env for security."
  );
}

// ---------------------------------------------------------------------------
// 2. Per-connection session storage (in-memory, keyed by deviceToken)
// ---------------------------------------------------------------------------

const connectionSessions = new Map<string, Map<string, Session>>();

// ---------------------------------------------------------------------------
// 3. Request queue per connection (process sequentially)
// ---------------------------------------------------------------------------

const connectionQueues = new Map<string, Promise<void>>();

function enqueue(
  deviceToken: string,
  fn: () => Promise<void>
): void {
  const prev = connectionQueues.get(deviceToken) || Promise.resolve();
  const next = prev.then(fn).catch((err) => {
    console.error(`[openclaw] Queue error for ${deviceToken}:`, err);
  });
  connectionQueues.set(deviceToken, next);
}

// ---------------------------------------------------------------------------
// 4. Auth helpers
// ---------------------------------------------------------------------------

function validateToken(provided: string): boolean {
  if (!AUTH_TOKEN) return true; // No token set = allow all (dev mode)

  // Constant-time comparison
  const expected = new TextEncoder().encode(AUTH_TOKEN);
  const actual = new TextEncoder().encode(provided);

  if (expected.length !== actual.length) return false;

  const { timingSafeEqual } = require("crypto");
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// 5. Request handler
// ---------------------------------------------------------------------------

function handleRequest(
  ws: import("bun").ServerWebSocket<ConnectionData>,
  req: OpenClawRequest
): void {
  // Before auth, only accept "connect" requests
  if (!ws.data.authenticated && req.method !== Methods.CONNECT) {
    sendError(ws, req.id, "not_authenticated", "Must connect first");
    return;
  }

  switch (req.method) {
    case Methods.CONNECT:
      handleConnect(ws, req);
      break;

    case Methods.CHAT_SEND:
      handleChat(ws, req);
      break;

    case Methods.SESSION_LIST:
      handleSessionList(ws, req);
      break;

    case Methods.SESSION_CREATE:
      handleSessionCreate(ws, req);
      break;

    case Methods.SESSION_RUN:
      handleSessionRun(ws, req);
      break;

    default:
      sendError(ws, req.id, "unknown_method", `Unknown method: ${req.method}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Method handlers
// ---------------------------------------------------------------------------

function handleConnect(
  ws: import("bun").ServerWebSocket<ConnectionData>,
  req: OpenClawRequest
): void {
  const params = req.params as unknown as ConnectParams;
  const token = params?.auth?.token || "";

  if (!validateToken(token)) {
    sendError(ws, req.id, "auth_failed", "Invalid authentication token");
    ws.close(1008, "Authentication failed");
    return;
  }

  // Generate device token
  const deviceToken = crypto.randomUUID();
  ws.data.authenticated = true;
  ws.data.deviceToken = deviceToken;

  // Create default sessions for this connection
  const sessions = createDefaultSessions();
  connectionSessions.set(deviceToken, sessions);

  // Set default active session
  ws.data.activeSessionKey = getDefaultSessionKey(sessions);

  console.log(
    `[openclaw] Device authenticated: ${deviceToken} (${sessions.size} sessions)`
  );

  sendResponse(ws, req.id, true, {
    deviceToken,
    sessionCount: sessions.size,
  });

  // Send initial session list
  sendEvent(ws, "session.list", {
    sessions: listSessions(sessions),
    currentSessionKey: ws.data.activeSessionKey || null,
  });
}

function handleChat(
  ws: import("bun").ServerWebSocket<ConnectionData>,
  req: OpenClawRequest
): void {
  const params = req.params as unknown as ChatSendParams;

  if (!params?.message) {
    sendError(ws, req.id, "invalid_params", "Missing message parameter");
    return;
  }

  // Use active session if no sessionKey provided
  const sessionKey = params.sessionKey || ws.data.activeSessionKey;
  if (!sessionKey) {
    sendError(ws, req.id, "no_session", "No active session");
    return;
  }

  const deviceToken = ws.data.deviceToken!;
  const sessions = connectionSessions.get(deviceToken);
  if (!sessions) {
    sendError(ws, req.id, "no_sessions", "Session store not found");
    return;
  }

  // Queue the chat request (sequential per connection)
  enqueue(deviceToken, () =>
    handleChatSend(ws, req.id, { ...params, sessionKey }, sessions)
  );
}

function handleSessionList(
  ws: import("bun").ServerWebSocket<ConnectionData>,
  req: OpenClawRequest
): void {
  const deviceToken = ws.data.deviceToken!;
  const sessions = connectionSessions.get(deviceToken);

  if (!sessions) {
    sendResponse(ws, req.id, true, { sessions: [] });
    return;
  }

  sendResponse(ws, req.id, true, {
    sessions: listSessions(sessions),
    currentSessionKey: ws.data.activeSessionKey || null,
  });
}

function handleSessionCreate(
  ws: import("bun").ServerWebSocket<ConnectionData>,
  req: OpenClawRequest
): void {
  const params = req.params as { agentName?: string; name?: string };
  const agentName = params?.agentName || "general";
  const deviceToken = ws.data.deviceToken!;
  const sessions = connectionSessions.get(deviceToken);

  if (!sessions) {
    sendError(ws, req.id, "no_sessions", "Session store not found");
    return;
  }

  const session = createSession(sessions, agentName);
  ws.data.activeSessionKey = session.key;

  console.log(
    `[openclaw] Session created: ${session.name} (${session.key})`
  );

  sendResponse(ws, req.id, true, {
    session: {
      key: session.key,
      name: session.name,
      agentName: session.agentName,
      createdAt: session.createdAt,
    },
  });
}

function handleSessionRun(
  ws: import("bun").ServerWebSocket<ConnectionData>,
  req: OpenClawRequest
): void {
  const params = req.params as { sessionKey?: string };
  const sessionKey = params?.sessionKey;

  if (!sessionKey) {
    sendError(ws, req.id, "invalid_params", "Missing sessionKey");
    return;
  }

  const deviceToken = ws.data.deviceToken!;
  const sessions = connectionSessions.get(deviceToken);

  if (!sessions || !sessions.has(sessionKey)) {
    sendError(ws, req.id, "not_found", "Session not found");
    return;
  }

  ws.data.activeSessionKey = sessionKey;
  const session = sessions.get(sessionKey)!;

  console.log(`[openclaw] Switched to session: ${session.name}`);

  sendResponse(ws, req.id, true, {
    session: {
      key: session.key,
      name: session.name,
      agentName: session.agentName,
    },
  });
}

// ---------------------------------------------------------------------------
// 7. WebSocket Server
// ---------------------------------------------------------------------------

const server = Bun.serve<ConnectionData>({
  port: PORT,
  hostname: HOST,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "openclaw-gateway",
        connections: connectionSessions.size,
        timestamp: Date.now(),
      });
    }

    // WebSocket upgrade
    if (url.pathname === "/" || url.pathname === "/ws") {
      const success = server.upgrade(req, {
        data: {
          authenticated: false,
        } as ConnectionData,
      });
      if (success) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      console.log("[openclaw] New connection");

      // Send connect.challenge
      const nonce = crypto.randomUUID();
      ws.data.nonce = nonce;
      sendEvent(ws, Events.CONNECT_CHALLENGE, { nonce });
    },

    message(ws, message) {
      const req = parseMessage(message);
      if (!req) {
        console.warn("[openclaw] Invalid message received");
        return;
      }

      handleRequest(ws, req);
    },

    close(ws, code, reason) {
      const deviceToken = ws.data.deviceToken;
      console.log(
        `[openclaw] Connection closed: ${code} ${reason || ""} (device: ${deviceToken || "unauthenticated"})`
      );

      // Cleanup
      if (deviceToken) {
        connectionSessions.delete(deviceToken);
        connectionQueues.delete(deviceToken);
      }
    },
  },
});

console.log(
  `OpenClaw Gateway running on ws://${HOST}:${PORT}`
);
console.log(
  `Health check: http://${HOST}:${PORT}/health`
);
if (!AUTH_TOKEN) {
  console.log(
    "WARNING: No OPENCLAW_AUTH_TOKEN set — running without authentication"
  );
}

// ---------------------------------------------------------------------------
// 8. Graceful Shutdown
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => {
  console.log("[openclaw] SIGTERM received, shutting down...");
  server.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[openclaw] SIGINT received, shutting down...");
  server.stop();
  process.exit(0);
});
