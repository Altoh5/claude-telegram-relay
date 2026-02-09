# Architecture Overview

> This document provides a bird's-eye view of the entire system:
> components, data flow, session management, memory, error handling,
> and the file/directory structure.

---

## System Overview

```
+-------------------------------------------------------------------+
|                        macOS (launchd)                             |
|                                                                   |
|  +-------------------+  +------------------+  +-----------------+ |
|  | com.go.telegram-  |  | com.go.smart-    |  | com.go.morning- | |
|  | relay             |  | checkin          |  | briefing        | |
|  | (always-on)       |  | (scheduled)      |  | (daily)         | |
|  +--------+----------+  +--------+---------+  +--------+--------+ |
|           |                      |                      |         |
|  +--------v----------+  +--------v---------+  +--------v--------+ |
|  | src/bot.ts        |  | src/smart-       |  | src/morning-    | |
|  |                   |  | checkin.ts       |  | briefing.ts     | |
|  | Grammy Bot        |  |                  |  |                 | |
|  | Health Server     |  | Decision Engine  |  | Data Gatherer   | |
|  | Message Handlers  |  | (Claude decides) |  | (parallel fetch)| |
|  +--------+----------+  +--------+---------+  +--------+--------+ |
|           |                      |                      |         |
|           v                      v                      v         |
|  +--------------------------------------------------------+      |
|  |              Shared Libraries (src/lib/)                |      |
|  |                                                        |      |
|  |  claude.ts    -- Subprocess spawning                   |      |
|  |  supabase.ts  -- Database client                       |      |
|  |  memory.ts    -- Facts, goals, intents                 |      |
|  |  telegram.ts  -- Message sending, sanitization         |      |
|  |  voice.ts     -- ElevenLabs TTS + phone calls          |      |
|  |  transcribe.ts -- Gemini audio transcription           |      |
|  |  fallback-llm.ts -- OpenRouter + Ollama fallback       |      |
|  |  env.ts       -- Environment variable loader           |      |
|  +--------+------+-------+------+-------------------------+      |
|           |      |       |      |                                 |
|           v      v       v      v                                 |
|  +--------+  +---+---+  +------+-------+  +---------+            |
|  |Telegram|  |Claude |  |  Supabase    |  | Optional|            |
|  |  API   |  |Code   |  |  (Postgres)  |  |  APIs   |            |
|  |        |  |CLI    |  |              |  | ElevenL.|            |
|  +--------+  +-------+  +--------------+  | Gemini  |            |
|                                            | xAI     |            |
|  +-----------------+                       | OpenRtr |            |
|  | com.go.watchdog |                       | Ollama  |            |
|  | (hourly)        |                       +---------+            |
|  +-----------------+                                              |
+-------------------------------------------------------------------+
```

---

## Component Relationships

### Independent Processes

The system runs as four independent processes, not a monolith:

| Process | Type | Lifecycle |
|---------|------|-----------|
| `src/bot.ts` | Long-running daemon | Always on (launchd KeepAlive / PM2) |
| `src/smart-checkin.ts` | Short-lived script | Runs at scheduled times, exits |
| `src/morning-briefing.ts` | Short-lived script | Runs once daily, exits |
| `src/watchdog.ts` | Short-lived script | Runs hourly, exits |

They share code via `src/lib/` but do not communicate directly with each other.
Communication happens indirectly through:
- **Supabase** (shared database)
- **Telegram** (shared chat)
- **File system** (lock files, state files, logs)

### Shared Libraries

All processes import from `src/lib/`:

```
src/lib/
  env.ts          -- Used by ALL processes (loads .env)
  telegram.ts     -- Used by ALL processes (sends messages)
  claude.ts       -- Used by bot.ts and smart-checkin.ts
  google-auth.ts  -- Used by smart-checkin.ts and morning-briefing.ts
  supabase.ts     -- Used by bot.ts and morning-briefing.ts
  memory.ts       -- Used by bot.ts (intent processing)
  voice.ts        -- Used by bot.ts only
  transcribe.ts   -- Used by bot.ts only
  fallback-llm.ts -- Used by bot.ts only
```

---

## Direct API vs Claude Subprocess (Critical Pattern)

This is one of the most important architectural lessons in this system.

### The Problem

Claude Code subprocesses (`claude -p "..."`) initialize **all configured MCP
servers** on startup. If you have 5-13 MCP servers configured globally, each
subprocess spawns 5-13 child processes before it can do any work.

From an interactive terminal, this takes 5-15 seconds -- annoying but tolerable.
From **launchd** (background scheduler), it takes **60-180 seconds** and
frequently **times out entirely**.

### The Rule

**Use direct REST API calls for data fetching. Reserve Claude subprocesses for
reasoning/decisions only.**

| Task | Approach | Speed |
|------|----------|-------|
| Fetch calendar events | Direct Google Calendar REST API | <1s |
| Check unread emails | Direct Gmail REST API | <1s |
| Query Notion database | Direct Notion REST API | <1s |
| Fetch Supabase data | Direct REST API / SDK | <1s |
| Make a decision | Claude subprocess (no MCP tools) | 5-15s |
| Process user message | Claude subprocess (with tools) | 10-60s |

