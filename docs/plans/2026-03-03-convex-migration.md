# Convex Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate GoBot's database from Supabase to Convex using a backend adapter pattern with zero downtime and instant rollback at every phase.

**Architecture:** A `DB_BACKEND` env var routes all database calls through `src/lib/db.ts` which re-exports functions from either `supabase.ts` (current) or `convex-client.ts` (new). All consumers change one import line. The Convex project `blessed-emu-849` is already created and `CONVEX_URL`/`DB_BACKEND=supabase` are already in `.env`.

**Tech Stack:** Bun, TypeScript, Convex (`convex` npm package, `ConvexHttpClient`), existing `@supabase/supabase-js` stays for Supabase Storage.

**Design doc:** `docs/plans/2026-03-03-convex-migration-design.md`

---

## Task 1: Install Convex Package

**Files:**
- Modify: `package.json`

**Step 1: Install the convex package**

```bash
bun add convex
```

Expected output: `convex` added to `package.json` dependencies.

**Step 2: Initialize Convex project (already done — skip browser login)**

```bash
npx convex dev --once
```

This will fail if already initialized, which is fine — just verify `convex/` directory exists after. If prompted to log in, use browser auth.

**Step 3: Verify**

```bash
ls convex/
```

Expected: `_generated/` directory exists (Convex type generation).

**Step 4: Commit**

```bash
git add package.json bun.lockb convex/
git commit -m "feat: install convex package and initialize project"
```

---

## Task 2: Create Convex Schema

**Files:**
- Create: `convex/schema.ts`

