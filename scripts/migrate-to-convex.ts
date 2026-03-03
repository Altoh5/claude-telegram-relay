// scripts/migrate-to-convex.ts
// One-time migration: reads all rows from Supabase REST API, inserts into Convex.
// Run: bun run scripts/migrate-to-convex.ts
//
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY), CONVEX_URL
// Reads from .env automatically via Bun.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;
const CONVEX_URL = process.env.CONVEX_URL!;

if (!SUPABASE_URL || !SUPABASE_KEY || !CONVEX_URL) {
  console.error(
    "Missing env vars. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY), CONVEX_URL"
  );
  process.exit(1);
}

const cx = new ConvexHttpClient(CONVEX_URL);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Paginated fetch of all rows from a Supabase table via REST API. */
async function fetchAll(
  table: string,
  select = "*",
  extraParams = ""
): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}&limit=${limit}&offset=${offset}&order=id.asc${extraParams ? "&" + extraParams : ""}`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Supabase fetch ${table} failed (${res.status}): ${body}`
      );
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
  }

  return all;
}

/** Convert null to undefined (Convex rejects null for optional fields). */
function n<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

/** ISO timestamp string to ms epoch number. Returns undefined for null/empty. */
function ts(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * pgvector stores embeddings as a string like "[0.1,0.2,...]".
 * Parse it into a number[] suitable for Convex float64 arrays.
 */
function parseEmbedding(v: any): number[] | undefined {
  if (!v) return undefined;
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // pgvector format: [0.1,0.2,...] — already valid JSON
      return undefined;
    }
  }
  return undefined;
}

/** Simple progress logger for large tables. */
function logProgress(table: string, current: number, total: number) {
  if (current % 100 === 0 || current === total) {
    console.log(`  ${table}: ${current}/${total}`);
  }
}

// ---------------------------------------------------------------------------
// Per-table migration functions
// ---------------------------------------------------------------------------

async function migrateTwinmindMeetings() {
  console.log("Migrating twinmind_meetings...");
  const rows = await fetchAll("twinmind_meetings");
  console.log(`  Found ${rows.length} rows`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    await cx.mutation(api.twinmindMeetings.upsert, {
      meeting_id: row.meeting_id,
      meeting_title: row.meeting_title || "Untitled",
      summary: row.summary || "",
      action_items: n(row.action_items),
      start_time: ts(row.start_time) ?? Date.now(),
      end_time: n(ts(row.end_time)),
      metadata: n(row.metadata),
    });
    logProgress("twinmind_meetings", i + 1, rows.length);
  }

  console.log(`  Done: ${rows.length} twinmind meetings migrated.\n`);
}

async function migrateNodeHeartbeat() {
  console.log("Migrating node_heartbeat...");
  const rows = await fetchAll("node_heartbeat");
  console.log(`  Found ${rows.length} rows`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    await cx.mutation(api.nodeHeartbeat.upsert, {
      node_id: row.node_id,
      last_heartbeat: ts(row.last_heartbeat) ?? Date.now(),
      metadata: n(row.metadata),
    });
    logProgress("node_heartbeat", i + 1, rows.length);
  }

  console.log(`  Done: ${rows.length} heartbeat rows migrated.\n`);
}

async function migrateCallTranscripts() {
  console.log("Migrating call_transcripts...");
  const rows = await fetchAll("call_transcripts");
  console.log(`  Found ${rows.length} rows`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // action_items is TEXT[] in Supabase — should already be string[]
    const actionItems: string[] | undefined = Array.isArray(row.action_items)
      ? row.action_items
      : undefined;

    await cx.mutation(api.callTranscripts.upsert, {
      conversation_id: row.conversation_id,
      transcript: n(row.transcript),
      summary: n(row.summary),
      action_items: actionItems,
      duration_seconds: n(row.duration_seconds),
      metadata: n(row.metadata),
    });
    logProgress("call_transcripts", i + 1, rows.length);
  }

  console.log(`  Done: ${rows.length} call transcripts migrated.\n`);
}

async function migrateAsyncTasks() {
  console.log("Migrating async_tasks (active only: pending/running/needs_input)...");
  const rows = await fetchAll(
    "async_tasks",
    "*",
    "status=in.(pending,running,needs_input)"
  );
  console.log(`  Found ${rows.length} active tasks`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const status = row.status as
      | "pending"
      | "running"
      | "needs_input"
      | "completed"
      | "failed";

    await cx.mutation(api.asyncTasks.insert, {
      chat_id: row.chat_id,
      original_prompt: row.original_prompt || "",
      status,
      thread_id: n(row.thread_id),
      processed_by: n(row.processed_by),
      metadata: n(row.metadata),
    });
    logProgress("async_tasks", i + 1, rows.length);
  }

  console.log(`  Done: ${rows.length} active async tasks migrated.\n`);
}

