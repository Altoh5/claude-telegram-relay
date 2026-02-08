# Troubleshooting

> This document covers common issues, their solutions, debugging commands,
> log file locations, and how to report problems.

---

## Common Issues and Fixes

### Bot Not Responding

**Symptoms:** You send a message on Telegram and get no reply.

**Check 1: Is the service running?**

```bash
launchctl list | grep com.go.telegram-relay
```

Expected output:
```
1234    0    com.go.telegram-relay
```

If the PID column shows `-`, the service is loaded but not running.
If the line is missing entirely, the service is not installed.

**Check 2: Is there a stale lock file?**

```bash
ls -la /path/to/go-telegram-bot/bot.lock
```

If the file exists and the bot is not running, delete it:

```bash
rm /path/to/go-telegram-bot/bot.lock
```

Then restart the service:

```bash
launchctl unload ~/Library/LaunchAgents/com.go.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/com.go.telegram-relay.plist
```

**Check 3: Check the logs**

```bash
tail -50 /path/to/go-telegram-bot/logs/telegram-relay.log
tail -50 /path/to/go-telegram-bot/logs/telegram-relay.error.log
```

Look for error messages about missing tokens, connection failures,
or uncaught exceptions.

**Check 4: Is your bot token still valid?**

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
```

If this returns an error, your token may have been revoked. Create
a new token with BotFather.

**Check 5: Is your user ID correct?**

The bot silently ignores messages from unauthorized users.
Double-check `TELEGRAM_USER_ID` in `.env` matches your actual ID.

---

### Claude Timeout

**Symptoms:** The bot shows "typing..." for a long time and then
responds with a fallback message or error.

**Cause:** Claude Code CLI is taking too long to respond.

**Fix 1: Increase the timeout**

In `src/bot.ts`, the default is 30 minutes:

```typescript
timeoutMs: 1_800_000, // 30 minutes
```

For simpler tasks, you might want to lower this. For complex multi-tool
chains, it may need to be higher.

**Fix 2: Check Claude authentication**

```bash
claude --version
claude -p "Hello" --output-format text
```

If Claude returns an auth error, re-authenticate:

```bash
claude
# Follow the OAuth flow
```

**Fix 3: Check for rate limiting**

Look for these patterns in the log:

```
API Error: 429
rate_limit_error
overloaded_error
```

These mean you have hit Anthropic's rate limits. Wait a few minutes
and try again, or configure a fallback LLM.

---

### Supabase Connection Failed

**Symptoms:** Messages are not being saved, goals/facts are not
persisting, or the verify script shows Supabase errors.

**Fix 1: Check your credentials**

```bash
bun run test:supabase
```

Common issues:
- URL missing the `https://` prefix
- Keys still contain placeholder values
- Wrong key type (anon vs service_role)

**Fix 2: Check the schema**

Go to your Supabase dashboard > Table Editor. Verify these tables exist:
- `messages`
- `memory`
- `logs`
- `call_transcripts`

If they are missing, run `db/schema.sql` in the SQL Editor.

**Fix 3: Check RLS policies**

If you can read but not write, the RLS policies may be misconfigured.
The simplest fix is to use the `SUPABASE_SERVICE_ROLE_KEY` (which
bypasses RLS entirely) instead of the anon key.

**Fix 4: Network connectivity**

```bash
curl -s -o /dev/null -w "%{http_code}" "https://your-project.supabase.co/rest/v1/"
```

Should return `200`. If it returns an error, check your network
connection or Supabase service status.

---

### launchd Service Not Starting

**Symptoms:** `launchctl list | grep com.go` shows no entries or
the service keeps exiting.

**Fix 1: Validate the plist XML**

```bash
plutil ~/Library/LaunchAgents/com.go.telegram-relay.plist
```

Should output: `OK`. If it shows errors, the XML is malformed.
Regenerate with:

```bash
bun run setup:launchd -- --service telegram-relay
```