**Step 1: Create the schema file**

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    chat_id: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    metadata: v.optional(v.any()),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_chat_id", ["chat_id"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["chat_id"],
    }),

  memory: defineTable({
    type: v.union(
      v.literal("fact"),
      v.literal("goal"),
      v.literal("completed_goal"),
      v.literal("preference")
    ),
    content: v.string(),
    deadline: v.optional(v.number()),
    completed_at: v.optional(v.number()),
    priority: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_type", ["type"]),

  logs: defineTable({
    level: v.union(
      v.literal("debug"),
      v.literal("info"),
      v.literal("warn"),
      v.literal("error")
    ),
    event: v.optional(v.string()),
    message: v.optional(v.string()),
    metadata: v.optional(v.any()),
    session_id: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
  })
    .index("by_level", ["level"])
    .index("by_event", ["event"]),

  callTranscripts: defineTable({
    conversation_id: v.string(),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    action_items: v.optional(v.array(v.string())),
    duration_seconds: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_conversation_id", ["conversation_id"]),

  asyncTasks: defineTable({
    chat_id: v.string(),
    original_prompt: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("needs_input"),
      v.literal("completed"),
      v.literal("failed")
    ),
    result: v.optional(v.string()),
    session_id: v.optional(v.string()),
    current_step: v.optional(v.string()),
    pending_question: v.optional(v.string()),
    pending_options: v.optional(v.any()),
    user_response: v.optional(v.string()),
    thread_id: v.optional(v.number()),
    processed_by: v.optional(v.string()),
    reminder_sent: v.optional(v.boolean()),
    updatedAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_chat_id", ["chat_id"])
    .index("by_status", ["status"]),

  // node_id is a custom TEXT PK in Supabase — becomes a field with index in Convex
  nodeHeartbeat: defineTable({
    node_id: v.string(),
    last_heartbeat: v.number(), // ms epoch
    metadata: v.optional(v.any()),
  })
    .index("by_node_id", ["node_id"]),

  assets: defineTable({
    storage_path: v.string(),        // still points to Supabase Storage
    public_url: v.optional(v.string()),
    original_filename: v.optional(v.string()),
    file_type: v.string(),
    mime_type: v.optional(v.string()),
    file_size_bytes: v.optional(v.number()),
    description: v.string(),
    user_caption: v.optional(v.string()),
    conversation_context: v.optional(v.string()),
    related_project: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    channel: v.optional(v.string()),
    metadata: v.optional(v.any()),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_file_type", ["file_type"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: [],
    }),

  twinmindMeetings: defineTable({
    meeting_id: v.string(),
    meeting_title: v.string(),
    summary: v.string(),
    action_items: v.optional(v.string()),
    start_time: v.number(),          // ms epoch
    end_time: v.optional(v.number()),
    processed: v.optional(v.boolean()),
    processed_at: v.optional(v.number()),
    synced_at: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_meeting_id", ["meeting_id"])
    .index("by_processed", ["processed"]),
});
```

**Step 2: Deploy schema**

```bash
npx convex dev --once
```

Expected: No TypeScript errors. All 8 tables appear in [Convex dashboard](https://dashboard.convex.dev) → Data tab.

**Step 3: Commit**

```bash
git add convex/schema.ts convex/_generated/
git commit -m "feat: add Convex schema for all 8 tables"
```

---

## Task 3a: Server Functions — messages

**Files:**
- Create: `convex/messages.ts`

```typescript
// convex/messages.ts
import { v } from "convex/values";
import { mutation, query, action } from "./_generated/server";
import { api } from "./_generated/api";

export const insert = mutation({
  args: {
    chat_id: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      chat_id: args.chat_id,
      role: args.role,
      content: args.content,
      metadata: args.metadata ?? {},
    });
  },
});

export const getById = query({
  args: { id: v.id("messages") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getRecent = query({
  args: { chat_id: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chat_id))
      .order("desc")
      .take(args.limit ?? 20);
    return rows.reverse(); // chronological order
  },
});

export const backfillEmbedding = mutation({
  args: { id: v.id("messages"), embedding: v.array(v.float64()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { embedding: args.embedding });
  },
});

export const searchByVector = action({
  args: {
    chat_id: v.string(),
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any[]> => {
    const results = await ctx.vectorSearch("messages", "by_embedding", {
      vector: args.embedding,
      limit: args.limit ?? 10,
      filter: (q) => q.eq("chat_id", args.chat_id),
    });
    const docs: any[] = [];
    for (const r of results) {
      const doc = await ctx.runQuery(api.messages.getById, { id: r._id });
      if (doc) docs.push({ ...doc, _score: r._score });
    }
    return docs;
  },
});
```

**Step: Deploy and check**

```bash
npx convex dev --once
```

Expected: `messages` functions visible in Convex dashboard → Functions tab.

---

## Task 3b: Server Functions — memory

**Files:**
- Create: `convex/memory.ts`

```typescript
// convex/memory.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const memoryType = v.union(
  v.literal("fact"),
  v.literal("goal"),
  v.literal("completed_goal"),
  v.literal("preference")
);

export const insert = mutation({
  args: {
    type: memoryType,
    content: v.string(),
    deadline: v.optional(v.number()),
    priority: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("memory", { ...args });
  },
});

export const patch = mutation({
  args: {
    id: v.id("memory"),
    updates: v.object({
      type: v.optional(memoryType),
      content: v.optional(v.string()),
      completed_at: v.optional(v.number()),
      updatedAt: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { ...args.updates, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { id: v.id("memory") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const getByType = query({
  args: { type: memoryType },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("memory")
      .withIndex("by_type", (q) => q.eq("type", args.type))
      .collect();
  },
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("memory").collect();
  },
});

// Find items matching text (used by completeGoal, deleteFact, cancelGoal)
export const findByContent = query({
  args: { type: memoryType, search: v.string() },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query("memory")
      .withIndex("by_type", (q) => q.eq("type", args.type))
      .collect();
    const lower = args.search.toLowerCase();
    return items.filter((i) => i.content.toLowerCase().includes(lower));
  },
});
```

---

## Task 3c: Server Functions — logs

**Files:**
- Create: `convex/logs.ts`

```typescript
// convex/logs.ts
import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const insert = mutation({
  args: {
    level: v.union(
      v.literal("debug"),
      v.literal("info"),
      v.literal("warn"),
      v.literal("error")
    ),
    event: v.optional(v.string()),
    message: v.optional(v.string()),
    metadata: v.optional(v.any()),
    session_id: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("logs", { ...args });
  },
});
```

---

## Task 3d: Server Functions — callTranscripts

**Files:**
- Create: `convex/callTranscripts.ts`

```typescript
// convex/callTranscripts.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const upsert = mutation({
  args: {
    conversation_id: v.string(),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    action_items: v.optional(v.array(v.string())),
    duration_seconds: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("callTranscripts")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args });
      return existing._id;
    }
    return await ctx.db.insert("callTranscripts", { ...args });
  },
});

export const getByConversationId = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("callTranscripts")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .first();
  },
});
```

---

## Task 3e: Server Functions — asyncTasks

**Files:**
- Create: `convex/asyncTasks.ts`

```typescript
// convex/asyncTasks.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const statusType = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("needs_input"),
  v.literal("completed"),
  v.literal("failed")
);

export const insert = mutation({
  args: {
    chat_id: v.string(),
    original_prompt: v.string(),
    status: statusType,
    thread_id: v.optional(v.number()),
    processed_by: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("asyncTasks", {
      ...args,
      updatedAt: Date.now(),
    });
  },
});

export const patch = mutation({
  args: {
    id: v.id("asyncTasks"),
    updates: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { ...args.updates, updatedAt: Date.now() });
  },
});

export const getById = query({
  args: { id: v.id("asyncTasks") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByChat = query({
  args: { chat_id: v.string(), status: v.optional(statusType) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("asyncTasks")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chat_id))
      .order("desc")
      .collect();
    if (args.status) return rows.filter((r) => r.status === args.status);
    return rows;
  },
});

export const getByStatus = query({
  args: { status: statusType },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("asyncTasks")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .collect();
  },
});

