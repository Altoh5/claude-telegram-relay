/**
 * Convex Client Module
 *
 * Drop-in replacement for supabase.ts. Uses ConvexHttpClient to talk to
 * the Convex backend. Every exported function has the **identical** signature
 * and return type as its supabase.ts counterpart so that the db.ts router
 * can switch between backends without consumers noticing.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type {
  Message,
  MemoryItem,
  LogEntry,
  AsyncTask,
} from "./supabase";
import {
  getTimeAgo,
  parseRelativeDate,
  formatGoalsList,
  formatFactsList,
} from "./supabase";

// Re-export utilities so consumers can import from either module
export {
  getTimeAgo,
  parseRelativeDate,
  formatGoalsList,
  formatFactsList,
};
// Re-export types
export type { Message, MemoryItem, LogEntry, AsyncTask };

// ---------------------------------------------------------------------------
// Singleton Client
// ---------------------------------------------------------------------------

let client: ConvexHttpClient | null = null;

/**
 * Get or create the singleton Convex HTTP client.
 * Returns null if CONVEX_URL is not set.
 */
export function getConvex(): ConvexHttpClient | null {
  if (client) return client;

  const url = process.env.CONVEX_URL;
  if (!url) return null;

  client = new ConvexHttpClient(url);
  return client;
}

/**
 * Whether Convex is configured and available.
 * Matches the isSupabaseEnabled() signature.
 */
export function isSupabaseEnabled(): boolean {
  return getConvex() !== null;
}

// ---------------------------------------------------------------------------
// Embedding Helper (private)
// ---------------------------------------------------------------------------

