# Convex Migration Design
**Date:** 2026-03-03
**Approach:** Backend Adapter Pattern (Option 1 — zero downtime, instant rollback)

---

## Context

Migrating GoBot's database from Supabase (PostgreSQL + REST API) to Convex (all-TypeScript reactive database).

**Why:** Supabase REST API has silent failures — `NOT NULL` constraint violations return HTTP 200 with an empty body. Messages can vanish without a trace.

**Convex URL:** `https://blessed-emu-849.convex.cloud`
**Rollback at every phase:** change `DB_BACKEND` env var + restart.

---

## Scope

All 8 tables:
1. `messages` — conversation history + embeddings
2. `memory` — facts, goals, preferences
3. `logs` — observability
4. `call_transcripts` — voice call history
5. `async_tasks` — human-in-the-loop task management
6. `node_heartbeat` — hybrid mode health tracking
7. `assets` — file metadata + embeddings (files stay in Supabase Storage)
8. `twinmind_meetings` — TwinMind meeting cache

**Out of scope:** Supabase Storage bucket (`gobot-assets`) — actual image files stay there. Only metadata moves to Convex.

---

## Architecture

`DB_BACKEND` env var routes all database calls:

```
DB_BACKEND=supabase  →  src/lib/supabase.ts        (current, unchanged)
DB_BACKEND=dual      →  writes to both, reads from Convex
DB_BACKEND=convex    →  src/lib/convex-client.ts only
```

**New files:**
- `src/lib/db.ts` — router (uses `require()` not `import` to avoid crashes on envs without convex package)
- `src/lib/convex-client.ts` — drop-in replacement for `supabase.ts`, identical function signatures

**Import change** (one line per file):
```diff
- import { saveMessage, getFacts } from "./lib/supabase"
+ import { saveMessage, getFacts } from "./lib/db"
```

Files to update: `bot.ts`, `vps-gateway.ts`, `morning-briefing.ts`, `smart-checkin.ts`, `twinmind-monitor.ts`, and affected files under `src/lib/` and `src/agents/`.

Supabase Edge Functions (`store-telegram-message`, `search-memory`) become dead code at `DB_BACKEND=convex` — stay deployed but never called.

---

## Schema Translation

### Standard mappings

| Supabase | Convex |
|----------|--------|
| `BIGSERIAL`/`UUID PRIMARY KEY` | Auto `_id` (dropped) |
| `TIMESTAMPTZ DEFAULT NOW()` | Auto `_creationTime` (dropped) |
| `TEXT NOT NULL` | `v.string()` |
| `TEXT` (nullable) | `v.optional(v.string())` |
| `INTEGER` | `v.optional(v.number())` |
| `BOOLEAN DEFAULT FALSE` | `v.optional(v.boolean())` |
| `JSONB` | `v.optional(v.any())` |
| `VECTOR(1536)` | `v.optional(v.array(v.float64()))` |
| `TEXT[]` | `v.optional(v.array(v.string()))` |
| `CHECK (col IN ('a','b'))` | `v.union(v.literal("a"), v.literal("b"))` |
| `TIMESTAMPTZ` (non-default) | `v.optional(v.number())` (ms epoch) |

### Table-specific schemas

**messages**
```typescript
messages: defineTable({
  chat_id: v.string(),
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
  metadata: v.optional(v.any()),
  embedding: v.optional(v.array(v.float64())),
})
  .index("by_chat_id", ["chat_id"])
  .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536, filterFields: ["chat_id"] })
```

**memory**
```typescript
memory: defineTable({
  type: v.union(v.literal("fact"), v.literal("goal"), v.literal("completed_goal"), v.literal("preference")),
  content: v.string(),
  deadline: v.optional(v.number()),
  completed_at: v.optional(v.number()),
  priority: v.optional(v.number()),
  updatedAt: v.optional(v.number()),   // manual — Convex doesn't auto-update
  metadata: v.optional(v.any()),
})
  .index("by_type", ["type"])
```

**logs**
```typescript
logs: defineTable({
  level: v.union(v.literal("debug"), v.literal("info"), v.literal("warn"), v.literal("error")),
  event: v.string(),
  message: v.optional(v.string()),
  metadata: v.optional(v.any()),
  session_id: v.optional(v.string()),
  duration_ms: v.optional(v.number()),
})
  .index("by_level", ["level"])
  .index("by_event", ["event"])
```

**call_transcripts**
```typescript
callTranscripts: defineTable({
  conversation_id: v.string(),
  transcript: v.optional(v.string()),
  summary: v.optional(v.string()),
  action_items: v.optional(v.array(v.string())),
  duration_seconds: v.optional(v.number()),
  metadata: v.optional(v.any()),
})
  .index("by_conversation_id", ["conversation_id"])
```

**async_tasks**
```typescript
asyncTasks: defineTable({
  chat_id: v.string(),
  original_prompt: v.string(),
  status: v.union(v.literal("pending"), v.literal("running"), v.literal("needs_input"), v.literal("completed"), v.literal("failed")),
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
  .index("by_status", ["status"])
```