**Fix 2: Check paths in the plist**

Open the plist and verify all paths are absolute and the files exist:

```bash
cat ~/Library/LaunchAgents/com.go.telegram-relay.plist
```

Check that:
- The bun path exists: `which bun`
- The project root exists
- The script file exists

**Fix 3: Unload and reload**

```bash
launchctl unload ~/Library/LaunchAgents/com.go.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/com.go.telegram-relay.plist
```

**Important:** You must unload before loading. Running `load` on an
already-loaded service will fail silently.

**Fix 4: Check for errors in launchd's own logs**

```bash
log show --predicate 'subsystem == "com.apple.xpc.launchd"' --last 5m | grep com.go
```

---

### Voice Not Working

**Symptoms:** Voice messages are not transcribed, or the bot does not
reply with audio.

**Fix 1: Check API keys**

```bash
bun run setup:verify
```

Look for the ElevenLabs and Gemini status in the output.

**Fix 2: Check voice is enabled**

In the bot startup log:

```
Voice:       enabled
Transcribe:  enabled
```

If either shows "disabled", the corresponding API keys are missing.

**Fix 3: Test ElevenLabs directly**

```bash
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/<VOICE_ID>" \
  -H "xi-api-key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello", "model_id": "eleven_turbo_v2_5"}' \
  --output test.mp3
```

If this fails, your API key or voice ID may be invalid.

**Fix 4: Check your Gemini key**

For transcription issues:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models?key=<GEMINI_KEY>"
```

Should return a list of models. If it returns an error, your key is invalid.

---

### Multiple Bot Instances

**Symptoms:** You receive duplicate responses to messages, or the bot
behaves erratically.

**Fix 1: Check for running processes**

```bash
ps aux | grep "bun run src/bot.ts"
```

If you see multiple processes, kill them all:

```bash
pkill -f "bun run src/bot.ts"
```

**Fix 2: Delete the lock file**

```bash
rm /path/to/go-telegram-bot/bot.lock
```

**Fix 3: Restart the service**

```bash
launchctl unload ~/Library/LaunchAgents/com.go.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/com.go.telegram-relay.plist
```

**Fix 4: Check launchctl for duplicate entries**

```bash
launchctl list | grep com.go.telegram-relay
```

There should be exactly one entry. If there are multiple, unload all
and reload once.

---

### MCP Servers Not Available in Subprocess

**Symptoms:** Claude does not have access to MCP tools (Google Calendar,
Notion, etc.) when called from the bot, even though they work in
direct Claude Code sessions.

**Explanation:** Claude Code picks up MCP server configuration based on
the current working directory. When spawned as a subprocess from the bot,
the working directory may differ from where your MCP servers are configured.

**Fix 1: Use global MCP scope**

Configure MCP servers in the global `~/.claude.json` under the top-level
`mcpServers` key, not in a project-scoped config.

**Fix 2: Set the working directory**

The bot sets `cwd: PROJECT_ROOT` when spawning Claude. Ensure your
MCP configuration is accessible from that path.

---

### JSON Parse Errors from Claude

**Symptoms:** The bot logs JSON parse errors or returns garbled responses.

**Explanation:** Claude Code subprocesses sometimes wrap JSON output in
markdown code fences:

````
```json
{"result": "Hello!", "session_id": "abc123"}
```
````

**Fix:** The bot already handles this in `src/lib/claude.ts` with the
`extractJSON()` function. If you encounter this in custom code:

```typescript
export function extractJSON(output: string, key: string): any | null {
  const cleaned = output.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
  const jsonMatch = cleaned.match(new RegExp(`\\{[\\s\\S]*"${key}"[\\s\\S]*\\}`));
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}
```

Always strip code fences before parsing JSON from Claude subprocesses.

---

## Debugging Commands Cheatsheet

```bash
# ---- Service Status ----
launchctl list | grep com.go              # Check all services
launchctl list com.go.telegram-relay      # Check specific service