### How It Works

Google OAuth tokens are stored by the MCP servers when you first authenticate.
On **macOS**, tokens go into the Keychain. On **Windows/Linux**, tokens are
stored in `config/.google-tokens.json`. The `src/lib/google-auth.ts` module
detects the platform and reads tokens from the right location:

```typescript
import { getValidAccessToken, KEYCHAIN_CALENDAR } from "./lib/google-auth";

// Instant -- reads token from keychain (macOS) or file (Win/Linux), auto-refreshes if expired
const token = await getValidAccessToken(KEYCHAIN_CALENDAR);

// Direct API call -- no subprocess, no MCP server
const res = await fetch(
  `https://www.googleapis.com/calendar/v3/calendars/primary/events?...`,
  { headers: { Authorization: `Bearer ${token}` } }
);
```

Token refresh happens automatically via a cloud function that holds the OAuth
client secret. You never need to handle refresh manually.

### When to Use Each Pattern

**Direct API** (preferred for background scripts):
- Reading data from external services (Gmail, Calendar, Notion)
- Any operation that doesn't need AI reasoning
- Scheduled/background scripts (launchd, cron)

**Claude subprocess** (necessary for AI):
- Decision-making ("should I check in?")
- Natural language processing
- Complex reasoning with tool use
- The main bot relay (needs Claude for conversation)

### Key Files

- `src/lib/google-auth.ts` -- OAuth token management (cross-platform: keychain/file + auto-refresh)
- `src/smart-checkin.ts` -- Uses direct APIs for data, Claude only for decisions
- `src/morning-briefing.ts` -- Uses direct Calendar API for events

---

## Data Flow: Message Lifecycle

A complete message lifecycle from send to response:

```
1. User types "Research AI agents" in the Research topic on Telegram

2. Telegram servers deliver the update to Grammy via long polling

3. Security middleware checks user ID (src/bot.ts:210)
   PASS: userId matches ALLOWED_USER_ID

4. handleTextMessage() fires (src/bot.ts:232)
   - Text: "Research AI agents"
   - Topic ID: 3 (maps to "research" agent)
   - No built-in command match

5. saveMessage() persists to Supabase (src/lib/supabase.ts:175)
   - Tries edge function for embedding generation
   - Falls back to direct insert

6. callClaudeAndReply() begins (src/bot.ts:767)
   - Creates typing indicator
   - Calls callClaude()

7. callClaude() assembles context (src/bot.ts:656)
   - Loads Research agent config (src/agents/research.ts)
   - Loads user profile (config/profile.md)
   - Gets memory context (facts + goals from Supabase)
   - Gets conversation context (last 10 messages)
   - Adds session resumption note
   - Adds intent detection instructions
   - Joins all sections with --- separators

8. callClaudeSubprocess() spawns CLI (src/lib/claude.ts:69)
   - claude -p "<full prompt>" --output-format json
   - --allowedTools WebSearch,WebFetch,Read,Glob,Grep
   - --resume <sessionId>
   - 30-minute timeout with process kill

9. Claude Code processes the request
   - Follows ReAct reasoning from the Research agent prompt
   - May use WebSearch, WebFetch to gather information
   - Returns JSON with result and session_id

10. Response processing (src/bot.ts:729-760)
    - Parse JSON output
    - Update session ID
    - Check for errors -> fallback LLM chain if needed

11. Back in callClaudeAndReply() (src/bot.ts:780-798)
    - Save response to Supabase
    - processIntents() scans for [GOAL:], [DONE:], [REMEMBER:] tags
    - sendResponse() delivers to Telegram

12. sendResponse() (src/lib/telegram.ts:108)
    - Check for embedded image tags
    - Split long messages (>4000 chars) at paragraph boundaries
    - Send with Markdown parsing, fall back to plain text on error

13. User sees the response in Telegram
```

---

## Session Management

### How Sessions Work

Claude Code maintains conversation context through session IDs.
The bot persists the session ID in `session-state.json`:

```json
{
  "sessionId": "abc123-def456-ghi789",
  "pendingFiles": []
}
```

On each message:
1. Load session state from disk
2. Pass `--resume <sessionId>` to Claude
3. Claude continues the conversation context
4. Claude returns a (possibly new) session ID
5. Save updated session ID to disk

### Stale Sessions

Sessions can become stale if:
- The Claude CLI is updated (session format changes)
- The session expires server-side
- The session file is corrupted

When a stale session is detected (Claude returns an error), the bot
falls back to starting a new session without `--resume`.

### Timeout Handling

The 30-minute timeout is generous because Claude may be executing
complex tool chains (web searches, file reads, etc.):

```typescript
timeoutMs: 1_800_000, // 30 minutes
```

On timeout, the subprocess is **killed** (not just abandoned):

```typescript
const timeoutId = setTimeout(() => {
  timedOut = true;
  try { proc.kill(); } catch {}
}, timeoutMs);
```

This prevents zombie processes from accumulating.

---

## Memory Architecture

### Two-Tier Storage

```
Tier 1: Supabase (persistent, searchable, shared across processes)
  - messages table: conversation history
  - memory table: facts, goals
  - logs table: structured logging
  - call_transcripts: phone call records