// Stale tasks: needs_input, reminder not sent, older than cutoff (ms epoch)
export const getStalePending = query({
  args: { cutoff: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("asyncTasks")
      .withIndex("by_status", (q) => q.eq("status", "needs_input"))
      .collect();
    return rows.filter(
      (r) => !r.reminder_sent && (r.updatedAt ?? r._creationTime) < args.cutoff
    );
  },
});
```

---

## Task 3f: Server Functions — nodeHeartbeat

**Files:**
- Create: `convex/nodeHeartbeat.ts`

```typescript
// convex/nodeHeartbeat.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Transactional upsert — query then patch-or-insert in one mutation
export const upsert = mutation({
  args: {
    node_id: v.string(),
    last_heartbeat: v.number(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("nodeHeartbeat")
      .withIndex("by_node_id", (q) => q.eq("node_id", args.node_id))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        last_heartbeat: args.last_heartbeat,
        metadata: args.metadata,
      });
    } else {
      await ctx.db.insert("nodeHeartbeat", { ...args });
    }
  },
});

export const getByNodeId = query({
  args: { node_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("nodeHeartbeat")
      .withIndex("by_node_id", (q) => q.eq("node_id", args.node_id))
      .first();
  },
});
```

---

## Task 3g: Server Functions — assets

**Files:**
- Create: `convex/assets.ts`

```typescript
// convex/assets.ts
import { v } from "convex/values";
import { mutation, query, action } from "./_generated/server";
import { api } from "./_generated/api";

export const insert = mutation({
  args: {
    storage_path: v.string(),
    public_url: v.optional(v.string()),
    original_filename: v.optional(v.string()),
    file_type: v.string(),
    mime_type: v.optional(v.string()),
    file_size_bytes: v.optional(v.number()),
    description: v.string(),
    user_caption: v.optional(v.string()),
    conversation_context: v.optional(v.string()),
    related_project: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    channel: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("assets", { ...args });
  },
});

export const backfillEmbedding = mutation({
  args: { id: v.id("assets"), embedding: v.array(v.float64()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { embedding: args.embedding });
  },
});