/**
 * Generate an embedding vector via OpenAI text-embedding-ada-002.
 * Returns [] if OPENAI_API_KEY is not set or the call fails.
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-ada-002",
        input: text,
      }),
    });

    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: { embedding: number[] }[];
    };
    return json.data?.[0]?.embedding ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Type Converters (Convex doc -> consumer types)
// ---------------------------------------------------------------------------

/** Convert a Convex messages document to the consumer Message type. */
function toMessage(doc: any): Message {
  return {
    id: doc._id,
    chat_id: doc.chat_id,
    role: doc.role,
    content: doc.content,
    metadata: doc.metadata,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

/** Convert a Convex memory document to the consumer MemoryItem type. */
function toMemoryItem(doc: any): MemoryItem {
  return {
    id: doc._id,
    type: doc.type,
    content: doc.content,
    deadline: doc.deadline
      ? new Date(doc.deadline).toISOString()
      : undefined,
    completed_at: doc.completed_at
      ? new Date(doc.completed_at).toISOString()
      : undefined,
    priority: doc.priority,
    metadata: doc.metadata,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

/** Convert a Convex asyncTasks document to the consumer AsyncTask type. */
function toAsyncTask(doc: any): AsyncTask {
  return {
    id: doc._id,
    created_at: new Date(doc._creationTime).toISOString(),
    updated_at: doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : new Date(doc._creationTime).toISOString(),
    chat_id: doc.chat_id,
    original_prompt: doc.original_prompt,
    status: doc.status,
    result: doc.result,
    session_id: doc.session_id,
    current_step: doc.current_step,
    pending_question: doc.pending_question,
    pending_options: doc.pending_options,
    user_response: doc.user_response,
    thread_id: doc.thread_id,
    processed_by: doc.processed_by,
    reminder_sent: doc.reminder_sent,
    metadata: doc.metadata,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Save a message to Convex. Fire-and-forget embedding backfill if
 * OPENAI_API_KEY is set.
 */
export async function saveMessage(message: Message): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;

  try {
    const id = await cx.mutation(api.messages.insert, {
      chat_id: message.chat_id,
      role: message.role,
      content: message.content,
      metadata: message.metadata ?? {},
    });

    // Fire-and-forget embedding backfill
    if (process.env.OPENAI_API_KEY) {
      generateEmbedding(message.content).then(async (embedding) => {
        if (embedding.length > 0) {
          try {
            await cx.mutation(api.messages.backfillEmbedding, {
              id,
              embedding,
            });
          } catch {
            // best-effort
          }
        }
      });
    }

    return true;
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
  const cx = getConvex();
  if (!cx) return [];

  try {
    const docs = await cx.query(api.messages.getRecent, {
      chat_id: chatId,
      limit,
    });
    return docs.map(toMessage);
  } catch {
    return [];
  }
}

/**
 * Build a formatted conversation context string from recent messages.
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
 * Semantic vector search across messages. Falls back to empty results
 * if embeddings are unavailable.
 */
export async function searchMessages(
  chatId: string,
  query: string,
  limit: number = 10
): Promise<Message[]> {
  const cx = getConvex();
  if (!cx) return [];

  try {
    const embedding = await generateEmbedding(query);
    if (embedding.length === 0) return [];

    const docs = await cx.action(api.messages.searchByVector, {
      chat_id: chatId,
      embedding,
      limit,
    });
    return docs.map(toMessage);
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
  const cx = getConvex();
  if (!cx) return false;

  try {
    await cx.mutation(api.memory.insert, { type: "fact" as const, content });
    return true;
  } catch {
    return false;
  }
}

/**
 * Retrieve all stored facts.
 */
export async function getFacts(): Promise<MemoryItem[]> {
  const cx = getConvex();
  if (!cx) return [];

  try {
    const docs = await cx.query(api.memory.getByType, {
      type: "fact" as const,
    });
    // Return newest first (matching Supabase behaviour)
    return docs.map(toMemoryItem).reverse();
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
  const cx = getConvex();
  if (!cx) return false;

  const parsedDeadline = deadline ? parseRelativeDate(deadline) : undefined;
  // Convex schema stores deadline as epoch ms (number)
  const deadlineMs = parsedDeadline
    ? new Date(parsedDeadline).getTime()
    : undefined;

  try {
    await cx.mutation(api.memory.insert, {
      type: "goal" as const,
      content,
      deadline: deadlineMs,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark a goal as completed by partial text match.
 */
export async function completeGoal(searchText: string): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;

  try {
    const matches = await cx.query(api.memory.findByContent, {
      type: "goal" as const,
      search: searchText,
    });
    // Filter to active goals only (no completed_at)
    const active = matches.filter((m: any) => !m.completed_at);
    if (active.length === 0) return false;

    await cx.mutation(api.memory.patch, {
      id: active[0]._id,
      updates: {
        type: "completed_goal",
        completed_at: Date.now(),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a fact by partial text match.
 */
export async function deleteFact(searchText: string): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;

  try {
    const matches = await cx.query(api.memory.findByContent, {
      type: "fact" as const,
      search: searchText,
    });
    if (matches.length === 0) return false;

    await cx.mutation(api.memory.remove, { id: matches[0]._id });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cancel (delete) a goal by partial text match.
 */
export async function cancelGoal(searchText: string): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;

  try {
    const matches = await cx.query(api.memory.findByContent, {
      type: "goal" as const,
      search: searchText,
    });
    // Filter to active goals only
    const active = matches.filter((m: any) => !m.completed_at);
    if (active.length === 0) return false;

    await cx.mutation(api.memory.remove, { id: active[0]._id });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all active (incomplete) goals.
 */
export async function getActiveGoals(): Promise<MemoryItem[]> {
  const cx = getConvex();
  if (!cx) return [];

  try {
    const docs = await cx.query(api.memory.getByType, {
      type: "goal" as const,
    });
    // Filter out completed goals and return oldest first
    return docs
      .filter((d: any) => !d.completed_at)
      .map(toMemoryItem);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory Context
// ---------------------------------------------------------------------------

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
 * Write a log entry to Convex. Fails silently.
 * Maps the `service` parameter to the Convex `event` field.
 */
export async function log(
  level: LogEntry["level"],
  service: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const cx = getConvex();
  if (!cx) return;

  try {
    await cx.mutation(api.logs.insert, {
      level,
      event: service,
      message,
      metadata: metadata ?? {},
    });
  } catch {
    // Logging should never throw
  }
}

// ---------------------------------------------------------------------------
// Async Tasks (Human-in-the-Loop)
// ---------------------------------------------------------------------------

/**
 * Create a new async task.
 */
export async function createTask(
  chatId: string,
  originalPrompt: string,
  threadId?: number,
  processedBy?: string
): Promise<AsyncTask | null> {
  const cx = getConvex();
  if (!cx) return null;

  try {
    const id = await cx.mutation(api.asyncTasks.insert, {
      chat_id: chatId,
      original_prompt: originalPrompt,
      status: "running" as const,
      thread_id: threadId,
      processed_by: processedBy,
    });

    // Fetch the full document to return
    const doc = await cx.query(api.asyncTasks.getById, { id });
    if (!doc) return null;
    return toAsyncTask(doc);
  } catch (err) {
    console.error("createTask exception:", err);
    return null;
  }
}

/**
 * Update an async task's fields.
 */
export async function updateTask(
  taskId: string,
  updates: Partial<Omit<AsyncTask, "id" | "created_at">>
): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;

  try {
    // Convert consumer-facing field names to Convex schema fields
    const convexUpdates: Record<string, any> = { ...updates };

    // The consumer may pass updated_at — we strip it because Convex
    // sets updatedAt automatically in the mutation handler.
    delete convexUpdates.updated_at;

    await cx.mutation(api.asyncTasks.patch, {
      id: taskId as any, // Convex Id type
      updates: convexUpdates,
    });
    return true;
  } catch (err) {
    console.error("updateTask error:", err);
    return false;
  }
}

/**
 * Get a task by its ID.
 */
export async function getTaskById(taskId: string): Promise<AsyncTask | null> {
  const cx = getConvex();
  if (!cx) return null;

  try {
    const doc = await cx.query(api.asyncTasks.getById, {
      id: taskId as any,
    });
    if (!doc) return null;
    return toAsyncTask(doc);
  } catch {
    return null;
  }
}

/**
 * Get tasks waiting for user input in a specific chat.
 */
export async function getPendingTasks(chatId: string): Promise<AsyncTask[]> {
  const cx = getConvex();
  if (!cx) return [];

  try {
    const docs = await cx.query(api.asyncTasks.getByChat, {
      chat_id: chatId,
      status: "needs_input" as const,
    });
    return docs.map(toAsyncTask);
  } catch {
    return [];
  }
}

/**
 * Get currently running tasks in a specific chat.
 */
export async function getRunningTasks(chatId: string): Promise<AsyncTask[]> {
  const cx = getConvex();
  if (!cx) return [];

  try {
    const docs = await cx.query(api.asyncTasks.getByChat, {
      chat_id: chatId,
      status: "running" as const,
    });
    return docs.map(toAsyncTask);
  } catch {
    return [];
  }
}

/**
 * Get tasks that have been waiting for input longer than the threshold.
 */
export async function getStaleTasks(
  thresholdMs: number = 2 * 60 * 60 * 1000
): Promise<AsyncTask[]> {
  const cx = getConvex();
  if (!cx) return [];

  const cutoff = Date.now() - thresholdMs;

  try {
    const docs = await cx.query(api.asyncTasks.getStalePending, { cutoff });
    return docs.map(toAsyncTask);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Node Heartbeat
// ---------------------------------------------------------------------------

/**
 * Update heartbeat for a node.
 */
export async function upsertHeartbeat(
  nodeId: string,
  metadata?: Record<string, any>
): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;

  try {
    await cx.mutation(api.nodeHeartbeat.upsert, {
      node_id: nodeId,
      last_heartbeat: Date.now(),
      metadata: metadata ?? {},
    });
    return true;
  } catch (err) {
    console.error("upsertHeartbeat error:", err);
    return false;
  }
}

/**
 * Check if a node is online (heartbeat within maxAgeMs).
 */
export async function getNodeStatus(
  nodeId: string,
  maxAgeMs: number = 90_000
): Promise<{ online: boolean; lastHeartbeat: string | null }> {
  const cx = getConvex();
  if (!cx) return { online: false, lastHeartbeat: null };

  try {
    const doc = await cx.query(api.nodeHeartbeat.getByNodeId, {
      node_id: nodeId,
    });

    if (!doc) return { online: false, lastHeartbeat: null };

    const lastBeat = doc.last_heartbeat;
    const age = Date.now() - lastBeat;
    const lastHeartbeat = new Date(lastBeat).toISOString();

    return {
      online: age < maxAgeMs,
      lastHeartbeat,
    };
  } catch {
    return { online: false, lastHeartbeat: null };
  }
}
