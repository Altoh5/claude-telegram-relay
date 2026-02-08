/**
 * Supabase Client Module
 *
 * Singleton Supabase client with message persistence, semantic search,
 * memory (facts/goals), and logging. Uses edge functions for embeddings
 * when available, falls back to text search.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  id?: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface MemoryItem {
  id?: string;
  type: "fact" | "goal";
  content: string;
  deadline?: string;
  completed?: boolean;
  completed_at?: string;
  created_at?: string;
}

export interface LogEntry {
  id?: string;
  level: "info" | "warn" | "error" | "debug";
  service: string;
  message: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

// ---------------------------------------------------------------------------
// Singleton Client
// ---------------------------------------------------------------------------

let client: SupabaseClient | null = null;

/**
 * Get or create the singleton Supabase client.
 * Returns null if required env vars are missing.
 */
export function getSupabase(): SupabaseClient | null {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) return null;

  client = createClient(url, key);
  return client;
}

/**
 * Whether Supabase is configured and available.
 */
export function isSupabaseEnabled(): boolean {
  return getSupabase() !== null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Human-readable relative time (e.g. "2 minutes ago", "1 hour ago").
 */
export function getTimeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString();
}

/**
 * Parse natural-language relative dates into ISO strings.
 * Supports: "today", "tomorrow", "in N days", "in N hours",
 * bare times like "5pm" / "17:00", and ISO date strings.
 */