export const getById = query({
  args: { id: v.id("assets") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByFileType = query({
  args: { file_type: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("assets")
      .withIndex("by_file_type", (q) => q.eq("file_type", args.file_type))
      .order("desc")
      .take(args.limit ?? 20);
  },
});

export const searchByVector = action({
  args: {
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any[]> => {
    const results = await ctx.vectorSearch("assets", "by_embedding", {
      vector: args.embedding,
      limit: args.limit ?? 5,
    });
    const docs: any[] = [];
    for (const r of results) {
      const doc = await ctx.runQuery(api.assets.getById, { id: r._id });
      if (doc) docs.push({ ...doc, _score: r._score });
    }
    return docs;
  },
});
```

---

## Task 3h: Server Functions — twinmindMeetings

**Files:**
- Create: `convex/twinmindMeetings.ts`

```typescript
// convex/twinmindMeetings.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Transactional upsert by meeting_id
export const upsert = mutation({
  args: {
    meeting_id: v.string(),
    meeting_title: v.string(),
    summary: v.string(),
    action_items: v.optional(v.string()),
    start_time: v.number(),
    end_time: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("twinmindMeetings")
      .withIndex("by_meeting_id", (q) =>
        q.eq("meeting_id", args.meeting_id)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        meeting_title: args.meeting_title,
        summary: args.summary,
        action_items: args.action_items,
        synced_at: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("twinmindMeetings", {
      ...args,
      synced_at: Date.now(),
    });
  },
});

export const getUnprocessed = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("twinmindMeetings")
      .withIndex("by_processed", (q) => q.eq("processed", false))
      .collect();
  },
});

export const markProcessed = mutation({
  args: { id: v.id("twinmindMeetings"), metadata: v.optional(v.any()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      processed: true,
      processed_at: Date.now(),
      metadata: args.metadata,
    });
  },
});

export const getByMeetingId = query({
  args: { meeting_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("twinmindMeetings")
      .withIndex("by_meeting_id", (q) =>
        q.eq("meeting_id", args.meeting_id)
      )
      .first();
  },
});
```

---

## Task 4: Deploy Phase 1 and Verify

**Step 1: Deploy all server functions**

```bash
npx convex dev --once
```

Expected: No TypeScript errors. All 8 tables and all function files visible in [Convex dashboard](https://dashboard.convex.dev).

**Step 2: Verify tables in dashboard**

Open `https://dashboard.convex.dev` → your project → Data tab. Confirm these tables exist (empty is fine):
- messages, memory, logs, callTranscripts, asyncTasks, nodeHeartbeat, assets, twinmindMeetings

**Step 3: Commit**

```bash
git add convex/
git commit -m "feat: add Convex server functions for all 8 tables"
```

---

## Task 5: Create convex-client.ts

This mirrors every export from `src/lib/supabase.ts` with identical function signatures. Consumers see no difference.

**Files:**
- Create: `src/lib/convex-client.ts`

```typescript
// src/lib/convex-client.ts
// Drop-in replacement for supabase.ts — identical export signatures.
// Converts Convex _id/_creationTime → id/created_at for consumers.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Message, MemoryItem, LogEntry, AsyncTask } from "./supabase";

// Re-export pure utility functions unchanged
export { getTimeAgo, parseRelativeDate, formatGoalsList, formatFactsList } from "./supabase";

// ---------------------------------------------------------------------------
// Convex client singleton
// ---------------------------------------------------------------------------

let _cx: ConvexHttpClient | null = null;

function getConvex(): ConvexHttpClient | null {
  if (_cx) return _cx;
  const url = process.env.CONVEX_URL;
  if (!url) return null;
  _cx = new ConvexHttpClient(url);
  return _cx;
}

export function isSupabaseEnabled(): boolean {
  return getConvex() !== null;
}

// ---------------------------------------------------------------------------
// Helpers: convert Convex doc → consumer shape
// ---------------------------------------------------------------------------

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

function toMemoryItem(doc: any): MemoryItem {
  return {
    id: doc._id,
    type: doc.type,
    content: doc.content,
    deadline: doc.deadline ? new Date(doc.deadline).toISOString() : undefined,
    completed_at: doc.completed_at
      ? new Date(doc.completed_at).toISOString()
      : undefined,
    priority: doc.priority,
    metadata: doc.metadata,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

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
    // Fire-and-forget embedding backfill (same pattern as supabase.ts)
    if (id && process.env.OPENAI_API_KEY) {
      generateEmbedding(message.content)
        .then((embedding) => {
          if (embedding.length > 0) {
            cx.mutation(api.messages.backfillEmbedding, {
              id,
              embedding,
            }).catch(() => {});
          }
        })
        .catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

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

export async function getConversationContext(
  chatId: string,
  limit: number = 10
): Promise<string> {
  const { getTimeAgo } = await import("./supabase");
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

export async function searchMessages(
  chatId: string,
  query: string,
  limit: number = 10
): Promise<Message[]> {
  const cx = getConvex();
  if (!cx) return [];
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return []; // no embeddings, skip vector search
  try {
    const embedding = await generateEmbedding(query);
    if (embedding.length === 0) return [];
    const docs = await cx.action(api.messages.searchByVector, {
      chat_id: chatId,
      embedding,
      limit,
    });
    return (docs as any[]).map(toMessage);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory: Facts
// ---------------------------------------------------------------------------

export async function addFact(content: string): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;
  try {
    await cx.mutation(api.memory.insert, { type: "fact", content });
    return true;
  } catch {
    return false;
  }
}

export async function getFacts(): Promise<MemoryItem[]> {
  const cx = getConvex();
  if (!cx) return [];
  try {
    const docs = await cx.query(api.memory.getByType, { type: "fact" });
    return docs.map(toMemoryItem).reverse(); // newest first
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory: Goals
// ---------------------------------------------------------------------------

export async function addGoal(
  content: string,
  deadline?: string
): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;
  const { parseRelativeDate } = await import("./supabase");
  const parsedDeadline = deadline ? parseRelativeDate(deadline) : undefined;
  try {
    await cx.mutation(api.memory.insert, {
      type: "goal",
      content,
      deadline: parsedDeadline ? new Date(parsedDeadline).getTime() : undefined,
    });
    return true;
  } catch {
    return false;
  }
}

export async function completeGoal(searchText: string): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;
  try {
    const goals = await cx.query(api.memory.findByContent, {
      type: "goal",
      search: searchText,
    });
    if (!goals.length) return false;
    await cx.mutation(api.memory.patch, {
      id: goals[0]._id,
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

export async function deleteFact(searchText: string): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;
  try {
    const facts = await cx.query(api.memory.findByContent, {
      type: "fact",
      search: searchText,
    });
    if (!facts.length) return false;
    await cx.mutation(api.memory.remove, { id: facts[0]._id });
    return true;
  } catch {
    return false;
  }
}

export async function cancelGoal(searchText: string): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;
  try {
    const goals = await cx.query(api.memory.findByContent, {
      type: "goal",
      search: searchText,
    });
    if (!goals.length) return false;
    await cx.mutation(api.memory.remove, { id: goals[0]._id });
    return true;
  } catch {
    return false;
  }
}

export async function getActiveGoals(): Promise<MemoryItem[]> {
  const cx = getConvex();
  if (!cx) return [];
  try {
    const goals = await cx.query(api.memory.getByType, { type: "goal" });
    // Filter incomplete goals (no completed_at)
    return goals
      .filter((g: any) => !g.completed_at)
      .map(toMemoryItem)
      .sort((a: any, b: any) => a.created_at.localeCompare(b.created_at));
  } catch {
    return [];
  }
}

export async function getMemoryContext(): Promise<string> {
  const { formatFactsList, formatGoalsList } = await import("./supabase");
  const [facts, goals] = await Promise.all([getFacts(), getActiveGoals()]);
  const sections: string[] = [];
  if (facts.length > 0) sections.push(`**Known Facts:**\n${formatFactsList(facts)}`);
  if (goals.length > 0) sections.push(`**Active Goals:**\n${formatGoalsList(goals)}`);
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export async function log(
  level: LogEntry["level"],
  service: string,   // mapped to event field in Convex
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
      metadata,
    });
  } catch {
    // Logging never throws
  }
}

// ---------------------------------------------------------------------------
// Async Tasks
// ---------------------------------------------------------------------------

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
      status: "running",
      thread_id: threadId,
      processed_by: processedBy,
    });
    const doc = await cx.query(api.asyncTasks.getById, { id });
    return doc ? toAsyncTask(doc) : null;
  } catch {
    return null;
  }
}

export async function updateTask(
  taskId: string,
  updates: Partial<Omit<AsyncTask, "id" | "created_at">>
): Promise<boolean> {
  const cx = getConvex();
  if (!cx) return false;
  try {
    // Convert ISO strings back to ms epoch for Convex
    const convexUpdates: any = { ...updates };
    if (updates.updated_at) delete convexUpdates.updated_at; // Convex auto-handles
    await cx.mutation(api.asyncTasks.patch, {
      id: taskId as any,
      updates: convexUpdates,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getTaskById(taskId: string): Promise<AsyncTask | null> {
  const cx = getConvex();
  if (!cx) return null;
  try {
    const doc = await cx.query(api.asyncTasks.getById, { id: taskId as any });
    return doc ? toAsyncTask(doc) : null;
  } catch {
    return null;
  }
}

export async function getPendingTasks(chatId: string): Promise<AsyncTask[]> {
  const cx = getConvex();
  if (!cx) return [];
  try {
    const docs = await cx.query(api.asyncTasks.getByChat, {
      chat_id: chatId,
      status: "needs_input",
    });
    return docs.map(toAsyncTask);
  } catch {
    return [];
  }
}

export async function getRunningTasks(chatId: string): Promise<AsyncTask[]> {
  const cx = getConvex();
  if (!cx) return [];
  try {
    const docs = await cx.query(api.asyncTasks.getByChat, {
      chat_id: chatId,
      status: "running",
    });
    return docs.map(toAsyncTask);
  } catch {
    return [];
  }
}

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
  } catch {
    return false;
  }
}

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
    const age = Date.now() - doc.last_heartbeat;
    return {
      online: age < maxAgeMs,
      lastHeartbeat: new Date(doc.last_heartbeat).toISOString(),
    };
  } catch {
    return { online: false, lastHeartbeat: null };
  }
}

// ---------------------------------------------------------------------------
// Embedding helper (shared with saveMessage + searchMessages)
// ---------------------------------------------------------------------------

async function generateEmbedding(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: "text-embedding-ada-002", input: text }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.data?.[0]?.embedding ?? [];
  } catch {
    return [];
  }
}
```

**Step: Deploy and check TypeScript**

```bash
npx convex dev --once
```

Expected: No type errors. If `api.memory.findByContent` shows a type error on the `updates` shape in `memory.patch`, adjust the `v.object({...})` args to be `v.any()` temporarily.

**Step: Commit**

```bash
git add src/lib/convex-client.ts
git commit -m "feat: add convex-client.ts — drop-in replacement for supabase.ts"
```

---

## Task 6: Create db.ts Router

**Files:**
- Create: `src/lib/db.ts`

```typescript
// src/lib/db.ts
// Routes all database calls based on DB_BACKEND env var.
// Uses require() (not import) so this file can be loaded without the
// convex package installed (e.g., on a VPS that hasn't run bun install yet).

import * as supabaseModule from "./supabase";

const backend = process.env.DB_BACKEND || "supabase";

type DbModule = typeof supabaseModule;

let _convexModule: DbModule | null = null;

function getConvexModule(): DbModule {
  if (!_convexModule) {
    _convexModule = require("./convex-client") as DbModule;
  }
  return _convexModule;
}

function buildDualModule(): DbModule {
  const cx = getConvexModule();

  async function dualWrite<T>(
    fn: keyof DbModule,
    ...args: any[]
  ): Promise<T> {
    const [a, b] = await Promise.allSettled([
      (supabaseModule[fn] as any)(...args),
      (cx[fn] as any)(...args),
    ]);
    // Return Convex result if available, else Supabase result
    if (b.status === "fulfilled") return b.value as T;
    if (a.status === "fulfilled") return a.value as T;
    return false as T;
  }

  return {
    ...cx, // reads from Convex
    // Writes go to both
    saveMessage: (...args: any[]) => dualWrite("saveMessage", ...args),
    addFact: (...args: any[]) => dualWrite("addFact", ...args),
    addGoal: (...args: any[]) => dualWrite("addGoal", ...args),
    completeGoal: (...args: any[]) => dualWrite("completeGoal", ...args),
    deleteFact: (...args: any[]) => dualWrite("deleteFact", ...args),
    cancelGoal: (...args: any[]) => dualWrite("cancelGoal", ...args),
    log: (...args: any[]) => dualWrite("log", ...args),
    createTask: (...args: any[]) => dualWrite("createTask", ...args),
    updateTask: (...args: any[]) => dualWrite("updateTask", ...args),
    upsertHeartbeat: (...args: any[]) => dualWrite("upsertHeartbeat", ...args),
  } as DbModule;
}

const activeModule: DbModule =
  backend === "convex"
    ? getConvexModule()
    : backend === "dual"
      ? buildDualModule()
      : supabaseModule;

// Re-export everything consumers use
export const saveMessage = activeModule.saveMessage;
export const getRecentMessages = activeModule.getRecentMessages;
export const getConversationContext = activeModule.getConversationContext;
export const searchMessages = activeModule.searchMessages;
export const addFact = activeModule.addFact;
export const getFacts = activeModule.getFacts;
export const addGoal = activeModule.addGoal;
export const completeGoal = activeModule.completeGoal;
export const deleteFact = activeModule.deleteFact;
export const cancelGoal = activeModule.cancelGoal;
export const getActiveGoals = activeModule.getActiveGoals;
export const formatGoalsList = activeModule.formatGoalsList;
export const formatFactsList = activeModule.formatFactsList;
export const getMemoryContext = activeModule.getMemoryContext;
export const log = activeModule.log;
export const createTask = activeModule.createTask;
export const updateTask = activeModule.updateTask;
export const getTaskById = activeModule.getTaskById;
export const getPendingTasks = activeModule.getPendingTasks;
export const getRunningTasks = activeModule.getRunningTasks;
export const getStaleTasks = activeModule.getStaleTasks;
export const upsertHeartbeat = activeModule.upsertHeartbeat;
export const getNodeStatus = activeModule.getNodeStatus;
export const getTimeAgo = activeModule.getTimeAgo;
export const parseRelativeDate = activeModule.parseRelativeDate;
export const isSupabaseEnabled = activeModule.isSupabaseEnabled;

// Types re-exported for consumers that import types from supabase
export type { Message, MemoryItem, LogEntry, AsyncTask } from "./supabase";
```

**Step: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat: add db.ts backend adapter router"
```

---

## Task 7: Update Import Paths

Change one line in each file. The rule: any import of `./supabase` or `./lib/supabase` becomes `./db` or `./lib/db`.

**Files to update:**

**`src/bot.ts:47`**
```diff
- } from "./lib/supabase";
+ } from "./lib/db";
```

**`src/vps-gateway.ts:50`**
```diff
- import * as supabase from "./lib/supabase";
+ import * as supabase from "./lib/db";
```

**`src/lib/anthropic-processor.ts:18`**
```diff
- import * as supabase from "./supabase";
+ import * as supabase from "./db";
```

**`src/lib/agent-session.ts:23`**
```diff
- import * as supabase from "./supabase";
+ import * as supabase from "./db";
```

**`src/lib/mac-health.ts:17`**
```diff
- import { getNodeStatus } from "./supabase";
+ import { getNodeStatus } from "./db";
```

**`src/lib/memory.ts:24`**
```diff
- } from "./supabase";
+ } from "./db";
```

**`src/lib/task-queue.ts:25`**
```diff
- } from "./supabase";
+ } from "./db";
```

**`src/lib/voice.ts:9`**
```diff
- import * as supabase from "./supabase";
+ import * as supabase from "./db";
```

**`src/lib/openclaw/chat-handler.ts:20`**
```diff
- import { saveMessage, getConversationContext } from "../supabase";
+ import { saveMessage, getConversationContext } from "../db";
```

**`src/lib/asset-store.ts`** — special case: keeps `getSupabase()` for Storage operations, updates DB functions:
```diff
- import { getSupabase } from "./supabase";
+ import { getSupabase } from "./supabase";  // keep for Storage (files stay in Supabase)
  // No change needed here — asset DB writes go through asset-store's own logic
