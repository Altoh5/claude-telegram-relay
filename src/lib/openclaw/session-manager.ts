/**
 * OpenClaw Session Manager — Maps GoBot agents to OpenClaw sessions.
 *
 * Each GoBot agent (general, research, content, finance, strategy, critic)
 * becomes an OpenClaw "session" that the AR glasses can switch between.
 */

import { getAgentConfig } from "../../agents/base";
import type { SessionInfo } from "./protocol";

export interface Session {
  key: string;
  name: string;
  agentName: string;
  createdAt: string;
  /** Claude Code subprocess session ID for resumption. */
  claudeSessionId?: string;
}

const AGENT_NAMES = [
  "general",
  "research",
  "content",
  "finance",
  "strategy",
  "critic",
];

/**
 * Create the default set of sessions — one per GoBot agent.
 */
export function createDefaultSessions(): Map<string, Session> {
  const sessions = new Map<string, Session>();

  for (const agentName of AGENT_NAMES) {
    const config = getAgentConfig(agentName);
    const key = crypto.randomUUID();
    sessions.set(key, {
      key,
      name: config?.name || agentName,
      agentName,
      createdAt: new Date().toISOString(),
    });
  }

  return sessions;
}

/**
 * Create a new session for a specific agent.
 */
export function createSession(
  sessions: Map<string, Session>,
  agentName: string
): Session {
  const config = getAgentConfig(agentName);
  const key = crypto.randomUUID();
  const session: Session = {
    key,
    name: config?.name || agentName,
    agentName,
    createdAt: new Date().toISOString(),
  };
  sessions.set(key, session);
  return session;
}

/**
 * Get the first session key (default active session).
 * Returns the "general" agent's session if available.
 */
export function getDefaultSessionKey(
  sessions: Map<string, Session>
): string | undefined {
  for (const [key, session] of sessions) {
    if (session.agentName === "general") return key;
  }
  // Fallback to first session
  const first = sessions.keys().next();
  return first.done ? undefined : first.value;
}

/**
 * Convert sessions map to a list of SessionInfo for the wire protocol.
 */
export function listSessions(
  sessions: Map<string, Session>
): SessionInfo[] {
  return Array.from(sessions.values()).map((s) => ({
    key: s.key,
    name: s.name,
    agentName: s.agentName,
    createdAt: s.createdAt,
  }));
}

/**
 * Update the Claude session ID for a session (for subprocess resumption).
 */
export function updateClaudeSessionId(
  sessions: Map<string, Session>,
  sessionKey: string,
  claudeSessionId: string
): void {
  const session = sessions.get(sessionKey);
  if (session) {
    session.claudeSessionId = claudeSessionId;
  }
}
