# Module 9: Hooks and Security

> This module covers the security model of the bot: user whitelisting,
> process locking, environment variable protection, database security,
> and how Claude Code hooks can add observability and data redaction.

---

## Security Layers Overview

The bot has multiple security layers:

```
Layer 1: Telegram user ID whitelist (who can talk to the bot)
Layer 2: Process locking (prevent duplicate instances)
Layer 3: Environment variable isolation (.env in .gitignore)
Layer 4: Supabase Row Level Security (database access control)
Layer 5: Claude Code subprocess isolation (restricted tools per agent)
```

---

## TELEGRAM_USER_ID Whitelist

**File:** `src/bot.ts` (lines 210-217)

The most critical security measure. Every incoming message is checked:

```typescript
bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id || "");
  if (userId !== ALLOWED_USER_ID) {
    return; // Silently ignore
  }
  await next();
});
```

This middleware runs before any message handler. If the sender's
Telegram user ID does not match your configured ID, the message
is silently dropped.

### Why This Matters

- Your bot runs Claude Code with your API credits
- Without this check, anyone who finds your bot could generate
  unlimited AI responses at your expense
- The bot has access to your memory, goals, and files -- unauthorized
  access would be a privacy breach

### Why Silent Rejection

The bot does not reply with "Unauthorized" or "Access denied". This is
intentional -- responding to unauthorized users would:
1. Confirm the bot is active (information leak)
2. Waste API calls on error messages
3. Encourage further probing

---

## Process Locking

**File:** `src/bot.ts` (lines 123-165)

Prevents multiple bot instances from running simultaneously.

### The Problem

If launchd restarts the bot while a previous instance is still shutting
down, both instances would receive the same messages and respond twice.

### The Solution

A lock file (`bot.lock`) with PID and heartbeat:

```typescript
async function acquireLock(): Promise<boolean> {
  const lockStat = await stat(LOCK_FILE).catch(() => null);
  if (lockStat) {
    const lockAge = Date.now() - lockStat.mtimeMs;
    if (lockAge < 90_000) {
      // Another instance is alive (heartbeat within 90s)
      return false;
    }
    // Stale lock -- take over
  }
  await writeFile(LOCK_FILE, String(process.pid), "utf-8");
  return true;
}
```

The heartbeat updates the lock file every 60 seconds:

```typescript
const heartbeatInterval = setInterval(async () => {
  await writeFile(LOCK_FILE, String(process.pid), "utf-8");
}, 60_000);
```

If a lock file exists but has not been touched in 90 seconds, it is
considered stale (the previous process crashed) and the new instance
takes over.

On graceful shutdown, the lock file is deleted:

```typescript
async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE);
}
```

---

## Environment Variable Security

### .gitignore Protection

The `.gitignore` file excludes `.env` from version control:

```
.env
```

This prevents accidentally pushing API keys and tokens to a public
repository.

### Separation of Secrets

The `.env.example` file contains only placeholder values:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here
SUPABASE_URL=https://your-project.supabase.co
```

Real values live only in `.env` which is never committed.

### Minimal Environment Forwarding

When spawning Claude subprocesses, only necessary environment variables
are forwarded (see `src/lib/claude.ts`, lines 97-103):

```typescript
env: {
  ...process.env,
  HOME: process.env.HOME || "",
  PATH: process.env.PATH || "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
},
```

This passes the full environment but ensures critical paths are set.

---

## Supabase Row Level Security

**File:** `db/schema.sql` (lines 79-114)

RLS is enabled on all four tables. The policies define who can do what:

### Service Role (Full Access)

The bot uses the `service_role` key, which bypasses all policies:

```sql
CREATE POLICY "Service role full access" ON messages
  FOR ALL USING (auth.role() = 'service_role');
```

This gives the bot unrestricted read/write access.

### Anon Key (Limited Access)

The `anon` key gets read access to messages and memory, plus insert
access to messages, memory, and logs:

```sql
CREATE POLICY "Anon read access" ON messages
  FOR SELECT USING (auth.role() = 'anon');