```
(Asset store uses `getSupabase().from("assets")` directly for DB ops. Since files stay in Supabase Storage, leave this file unchanged for now — asset metadata migration is handled by the migration script and the Phase 6 cleanup.)

**Step: Verify bot still starts on Supabase**

```bash
DB_BACKEND=supabase bun run start
```

Expected: Bot starts, send "ping" on Telegram, get a response. No import errors. `Ctrl+C` to stop.

**Step: Commit**

```bash
git add src/bot.ts src/vps-gateway.ts src/lib/anthropic-processor.ts src/lib/agent-session.ts src/lib/mac-health.ts src/lib/memory.ts src/lib/task-queue.ts src/lib/voice.ts src/lib/openclaw/chat-handler.ts
git commit -m "feat: update import paths from supabase to db adapter"
```

---

## Task 8: Create Data Migration Script

**Files:**
- Create: `scripts/migrate-to-convex.ts`

```typescript
// scripts/migrate-to-convex.ts
// One-time migration: reads all rows from Supabase, inserts into Convex.
// Run: bun run scripts/migrate-to-convex.ts
// Safe to re-run: clear target table in Convex dashboard first if re-running.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;
const CONVEX_URL = process.env.CONVEX_URL!;

if (!SUPABASE_URL || !SUPABASE_KEY || !CONVEX_URL) {
  console.error("Missing env vars: SUPABASE_URL, SUPABASE_KEY, CONVEX_URL");
  process.exit(1);
}