**node_heartbeat** *(special: TEXT primary key → field + index)*
```typescript
nodeHeartbeat: defineTable({
  node_id: v.string(),        // was PRIMARY KEY — now a field with unique index
  last_heartbeat: v.number(), // ms epoch
  metadata: v.optional(v.any()),
})
  .index("by_node_id", ["node_id"])
```

**assets**
```typescript
assets: defineTable({
  storage_path: v.string(),         // still points to Supabase Storage
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
  .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536, filterFields: [] })
```

**twinmind_meetings**
```typescript
twinmindMeetings: defineTable({
  meeting_id: v.string(),
  meeting_title: v.string(),
  summary: v.string(),
  action_items: v.optional(v.string()),
  start_time: v.number(),           // ms epoch
  end_time: v.optional(v.number()),
  processed: v.optional(v.boolean()),
  processed_at: v.optional(v.number()),
  synced_at: v.optional(v.number()),
  metadata: v.optional(v.any()),
})
  .index("by_meeting_id", ["meeting_id"])
  .index("by_processed", ["processed"])
```

---

## Server Functions

One file per table in `convex/`:

```
convex/
  schema.ts
  messages.ts         insert, getRecent, getById, backfillEmbedding, searchByVector (action)
  memory.ts           insert, patch, getByType, getAll, remove
  logs.ts             insert
  callTranscripts.ts  upsert, getByConversationId
  asyncTasks.ts       insert, patch, getById, getByChat, getByStatus
  nodeHeartbeat.ts    upsert (query-then-patch-or-insert mutation), getByNodeId
  assets.ts           insert, backfillEmbedding, searchByVector (action), getByFileType
  twinmindMeetings.ts upsert (query-then-patch-or-insert mutation), getUnprocessed, markProcessed
```

**Replacing SQL RPC functions:**
- `match_messages()` → `messages.searchByVector` action via `ctx.vectorSearch()`
- `match_assets()` → `assets.searchByVector` action via `ctx.vectorSearch()`

**Key patterns:**
- `nodeHeartbeat.upsert` and `twinmindMeetings.upsert` must be **mutations** (transactional query-then-patch-or-insert)
- Actions calling `ctx.runQuery(api.X.getById)` on the same module need explicit `Promise<any[]>` return type annotation (avoids circular type inference)

---

## Data Migration

**Script:** `scripts/migrate-to-convex.ts`

- Reads from Supabase REST API (paginated, 1000 rows/batch)
- Inserts into Convex preserving existing embeddings (no re-embedding cost)
- Converts: `null` → `undefined`, ISO strings → ms epoch for timestamp fields
- Run order: small tables first, `messages` last (largest)
- Idempotent — safe to re-run if interrupted (Convex generates new `_id` on each insert, so clear Convex table first if re-running)

**Verify:** compare row counts per table in Supabase dashboard vs Convex dashboard, spot-check 5 records per table.

---

## Client Adapter

**`src/lib/convex-client.ts`**
- Identical export signatures to `supabase.ts`
- Converts Convex `_id` → `id`, `_creationTime` → `created_at` (ISO string)
- Converts `null` → `undefined` for optional fields
- Vector search uses `ConvexHttpClient` with `api.messages.searchByVector` action

**`src/lib/db.ts`**
- Uses `require()` for lazy loading (prevents crash on VPS without convex package)
- Dual mode: `Promise.allSettled` for writes, Convex for reads
- One backend failing in dual mode does not block the other

---

## Gotchas

| Issue | Solution |
|-------|----------|
| `node_heartbeat` has TEXT primary key | Store as field, use `.index("by_node_id")`, upsert = query-then-patch-or-insert |
| `updated_at` fields | Pass `updatedAt: Date.now()` explicitly in every patch mutation |
| Supabase returns `null`, Convex wants `undefined` | `row.field ?? undefined` in migration script and convex-client |
| Timestamp fields → Convex `v.number()` | Convert to ms epoch on write, ISO string on read |
| Vector search threshold may differ | Existing `match_threshold: 0.5` may need tuning after migration |
| `assets` public_url still points to Supabase Storage | Keep as-is — Supabase Storage stays active |

---

## Phase Summary

```
Phase 0  ✅ Install convex, set CONVEX_URL + DB_BACKEND=supabase in .env
Phase 1     Create convex/schema.ts + 8 server function files, deploy
Phase 2     Create src/lib/convex-client.ts + src/lib/db.ts, update imports
Phase 3     Run scripts/migrate-to-convex.ts, verify row counts
Phase 4     Set DB_BACKEND=dual, test for 24-48h, verify both DBs match
Phase 5     Set DB_BACKEND=convex, monitor 48h
Phase 6     Remove supabase.ts adapter layer, clean up
```

**Rollback at any phase:** `DB_BACKEND=supabase` + restart.