CREATE POLICY "Anon insert access" ON messages
  FOR INSERT WITH CHECK (auth.role() = 'anon');
```

This is useful if you build a read-only dashboard -- it can view data
but cannot delete or modify existing records.

### Best Practices

- Use `SUPABASE_SERVICE_ROLE_KEY` for the bot (server-side, trusted)
- Use `SUPABASE_ANON_KEY` for any client-side tools (dashboards, etc.)
- Never expose the service role key in client-side code

---

## Claude Code Tool Restrictions

Each agent has a whitelist of allowed tools:

```typescript
// Research Agent - no filesystem write, no shell
allowedTools: ["WebSearch", "WebFetch", "Read", "Glob", "Grep"],

// General Agent - full access including shell
allowedTools: ["Read", "Write", "Glob", "Grep", "WebSearch", "WebFetch", "Bash"],
```

This means:
- The Research agent can search the web and read files, but cannot
  execute shell commands or write files
- Only the General agent has `Bash` access
- The Critic agent has minimal tools (Read, WebSearch)

This follows the principle of least privilege -- each agent only gets
the tools it needs for its purpose.

---

## Claude Code Hooks

Claude Code supports hooks that run before/after tool invocations.
While this project does not ship with hooks pre-configured, here
are two patterns you can add:

### Security Hook: Redact Sensitive Data

Create a hook that scrubs API keys from Claude's responses:

```json
// .claude/hooks.json
{
  "postToolExecution": [
    {
      "matcher": { "tool": "*" },
      "command": "node scripts/redact-secrets.js"
    }
  ]
}
```

The script reads Claude's output and replaces any detected API keys,
tokens, or credentials with `[REDACTED]`.

### Capture Hook: Log All Tool Usage

Create a hook that logs every tool invocation for observability:

```json
{
  "preToolExecution": [
    {
      "matcher": { "tool": "*" },
      "command": "node scripts/log-tool-use.js"
    }
  ]
}
```

This gives you an audit trail of what Claude does during processing.

---

## Error Handling and Logging

### Uncaught Exception Handler

```typescript
process.on("uncaughtException", async (error) => {
  await sbLog("error", "bot", `Uncaught exception: ${error.message}`, {
    stack: error.stack,
  });
  await shutdown("uncaughtException");
});
```

All uncaught exceptions are logged to Supabase before shutdown.

### Structured Logging

The `log()` function in `src/lib/supabase.ts` provides structured logging:

```typescript
export async function log(
  level: "info" | "warn" | "error" | "debug",
  service: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await sb.from("logs").insert({ level, service, message, metadata });
}
```

Events logged include:
- Bot startup/shutdown
- Claude subprocess errors
- Fallback LLM activations
- Service health checks

---

## Graceful Shutdown Security

The shutdown sequence ensures no data is lost:

```typescript
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;  // Prevent double shutdown
  isShuttingDown = true;

  clearInterval(heartbeatInterval);  // Stop heartbeat
  bot.stop();                         // Stop polling
  await saveSessionState();           // Persist session
  await releaseLock();                // Release lock file
  await sbLog("info", "bot", `Shutdown: ${signal}`);

  process.exit(0);
}
```

The `isShuttingDown` flag prevents recursive shutdown if multiple
signals arrive simultaneously.

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/bot.ts` lines 210-217 | User ID whitelist middleware |
| `src/bot.ts` lines 123-165 | Process lock with heartbeat |
| `src/bot.ts` lines 170-204 | Graceful shutdown handler |
| `src/lib/claude.ts` | Subprocess environment isolation |
| `src/lib/supabase.ts` | Structured logging and RLS |
| `src/agents/base.ts` | Per-agent tool restrictions |
| `db/schema.sql` | RLS policies |
| `.gitignore` | Excludes .env from version control |

---

**Next module:** [10 - Customization Guide](./10-customization-guide.md)