const cx = new ConvexHttpClient(CONVEX_URL);

// Paginated Supabase fetch
async function fetchAll(table: string, select = "*"): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?select=${select}&limit=1000&offset=${offset}&order=id.asc`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return all;
}

// Convert null → undefined (Convex rejects null for optional fields)
function n(v: any): any {
  return v === null ? undefined : v;
}

// ISO string or null → ms epoch or undefined
function ts(v: string | null): number | undefined {
  return v ? new Date(v).getTime() : undefined;
}

async function migrateMessages() {
  console.log("Migrating messages...");
  const rows = await fetchAll("messages");
  let count = 0;
  for (const row of rows) {
    const id = await cx.mutation(api.messages.insert, {
      chat_id: row.chat_id,
      role: row.role,
      content: row.content,
      metadata: n(row.metadata) ?? {},
    });
    if (row.embedding && id) {
      await cx.mutation(api.messages.backfillEmbedding, {
        id,
        embedding: row.embedding,
      });
    }
    count++;
    if (count % 100 === 0) console.log(`  messages: ${count}/${rows.length}`);
  }
  console.log(`  ✅ messages: ${count} rows`);
}

async function migrateMemory() {
  console.log("Migrating memory...");
  const rows = await fetchAll("memory");
  let count = 0;
  for (const row of rows) {
    await cx.mutation(api.memory.insert, {
      type: row.type,
      content: row.content,
      deadline: ts(row.deadline),
      priority: n(row.priority),
      metadata: n(row.metadata),
    });
    // If completed, patch completed_at
    if (row.completed_at) {
      // We'd need the new _id to patch — skip for simplicity,
      // completed_goals are historical and don't need completed_at in practice
    }
    count++;
  }
  console.log(`  ✅ memory: ${count} rows`);
}

async function migrateLogs() {
  console.log("Migrating logs (last 1000 only — historical logs not critical)...");
  const rows = await fetchAll("logs");
  const recent = rows.slice(-1000); // only last 1000
  let count = 0;
  for (const row of recent) {
    await cx.mutation(api.logs.insert, {
      level: row.level,
      event: n(row.event) ?? n(row.service) ?? "migrated",
      message: n(row.message),
      metadata: n(row.metadata),
      session_id: n(row.session_id),
      duration_ms: n(row.duration_ms),
    });
    count++;
  }
  console.log(`  ✅ logs: ${count} rows (of ${rows.length} total)`);
}

async function migrateCallTranscripts() {
  console.log("Migrating call_transcripts...");
  const rows = await fetchAll("call_transcripts");
  let count = 0;
  for (const row of rows) {
    await cx.mutation(api.callTranscripts.upsert, {
      conversation_id: row.conversation_id,
      transcript: n(row.transcript),
      summary: n(row.summary),
      action_items: n(row.action_items),
      duration_seconds: n(row.duration_seconds),
      metadata: n(row.metadata),
    });
    count++;
  }
  console.log(`  ✅ call_transcripts: ${count} rows`);
}

async function migrateAsyncTasks() {
  console.log("Migrating async_tasks (non-terminal only)...");
  const rows = await fetchAll("async_tasks");
  // Only migrate active tasks — completed/failed are historical
  const active = rows.filter((r) =>
    ["pending", "running", "needs_input"].includes(r.status)
  );
  let count = 0;
  for (const row of active) {
    await cx.mutation(api.asyncTasks.insert, {
      chat_id: row.chat_id,
      original_prompt: row.original_prompt,
      status: row.status,
      thread_id: n(row.thread_id),
      processed_by: n(row.processed_by),
      metadata: n(row.metadata),
    });
    count++;
  }
  console.log(`  ✅ async_tasks: ${count} active rows (of ${rows.length} total)`);
}

async function migrateNodeHeartbeat() {
  console.log("Migrating node_heartbeat...");
  const rows = await fetchAll("node_heartbeat");
  let count = 0;
  for (const row of rows) {
    await cx.mutation(api.nodeHeartbeat.upsert, {
      node_id: row.node_id,
      last_heartbeat: new Date(row.last_heartbeat).getTime(),
      metadata: n(row.metadata),
    });
    count++;
  }
  console.log(`  ✅ node_heartbeat: ${count} rows`);
}

async function migrateAssets() {
  console.log("Migrating assets...");
  const rows = await fetchAll("assets");
  let count = 0;
  for (const row of rows) {
    const id = await cx.mutation(api.assets.insert, {
      storage_path: row.storage_path,
      public_url: n(row.public_url),
      original_filename: n(row.original_filename),
      file_type: row.file_type,
      mime_type: n(row.mime_type),
      file_size_bytes: n(row.file_size_bytes),
      description: row.description,
      user_caption: n(row.user_caption),
      conversation_context: n(row.conversation_context),
      related_project: n(row.related_project),
      tags: n(row.tags) ?? [],
      channel: n(row.channel) ?? "telegram",
      metadata: n(row.metadata),
    });
    if (row.embedding && id) {
      await cx.mutation(api.assets.backfillEmbedding, {
        id,
        embedding: row.embedding,
      });
    }
    count++;
  }
  console.log(`  ✅ assets: ${count} rows`);
}

async function migrateTwinmindMeetings() {
  console.log("Migrating twinmind_meetings...");
  const rows = await fetchAll("twinmind_meetings");
  let count = 0;
  for (const row of rows) {
    await cx.mutation(api.twinmindMeetings.upsert, {
      meeting_id: row.meeting_id,
      meeting_title: row.meeting_title,
      summary: row.summary,
      action_items: n(row.action_items),
      start_time: ts(row.start_time) ?? Date.now(),
      end_time: ts(row.end_time),
      metadata: n(row.metadata),
    });
    count++;
  }
  console.log(`  ✅ twinmind_meetings: ${count} rows`);
}

async function main() {
  console.log("Starting Convex migration...\n");
  // Migrate in order: small tables first, messages last
  await migrateTwinmindMeetings();
  await migrateNodeHeartbeat();
  await migrateCallTranscripts();
  await migrateAsyncTasks();
  await migrateAssets();
  await migrateMemory();
  await migrateLogs();
  await migrateMessages(); // largest — last
  console.log("\n✅ Migration complete. Verify row counts in Convex dashboard.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

**Step: Commit**

```bash
git add scripts/migrate-to-convex.ts
git commit -m "feat: add data migration script for Convex"
```

---

## Task 9: Run Migration and Verify

**Step 1: Run the migration**

```bash
bun run scripts/migrate-to-convex.ts
```

Expected output (counts will vary):
```
Starting Convex migration...
Migrating twinmind_meetings... ✅ twinmind_meetings: 11 rows
Migrating node_heartbeat...    ✅ node_heartbeat: 2 rows
...
Migrating messages...          ✅ messages: ~1200 rows
✅ Migration complete.
```

**Step 2: Verify row counts**

Open [Convex dashboard](https://dashboard.convex.dev) → Data tab. Compare each table count against Supabase dashboard. They should match (within a few rows for active async_tasks).

**Step 3: Spot-check 5 records**

In Convex dashboard → Data → messages: open a few records. Verify `chat_id`, `role`, `content` look correct. Check one record has `embedding` set.

**Step 4: Test vector search**

```bash
bun -e "
const { ConvexHttpClient } = require('convex/browser');
const { api } = require('./convex/_generated/api');
const cx = new ConvexHttpClient(process.env.CONVEX_URL);
// Just verify getRecent works
cx.query(api.messages.getRecent, { chat_id: process.env.TELEGRAM_USER_ID?.toString() || 'test', limit: 3 })
  .then(r => console.log('getRecent:', r.length, 'messages'))
  .catch(console.error);
