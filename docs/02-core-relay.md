# Module 2: Core Relay

> This module explains the central pattern of the system: how a Telegram
> message becomes an AI response and travels back to the user.

---

## The Relay Pattern

The core architecture follows a simple relay:

```
User (Telegram) --> Bot (Grammy) --> Claude Code (subprocess) --> Bot --> User (Telegram)
```

1. **User sends a message** on Telegram (text, voice, photo, or document)
2. **Grammy library** receives it via long polling
3. **Bot** determines the agent, builds context, and spawns a Claude subprocess
4. **Claude Code** processes the prompt with tools, memory, and agent instructions
5. **Bot** receives Claude's response, persists it, processes intents, and sends it back
6. **User sees the reply** on Telegram

The entire system is a single-user relay -- it is your personal AI pipeline.

---

## Key File: src/bot.ts

This is the main entry point (877 lines). It orchestrates everything:

| Section | Lines | Purpose |
|---------|-------|---------|
| Environment loading | 55-56 | Loads `.env` variables |
| Configuration | 60-76 | Reads bot token, user ID, timezone |
| Session state | 84-117 | Persists Claude session IDs across restarts |
| Process lock | 123-165 | Prevents multiple bot instances |
| Graceful shutdown | 170-204 | Clean exit on SIGINT/SIGTERM |
| Security middleware | 210-217 | User ID whitelist check |
| Text handler | 225-415 | Commands, search, routing, Claude call |
| Voice handler | 419-492 | Download, transcribe, process, reply |
| Photo handler | 496-570 | Download, process with Claude vision, reply |
| Document handler | 574-646 | Download, process, reply |
| callClaude() | 656-761 | Core AI processing with context assembly |
| Health server | 823-846 | HTTP endpoint for monitoring |
| Bot startup | 852-877 | Long polling initialization |

---

## How callClaude() Works

The `callClaude()` function in `src/bot.ts` (line 656) is the heart of the system.
It assembles the full prompt and spawns a Claude subprocess.

### Context Assembly

Before calling Claude, the function gathers multiple context layers:

```
1. Agent system prompt (from src/agents/*.ts)
2. User profile (from config/profile.md)
3. Current time (in user's timezone)
4. Memory context (facts + active goals from Supabase/local)
5. Recent conversation (last 10 messages from Supabase)
6. Session resumption note (if continuing a session)
7. Intent detection instructions (GOAL/DONE/REMEMBER tags)
8. The actual user message
```

All sections are joined with `---` separators and sent as a single prompt.

### Subprocess Spawning

The actual subprocess is spawned by `callClaudeSubprocess()` in `src/lib/claude.ts`:

```typescript
const proc = spawn({
  cmd: [CLAUDE_PATH, ...args],
  cwd: cwd || process.cwd(),
  env: {
    ...process.env,
    HOME: process.env.HOME || "",
    PATH: process.env.PATH || "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  },
  stdout: "pipe",
  stderr: "pipe",
});
```

Key flags passed to the CLI:
- `-p <prompt>` -- the assembled prompt
- `--output-format json` -- structured output with session ID
- `--allowedTools <list>` -- agent-specific tool restrictions
- `--resume <sessionId>` -- continue an existing conversation

### Session Resumption

The bot maintains a session ID across messages. When Claude responds, it
returns a `session_id` in its JSON output. The bot saves this to
`session-state.json` and passes it as `--resume` on the next call.

This means Claude retains context about your ongoing conversation
without the bot needing to re-send the full history every time.

### Timeout Handling

Claude gets a 30-minute timeout (configurable):

```typescript
const result = await callClaudeSubprocess({
  prompt: fullPrompt,
  timeoutMs: 1_800_000, // 30 minutes
});
```

In `src/lib/claude.ts`, the timeout properly kills the subprocess to prevent
zombie processes:

```typescript
let timedOut = false;
const timeoutId = setTimeout(() => {
  timedOut = true;
  try { proc.kill(); } catch {}
}, timeoutMs);
```