Tier 2: Local files (fallback when Supabase unavailable)
  - memory.json: facts and goals
  - session-state.json: Claude session ID
  - checkin-state.json: check-in timing state
```

### Memory Flow

```
User message arrives
  |
  v
saveMessage() --> Supabase (messages table)
  |
  v
Claude processes --> response with intent tags
  |
  v
processIntents() --> Parse [GOAL:], [DONE:], [REMEMBER:]
  |                         |
  v                         v
addGoal()/addFact()    completeGoal()
  |                         |
  v                         v
Supabase (memory table) or memory.json (fallback)
```

### Context Assembly

Before each Claude call, memory is gathered:

```
getMemoryContext()        --> "Known Facts: ...\nActive Goals: ..."
getConversationContext()  --> "[2m ago] User: ...\n[1m ago] Bot: ..."
getUserProfile()          --> contents of config/profile.md
```

All three are injected into the prompt so Claude has full context.

---

## Error Handling: The Fallback Chain

```
Claude Code (primary)
  |
  | Error? (auth failure, rate limit, timeout)
  v
OpenRouter (cloud fallback)
  |
  | Error? (API key missing, service down)
  v
Ollama (local fallback)
  |
  | Error? (not running, model not downloaded)
  v
Static error message: "I'm having trouble connecting..."
```

Each tier is tried in order. The response indicates which tier was used:

```
Normal:   [response from Claude]
Fallback: [response from OpenRouter] _(responded via fallback)_
Error:    "I'm having trouble connecting to all my backends..."
```

---

## File and Directory Structure

```
go-telegram-bot/
  .env                          # Your API keys (never committed)
  .env.example                  # Template with placeholder values
  .gitignore                    # Excludes .env, node_modules, logs, etc.
  CLAUDE.md                     # Setup guide (read by Claude Code)
  README.md                     # Project overview
  package.json                  # Dependencies and npm scripts
  tsconfig.json                 # TypeScript configuration
  bun.lock                      # Dependency lock file

  src/
    bot.ts                      # Main relay daemon (877 lines)
    smart-checkin.ts            # Proactive check-in script (287 lines)
    morning-briefing.ts         # Daily briefing script (230 lines)
    watchdog.ts                 # Health monitor (122 lines)

    lib/
      env.ts                    # .env file loader (40 lines)
      claude.ts                 # Claude subprocess spawner (201 lines)
      supabase.ts               # Supabase client + all DB ops (533 lines)
      memory.ts                 # Unified memory with fallback (290 lines)
      telegram.ts               # Telegram helpers (195 lines)
      voice.ts                  # ElevenLabs TTS + calls (214 lines)
      transcribe.ts             # Gemini transcription (78 lines)
      fallback-llm.ts           # OpenRouter + Ollama chain (89 lines)
      google-auth.ts            # Google OAuth (cross-platform: keychain/file)

    agents/
      base.ts                   # AgentConfig interface, topic map, cross-agent (156 lines)
      index.ts                  # Registry and exports (53 lines)
      general.ts                # Orchestrator agent (80 lines)
      research.ts               # ReAct reasoning (56 lines)
      content.ts                # RoT reasoning (56 lines)
      finance.ts                # CoT reasoning (60 lines)
      strategy.ts               # ToT reasoning (62 lines)
      critic.ts                 # Devil's advocate (75 lines)
      custom-agent.example.ts   # Template for new agents (63 lines)

  config/
    profile.example.md          # User profile template
    schedule.example.json       # Check-in schedule template

  db/
    schema.sql                  # Supabase database schema (150 lines)

  setup/
    install.ts                  # Prerequisites checker + installer (cross-platform)
    configure-launchd.ts        # launchd plist generator (macOS)
    configure-services.ts       # PM2 + scheduler setup (Windows/Linux)
    verify.ts                   # Full health check (cross-platform)
    uninstall.ts                # Clean removal (cross-platform)

  launchd/                        # macOS service templates
    com.go.telegram-relay.plist.template
    com.go.smart-checkin.plist.template
    com.go.morning-briefing.plist.template
    com.go.watchdog.plist.template

  logs/                         # Service log files (gitignored)
  temp/                         # Temporary files (gitignored)
  uploads/                      # Downloaded media files (gitignored)
  docs/                         # Course documentation (you are here)
```

---

## Design Principles

1. **Single user, full power.** This is a personal AI system, not a SaaS product.
2. **Graceful degradation.** Missing APIs disable features, they do not crash.
3. **Process isolation.** Each service is independent -- one crashing does not take others down.
4. **Context over memory.** Claude gets full context each call rather than relying on session persistence alone.
5. **Local fallback.** Supabase down? Use local files. Claude down? Use OpenRouter. OpenRouter down? Use Ollama.

---

**Next document:** [Troubleshooting](./troubleshooting.md)