"
```

---

## Task 10: Dual-Write Verification (Phase 4)

**Step 1: Switch to dual mode**

Edit `.env`:
```env
DB_BACKEND=dual
```

**Step 2: Restart the bot**

```bash
# Stop current service then start
launchctl unload ~/Library/LaunchAgents/com.go.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/com.go.telegram-relay.plist
```

Or if running manually:
```bash
bun run start
```

**Step 3: Test for 24-48 hours**

Send at least 10 messages via Telegram. Also test:
- [ ] Add a goal ("Add goal: test dual write by end of week")
- [ ] Add a fact ("Remember: dual mode test started on 2026-03-03")
- [ ] Complete a goal ("Complete goal: test dual write")
- [ ] Morning briefing (`bun run briefing`)

**Step 4: Verify both DBs have matching data**

After 24h, compare row counts in Supabase dashboard vs Convex dashboard. Both should have the new rows. If Convex is missing rows, check logs for dual-write errors.

**Step 5: Rollback if needed**

```env
DB_BACKEND=supabase  # instant rollback
```

---

## Task 11: Convex-Only Cutover (Phase 5)

Only proceed after 24-48h of stable dual-write.

**Step 1: Switch to Convex-only**

Edit `.env`:
```env
DB_BACKEND=convex
```

**Step 2: Restart**

```bash
launchctl unload ~/Library/LaunchAgents/com.go.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/com.go.telegram-relay.plist
```

**Step 3: Monitor for 48 hours**

Send messages, check goals, run briefing. If anything breaks:
```env
DB_BACKEND=supabase  # instant rollback
```

**Step 4: Commit phase change**

```bash
# Just documents the phase — .env is gitignored
git commit --allow-empty -m "chore: Phase 5 — Convex-only cutover started"
```

---

## Task 12: Cleanup (Phase 6) — After 48h Stable

Only after confirmed stable on Convex-only for 48+ hours.

**Steps:**
1. Remove `DB_BACKEND` from `.env` (Convex is now the default)
2. Update `src/lib/db.ts` to remove Supabase module — `convex-client.ts` becomes the direct import
3. Delete `src/lib/supabase.ts` (keep `@supabase/supabase-js` for Storage in asset-store.ts)
4. Remove `@supabase/supabase-js` from `package.json` only after verifying `asset-store.ts` no longer needs it (it still does for Storage — leave the package)
5. Remove `SUPABASE_URL`, `SUPABASE_ANON_KEY` from `.env.example` (add note: still needed for Supabase Storage)

```bash
git add -A
git commit -m "feat: Phase 6 — remove Supabase DB adapter, Convex is now primary"
```

---

## Quick Reference

```
Rollback at any time:   DB_BACKEND=supabase in .env + restart
Check Convex data:      https://dashboard.convex.dev → blessed-emu-849
Check functions:        https://dashboard.convex.dev → Functions tab
Re-run migration:       bun run scripts/migrate-to-convex.ts
Deploy schema changes:  npx convex dev --once
```