async function migrateAssets() {
  console.log("Migrating assets...");
  const rows = await fetchAll("assets");
  console.log(`  Found ${rows.length} rows`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // tags is TEXT[] in Supabase
    const tags: string[] | undefined = Array.isArray(row.tags)
      ? row.tags
      : undefined;

    const docId = await cx.mutation(api.assets.insert, {
      storage_path: row.storage_path,
      public_url: n(row.public_url),
      original_filename: n(row.original_filename),
      file_type: row.file_type || "unknown",
      mime_type: n(row.mime_type),
      file_size_bytes: n(row.file_size_bytes),
      description: row.description || "",
      user_caption: n(row.user_caption),
      conversation_context: n(row.conversation_context),
      related_project: n(row.related_project),
      tags,
      channel: n(row.channel),
      metadata: n(row.metadata),
    });

    // Backfill embedding if present
    const embedding = parseEmbedding(row.embedding);
    if (embedding && embedding.length === 1536) {
      await cx.mutation(api.assets.backfillEmbedding, {
        id: docId,
        embedding,
      });
    }

    logProgress("assets", i + 1, rows.length);
  }

  console.log(`  Done: ${rows.length} assets migrated.\n`);
}

async function migrateMemory() {
  console.log("Migrating memory...");
  const rows = await fetchAll("memory");
  console.log(`  Found ${rows.length} rows`);

  const validTypes = new Set(["fact", "goal", "completed_goal", "preference"]);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const memType = validTypes.has(row.type) ? row.type : "fact";

    await cx.mutation(api.memory.insert, {
      type: memType as "fact" | "goal" | "completed_goal" | "preference",
      content: row.content || "",
      deadline: n(ts(row.deadline)),
      priority: n(row.priority),
      metadata: n(row.metadata),
    });
    logProgress("memory", i + 1, rows.length);
  }

  console.log(`  Done: ${rows.length} memory rows migrated.\n`);
}

async function migrateLogs() {
  console.log("Migrating logs (last 1000 rows)...");
  // Only migrate last 1000 rows — historical logs are not critical.
  // Supabase REST API: order by id desc, limit 1000, then reverse.
  const url = `${SUPABASE_URL}/rest/v1/logs?select=*&limit=1000&order=id.desc`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`  Failed to fetch logs (${res.status}): ${body}`);
    return;
  }

  const rows: any[] = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("  No logs found. Skipping.\n");
    return;
  }

  // Reverse so we insert oldest first
  rows.reverse();
  console.log(`  Found ${rows.length} rows`);

  const validLevels = new Set(["debug", "info", "warn", "error"]);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const level = validLevels.has(row.level) ? row.level : "info";

    // Handle both `event` and `service` column names (varies by Supabase setup)
    const event: string | undefined =
      n(row.event) ?? n(row.service) ?? "migrated";

    await cx.mutation(api.logs.insert, {
      level: level as "debug" | "info" | "warn" | "error",
      event,
      message: n(row.message),
      metadata: n(row.metadata),
      session_id: n(row.session_id),
      duration_ms: n(row.duration_ms),
    });
    logProgress("logs", i + 1, rows.length);
  }

  console.log(`  Done: ${rows.length} log rows migrated.\n`);
}

async function migrateMessages() {
  console.log("Migrating messages (largest table — may take a while)...");
  const rows = await fetchAll("messages");
  console.log(`  Found ${rows.length} rows`);

  const validRoles = new Set(["user", "assistant"]);
  let embeddingCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const role = validRoles.has(row.role) ? row.role : "user";

    const docId = await cx.mutation(api.messages.insert, {
      chat_id: row.chat_id || "",
      role: role as "user" | "assistant",
      content: row.content || "",
      metadata: n(row.metadata),
    });

    // Backfill embedding if present
    const embedding = parseEmbedding(row.embedding);
    if (embedding && embedding.length === 1536) {
      await cx.mutation(api.messages.backfillEmbedding, {
        id: docId,
        embedding,
      });
      embeddingCount++;
    }

    logProgress("messages", i + 1, rows.length);
  }

  console.log(
    `  Done: ${rows.length} messages migrated (${embeddingCount} with embeddings).\n`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Supabase -> Convex Migration ===");
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Convex:   ${CONVEX_URL}`);
  console.log("");

  // Small tables first, messages last (largest)
  await migrateTwinmindMeetings();
  await migrateNodeHeartbeat();
  await migrateCallTranscripts();
  await migrateAsyncTasks();
  await migrateAssets();
  await migrateMemory();
  await migrateLogs();
  await migrateMessages();

  console.log("=== Migration complete ===");
  console.log("Verify row counts in your Convex dashboard.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