export function parseRelativeDate(input: string): string | undefined {
  if (!input) return undefined;

  const lower = input.trim().toLowerCase();
  const now = new Date();

  if (lower === "today") {
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  if (lower === "tomorrow") {
    now.setDate(now.getDate() + 1);
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  // "in N days"
  const inDays = lower.match(/^in\s+(\d+)\s+days?$/);
  if (inDays) {
    now.setDate(now.getDate() + parseInt(inDays[1], 10));
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  // "in N hours"
  const inHours = lower.match(/^in\s+(\d+)\s+hours?$/);
  if (inHours) {
    now.setHours(now.getHours() + parseInt(inHours[1], 10));
    return now.toISOString();
  }

  // "in N weeks"
  const inWeeks = lower.match(/^in\s+(\d+)\s+weeks?$/);
  if (inWeeks) {
    now.setDate(now.getDate() + parseInt(inWeeks[1], 10) * 7);
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  // Bare time: "5pm", "5:30pm", "17:00"
  const timeMatch = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3];

    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;

    now.setHours(hours, minutes, 0, 0);
    // If that time already passed today, use tomorrow
    if (now.getTime() < Date.now()) {
      now.setDate(now.getDate() + 1);
    }
    return now.toISOString();
  }

  // Try ISO date string
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Save a message. Uses the edge function endpoint for embedding generation
 * when available, falls back to direct insert.
 */
export async function saveMessage(message: Message): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  const url = process.env.SUPABASE_URL;

  // Try edge function first (generates embeddings for semantic search)
  try {
    const edgeUrl = `${url}/functions/v1/store-telegram-message`;
    const response = await fetch(edgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${
          process.env.SUPABASE_SERVICE_ROLE_KEY ||
          process.env.SUPABASE_ANON_KEY ||
          ""
        }`,
      },
      body: JSON.stringify({
        chat_id: message.chat_id,
        role: message.role,
        content: message.content,
        metadata: message.metadata || {},
      }),
    });

    if (response.ok) return true;
  } catch {
    // Edge function unavailable, fall through to direct insert
  }

  // Direct insert fallback (no embeddings)
  try {
    const { error } = await sb.from("messages").insert({
      chat_id: message.chat_id,
      role: message.role,
      content: message.content,
      metadata: message.metadata || {},
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Retrieve the N most recent messages for a chat, ordered chronologically.
 */
export async function getRecentMessages(
  chatId: string,
  limit: number = 20
): Promise<Message[]> {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    const { data, error } = await sb
      .from("messages")
      .select("*")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return (data as Message[]).reverse();
  } catch {
    return [];
  }
}

/**
 * Build a formatted conversation context string from recent messages.
 * Returns lines like: "[2m ago] User: hello" / "[1m ago] Bot: hi there"
 */
export async function getConversationContext(
  chatId: string,
  limit: number = 10
): Promise<string> {
  const messages = await getRecentMessages(chatId, limit);
  if (messages.length === 0) return "";

  return messages
    .map((msg) => {
      const time = msg.created_at ? getTimeAgo(new Date(msg.created_at)) : "";
      const speaker = msg.role === "user" ? "User" : "Bot";
      return `[${time}] ${speaker}: ${msg.content}`;
    })
    .join("\n");
}

/**
 * Semantic search across messages using the edge function.
 * Falls back to basic text search (ilike) when edge function is unavailable.
 */
export async function searchMessages(
  chatId: string,
  query: string,
  limit: number = 10
): Promise<Message[]> {
  const sb = getSupabase();
  if (!sb) return [];

  const url = process.env.SUPABASE_URL;

  // Try semantic search via edge function
  try {
    const edgeUrl = `${url}/functions/v1/search-memory`;
    const response = await fetch(edgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${
          process.env.SUPABASE_SERVICE_ROLE_KEY ||
          process.env.SUPABASE_ANON_KEY ||
          ""
        }`,
      },
      body: JSON.stringify({ chat_id: chatId, query, limit }),
    });

    if (response.ok) {
      const results = await response.json();
      return (results as Message[]) || [];
    }
  } catch {
    // Edge function unavailable, fall through to text search
  }

  // Fallback: basic text search
  try {
    const { data, error } = await sb
      .from("messages")
      .select("*")
      .eq("chat_id", chatId)
      .ilike("content", `%${query}%`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data as Message[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory: Facts
// ---------------------------------------------------------------------------

/**
 * Store a fact in the memory table.
 */
export async function addFact(content: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { error } = await sb
      .from("memory")
      .insert({ type: "fact", content });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Retrieve all stored facts.
 */
export async function getFacts(): Promise<MemoryItem[]> {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    const { data, error } = await sb
      .from("memory")
      .select("*")
      .eq("type", "fact")
      .order("created_at", { ascending: false });

    if (error || !data) return [];
    return data as MemoryItem[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory: Goals
// ---------------------------------------------------------------------------

/**
 * Add a goal, optionally with a deadline (natural language or ISO).
 */
export async function addGoal(
  content: string,
  deadline?: string
): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  const parsedDeadline = deadline ? parseRelativeDate(deadline) : undefined;

  try {
    const { error } = await sb.from("memory").insert({
      type: "goal",
      content,
      deadline: parsedDeadline,
      completed: false,
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Mark a goal as completed by partial text match.
 * Returns true if at least one goal was updated.
 */
export async function completeGoal(searchText: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { data: goals } = await sb
      .from("memory")
      .select("id, content")
      .eq("type", "goal")
      .eq("completed", false)
      .ilike("content", `%${searchText}%`);

    if (!goals || goals.length === 0) return false;

    const { error } = await sb
      .from("memory")
      .update({ completed: true, completed_at: new Date().toISOString() })
      .eq("id", goals[0].id);

    return !error;
  } catch {
    return false;
  }
}

/**
 * Get all active (incomplete) goals.
 */
export async function getActiveGoals(): Promise<MemoryItem[]> {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    const { data, error } = await sb
      .from("memory")
      .select("*")
      .eq("type", "goal")
      .eq("completed", false)
      .order("created_at", { ascending: true });

    if (error || !data) return [];
    return data as MemoryItem[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory Context
// ---------------------------------------------------------------------------

/**
 * Format goals into a readable list.
 */
export function formatGoalsList(goals: MemoryItem[]): string {
  if (goals.length === 0) return "No active goals.";
  return goals
    .map((g, i) => {
      const deadline = g.deadline
        ? ` (due: ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      return `${i + 1}. ${g.content}${deadline}`;
    })
    .join("\n");
}

/**
 * Format facts into a readable list.
 */
export function formatFactsList(facts: MemoryItem[]): string {
  if (facts.length === 0) return "No stored facts.";
  return facts.map((f) => `- ${f.content}`).join("\n");
}

/**
 * Build a combined memory context string with facts and goals.
 */
export async function getMemoryContext(): Promise<string> {
  const [facts, goals] = await Promise.all([getFacts(), getActiveGoals()]);

  const sections: string[] = [];

  if (facts.length > 0) {
    sections.push(`**Known Facts:**\n${formatFactsList(facts)}`);
  }

  if (goals.length > 0) {
    sections.push(`**Active Goals:**\n${formatGoalsList(goals)}`);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Write a log entry to Supabase. Fails silently.
 */
export async function log(
  level: LogEntry["level"],
  service: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  try {
    await sb.from("logs").insert({ level, service, message, metadata });
  } catch {
    // Logging should never throw
  }
}

// ---------------------------------------------------------------------------
// Connection Test
// ---------------------------------------------------------------------------

/**
 * Test the Supabase connection. Returns a descriptive status string.
 */
export async function testConnection(): Promise<string> {
  const sb = getSupabase();
  if (!sb) {
    return "Supabase not configured (missing SUPABASE_URL or key env vars).";
  }

  try {
    const { error } = await sb.from("messages").select("id").limit(1);
    if (error) return `Supabase connection error: ${error.message}`;
    return "Supabase connection OK.";
  } catch (err) {
    return `Supabase connection failed: ${err}`;
  }
}