This is critical -- `Promise.race` alone would leave orphaned processes.

---

## Process Locking

The bot uses a `bot.lock` file to prevent multiple instances from running
simultaneously (lines 123-165 in `src/bot.ts`).

### How It Works

1. On startup, check if `bot.lock` exists
2. If it exists and was updated in the last 90 seconds, another instance is running -- exit
3. If it exists but is stale (>90s old), take over
4. Write current PID to `bot.lock`
5. Update the lock file every 60 seconds (heartbeat)
6. On shutdown, delete `bot.lock`

This prevents the common issue where launchd restarts the bot while
a previous instance is still processing a message.

---

## Graceful Shutdown

The bot handles multiple shutdown signals (lines 170-204):

```typescript
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("uncaughtException", async (error) => {
  await sbLog("error", "bot", `Uncaught exception: ${error.message}`);
  await shutdown("uncaughtException");
});
```

The shutdown sequence:
1. Stop the heartbeat interval
2. Stop the Grammy bot (stops long polling)
3. Save session state to disk
4. Release the process lock
5. Log the shutdown to Supabase
6. Exit cleanly

---

## Message Flow: Text Messages

When you send a text message, here is the exact sequence:

1. Grammy receives the update via long polling
2. Security middleware checks your user ID (line 210)
3. `handleTextMessage()` is called (line 232)
4. The message is saved to Supabase (`saveMessage()`)
5. Built-in commands are checked:
   - `remember:` -- store a fact
   - `track:` -- add a goal with optional deadline
   - `done:` -- complete a goal
   - `goals` / `memory` -- list stored data
   - `recall` / `search` / `find` -- semantic search
   - `/critic` -- invoke the Critic agent
   - `/board` -- trigger a board meeting
   - `call me` -- initiate a phone call
6. If none match, determine the agent from the topic ID (line 413)
7. Call `callClaudeAndReply()` which:
   - Shows a typing indicator
   - Calls `callClaude()` to process with the AI
   - Saves the response to Supabase
   - Processes intents (GOAL/DONE/REMEMBER tags)
   - Sends the response via Telegram

---

## Message Flow: Voice Messages

Voice messages follow a different path (lines 419-492):

1. Download the voice file from Telegram's servers
2. Save it locally to `uploads/voice_<timestamp>.ogg`
3. Transcribe using Gemini (`transcribeAudio()` from `src/lib/transcribe.ts`)
4. Send the transcription to Claude as `[Voice message transcription]: ...`
5. If voice replies are enabled, respond with audio (ElevenLabs TTS)
6. Clean up the temporary file

---

## Message Flow: Photos and Documents

Photos (lines 496-570) and documents (lines 574-646) follow similar patterns:

1. Download the file from Telegram
2. Save locally to `uploads/`
3. Include the local file path in the Claude prompt
4. Claude can read the file using its built-in tools
5. Response is sent back as text

For photos, Claude uses its vision capability to analyze images.
The prompt includes `[User sent an image saved at: /path/to/file.jpg]`.

---

## Health Check Server

The bot runs a minimal HTTP server for monitoring (lines 823-846):

```bash
curl http://localhost:3000/health
```

Returns JSON with:
- `status`: "ok"
- `uptime`: seconds since start
- `pid`: process ID
- `sessionId`: current Claude session
- `timestamp`: current time

The port is configurable via `HEALTH_PORT` in `.env` (default: 3000).

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/bot.ts` | Main relay daemon -- the core of the entire system |
| `src/lib/claude.ts` | Claude subprocess spawning, timeout, JSON extraction |
| `src/lib/telegram.ts` | Message sending, sanitization, typing indicators |
| `src/lib/memory.ts` | Intent processing (GOAL/DONE/REMEMBER tags) |
| `src/lib/supabase.ts` | Message persistence, conversation context |

---

**Next module:** [03 - Supabase Memory](./03-supabase-memory.md)