# ---- Force-Run a Service ----
launchctl kickstart gui/$(id -u)/com.go.smart-checkin
launchctl kickstart gui/$(id -u)/com.go.morning-briefing

# ---- View Logs (Real-time) ----
tail -f logs/telegram-relay.log           # Bot main log
tail -f logs/smart-checkin.log            # Check-in log
tail -f logs/morning-briefing.log         # Briefing log
tail -f logs/watchdog.log                 # Watchdog log
tail -f logs/*.log                        # All logs at once

# ---- View Error Logs ----
tail -50 logs/telegram-relay.error.log
tail -50 logs/smart-checkin.error.log

# ---- Process Management ----
ps aux | grep "bun run src"               # Find running processes
cat bot.lock                              # Check lock file PID
rm bot.lock                               # Remove stale lock

# ---- Service Restart ----
launchctl unload ~/Library/LaunchAgents/com.go.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/com.go.telegram-relay.plist

# ---- Full Reset ----
bun run uninstall                         # Unload all services
rm bot.lock session-state.json            # Remove state files
bun run setup:launchd -- --service all    # Reinstall all services

# ---- Health Check ----
curl http://localhost:3000/health          # Bot health endpoint
bun run setup:verify                       # Full system health check

# ---- Test Individual Components ----
bun run test:telegram                      # Test Telegram connectivity
bun run test:supabase                      # Test Supabase connectivity
bun run checkin                            # Run check-in manually
bun run briefing                           # Run briefing manually

# ---- Claude CLI ----
claude --version                           # Check CLI version
claude -p "Hello" --output-format text     # Test Claude directly
```

---

## Log File Locations

All logs are in the `logs/` directory within the project root:

| File | Source | Content |
|------|--------|---------|
| `telegram-relay.log` | Main bot stdout | Message processing, startup/shutdown |
| `telegram-relay.error.log` | Main bot stderr | Errors, stack traces |
| `smart-checkin.log` | Check-in stdout | Decision logs, message sends |
| `smart-checkin.error.log` | Check-in stderr | Errors |
| `morning-briefing.log` | Briefing stdout | Data gathering, send status |
| `morning-briefing.error.log` | Briefing stderr | Errors |
| `watchdog.log` | Watchdog stdout | Health check results |
| `watchdog.error.log` | Watchdog stderr | Errors |

Supabase also stores structured logs in the `logs` table, queryable
from the Supabase dashboard or via the REST API.

---

## When to Reset

If nothing else works, a clean reset often helps:

```bash
# 1. Stop all services
bun run uninstall

# 2. Remove state files
rm -f bot.lock session-state.json checkin-state.json

# 3. Clear logs (optional)
rm -f logs/*.log

# 4. Reinstall dependencies
bun install

# 5. Verify configuration
bun run setup:verify

# 6. Test the bot manually
bun run start
# Send a test message on Telegram
# Ctrl+C to stop

# 7. If manual test works, reinstall services
bun run setup:launchd -- --service all
```

---

## How to Report Issues

When reporting a problem, include:

1. **What you expected** vs **what happened**
2. **Relevant log output** (last 50 lines of the appropriate log file)
3. **Your environment:**
   ```bash
   bun --version
   claude --version
   sw_vers                   # macOS version
   bun run setup:verify      # Health check output
   ```
4. **Steps to reproduce** the issue
5. **Any recent changes** you made (new API keys, code edits, etc.)

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/bot.ts` | Main bot with lock file, shutdown, health server |
| `src/lib/claude.ts` | Subprocess management, timeout, JSON extraction |
| `src/lib/supabase.ts` | Database connection test function |
| `src/lib/fallback-llm.ts` | Fallback chain with error logging |
| `setup/verify.ts` | Full system health check |
| `setup/configure-launchd.ts` | Service installer |
| `.env.example` | Environment variable reference |

---

**Back to start:** [00 - Prerequisites](./00-prerequisites.md)
