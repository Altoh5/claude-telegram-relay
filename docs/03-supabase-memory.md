# Module 3: Supabase Memory

> This module explains how the bot remembers things across restarts
> using Supabase as its persistent brain, with a local file fallback.

---

## Why Supabase?

The bot needs to remember three things:
1. **Conversation history** -- what you talked about yesterday
2. **Facts and goals** -- things you told it to remember
3. **Structured logs** -- what happened and when

Without persistence, every bot restart would wipe all context.
Supabase provides a PostgreSQL database with a REST API, making it
simple to store and query data from TypeScript without an ORM.

The free tier is sufficient for personal use (500MB storage, unlimited API calls).

---

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/supabase.ts` | Supabase client, message CRUD, memory, logging |
| `src/lib/memory.ts` | Unified memory layer with local fallback |
| `db/schema.sql` | Database table definitions and security policies |

---

## Database Tables

The schema in `db/schema.sql` defines four tables:

### messages

Stores every conversation message (both user and bot):

```sql
CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  message_text TEXT NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'assistant')),
  user_telegram_id TEXT,
  chat_telegram_id TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding VECTOR(1536)  -- Optional: for semantic search
);
```

The `metadata` column stores extra info like topic ID, message type
(voice, photo, document), and agent name.

The `embedding` column is optional -- if you set up an edge function for
generating embeddings, it enables semantic search across your conversations.

### memory

Stores facts and goals:

```sql
CREATE TABLE memory (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference')),
  content TEXT NOT NULL,
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  priority INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb
);
```

Types:
- `fact` -- something the bot should remember ("I'm allergic to shellfish")
- `goal` -- something you are working toward, with optional deadline
- `completed_goal` -- a finished goal (archived, not deleted)
- `preference` -- user preferences for bot behavior

### logs

Structured logging for observability:

```sql
CREATE TABLE logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  session_id TEXT,
  duration_ms INTEGER
);
```

The bot logs events like startup, shutdown, errors, and fallback activations.

### call_transcripts

Optional table for phone call history:

```sql
CREATE TABLE call_transcripts (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  conversation_id TEXT UNIQUE NOT NULL,
  transcript TEXT,
  summary TEXT,
  action_items TEXT[] DEFAULT '{}',
  duration_seconds INTEGER,
  metadata JSONB DEFAULT '{}'::jsonb
);
```

---

## Setting Up the Database

1. Go to your Supabase dashboard
2. Open the SQL Editor (left sidebar)
3. Create a new query
4. Paste the entire contents of `db/schema.sql`
5. Click "Run"

This creates all four tables, indexes, and security policies.

Verify with:

```bash
bun run test:supabase
```

---

## Intent Detection Tags

The bot uses structured tags in Claude's responses to automatically
manage memory. These are defined in `src/lib/memory.ts` (line 241):

### [GOAL: description | DEADLINE: deadline]

Adds a new goal with an optional deadline:

```
[GOAL: Finish the course outline | DEADLINE: tomorrow]
[GOAL: Launch the newsletter]
```

### [DONE: partial match]

Marks a goal as completed by matching against existing goal text:

```
[DONE: course outline]
```

### [REMEMBER: fact]

Stores a fact in memory:

```
[REMEMBER: User prefers morning meetings before 10am]
```

### How It Works

After every Claude response, `processIntents()` runs regex matching:

```typescript
const goalWithDeadline =
  /\[GOAL:\s*([^|\]]+?)\s*\|\s*DEADLINE:\s*([^\]]+?)\s*\]/gi;
```

It extracts the structured data and calls the appropriate memory function.
Claude is instructed to include these tags naturally in its responses
(see the "Intent Detection" section assembled in `callClaude()` in `src/bot.ts`).

---

## Manual Memory Commands

Users can also manage memory directly via text commands in `src/bot.ts`:

| Command | Example | Action |
|---------|---------|--------|
| `remember: <fact>` | `remember: my wifi password is on the fridge` | Stores a fact |
| `track: <goal>` | `track: finish course outline \| deadline: friday` | Adds a goal |
| `done: <match>` | `done: course outline` | Completes a matching goal |
| `goals` or `/goals` | `goals` | Lists all active goals |
| `memory` or `/memory` | `memory` | Lists all stored facts |
| `recall <query>` | `recall what we discussed about pricing` | Semantic search |

---

## Semantic Search

The bot supports two search modes, both in `src/lib/supabase.ts`:

### Edge Function Search (Recommended)

If you deploy a Supabase edge function at `/functions/v1/search-memory`,
the bot uses vector embeddings for true semantic search:

```typescript
const edgeUrl = `${url}/functions/v1/search-memory`;
```

This finds messages by meaning, not just keyword matching.

### Text Fallback

When the edge function is unavailable, the bot falls back to
PostgreSQL `ILIKE` for basic substring matching:

```typescript
const { data } = await sb
  .from("messages")
  .ilike("content", `%${query}%`)
```

---

## Conversation Context

Before every Claude call, the bot fetches the last 10 messages
from Supabase to build conversation context:

```typescript
const conversationCtx = await getConversationContext(chatId, 10);
```

This returns formatted lines like:

```
[2 minutes ago] User: What should I work on today?
[1 minute ago] Bot: Based on your goals, I'd focus on...
```

This gives Claude awareness of the recent conversation without
needing to send the entire history.

---

## Memory Context

The bot also builds a memory context with facts and goals:

```typescript
const memoryCtx = await getMemoryContext();
```

This returns something like:

```
**Known Facts:**
- User is based in Berlin
- Morning meetings preferred before 10am

**Active Goals:**
1. Finish course outline (due: Feb 10)
2. Launch the newsletter
```

This context is included in every Claude prompt so the AI is always
aware of what you are working toward.

---

## Local File Fallback

If Supabase is unavailable (misconfigured, network down, etc.), the memory
module in `src/lib/memory.ts` falls back to a local JSON file:

```typescript
const MEMORY_PATH = join(process.cwd(), "memory.json");
```

The local file stores the same data structure:

```json
{
  "facts": ["User is based in Berlin"],
  "goals": [
    { "text": "Finish course outline", "deadline": "2026-02-10", "createdAt": "..." }
  ],
  "completedGoals": [
    { "text": "Set up the bot", "completedAt": "..." }
  ]
}
```

Every public function in `memory.ts` checks `isSupabaseEnabled()` first:

```typescript
export async function addFact(content: string): Promise<boolean> {
  if (isSupabaseEnabled()) {
    return sbAddFact(content);
  }
  // Fall back to local file
  const memory = await readLocalMemory();
  memory.facts.push(content);
  await writeLocalMemory(memory);
  return true;
}
```

This means the bot works even without Supabase -- you just lose persistence
across machine restarts (since the local file is not backed up automatically).

---

## Row Level Security

The schema enables RLS on all tables and creates policies:

- **service_role** gets full access (read + write on everything)
- **anon** gets read access on messages and memory, plus insert on messages/memory/logs

Use the `SUPABASE_SERVICE_ROLE_KEY` in your `.env` for the bot (full access).
If you build a dashboard, the `SUPABASE_ANON_KEY` provides safe read-only access.

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `db/schema.sql` | Complete database schema with indexes and RLS |
| `src/lib/supabase.ts` | Supabase client, all database operations |
| `src/lib/memory.ts` | Unified memory with Supabase + local fallback |
| `src/bot.ts` lines 240-347 | Memory commands (remember, track, done, goals) |
| `.env.example` | Supabase credential placeholders |

---

**Next module:** [04 - Multi-Agent System](./04-multi-agent-system.md)
