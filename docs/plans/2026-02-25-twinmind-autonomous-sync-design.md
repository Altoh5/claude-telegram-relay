# TwinMind Autonomous Sync Design

**Date:** 2026-02-25
**Status:** Approved
**Author:** Alvin Toh

---

## Problem

`twinmind-monitor.ts` runs every 30 min via launchd and sends meeting summaries + infographics to Telegram. However, it only reads meetings already in Supabase. New meetings from TwinMind only reach Supabase when Alvin opens an interactive Claude Code session (which triggers the session-start hook in `~/.claude/CLAUDE.md`).

**Result:** When away from the computer, the monitor fires but finds nothing new — even if TwinMind has recorded meetings since the last Claude Code session.

---

## Solution: Direct MCP HTTP Sync

Add a `syncFromTwinmindDirect()` step at the **top** of `twinmind-monitor.ts`, before the existing Supabase fetch. This step:

1. Reads the TwinMind Bearer token from `~/.claude/.credentials.json`
2. POSTs a `tools/call summary_search` JSON-RPC 2.0 request to `https://api.thirdear.live/v3/mcp`
3. Parses the meeting list from the response
4. Upserts new meetings to Supabase (`twinmind_meetings` table, `ON CONFLICT DO UPDATE`)
5. Falls back gracefully — logs a warning and continues with existing Supabase data if the call fails

**No new files. No new launchd jobs. No new dependencies.**

---

## Architecture

```
launchd fires (every 30 min, 8am–10pm)
       ↓
twinmind-monitor.ts starts
       ↓
syncFromTwinmindDirect()           ← NEW
  - read token from ~/.claude/.credentials.json
  - POST tools/call summary_search (last 7 days) → https://api.thirdear.live/v3/mcp
  - upsert new meetings to Supabase
  - on failure: log warning, continue
       ↓
fetchUnprocessedMeetings()         ← existing
  - query Supabase for processed=false
       ↓
processMeeting() for each          ← existing
  - send summary text to Telegram
  - generate infographics via NotebookLM nlm CLI
  - send infographics to Telegram
  - mark processed=true
```

---

## Key Implementation Details

### Token Reading

```typescript
const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
const creds = JSON.parse(await readFile(credsPath, 'utf-8'));
const twinmindAuth = Object.values(creds.mcpOAuth ?? {})
  .find((a: any) => a.serverUrl?.includes('thirdear.live'));
const accessToken = twinmindAuth?.accessToken;
```

### MCP HTTP Call

```typescript
const response = await fetch('https://api.thirdear.live/v3/mcp', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'summary_search',
      arguments: { start_time: sevenDaysAgo, limit: 20 }
    }
  })
});
```

### Supabase Upsert

Same SQL as the CLAUDE.md session hook:
```sql
INSERT INTO twinmind_meetings (meeting_id, meeting_title, summary, action_items, start_time, end_time)
VALUES (...)
ON CONFLICT (meeting_id) DO UPDATE SET
  meeting_title = EXCLUDED.meeting_title,
  summary = EXCLUDED.summary,
  action_items = EXCLUDED.action_items,
  synced_at = NOW();
```
Note: does **not** overwrite `processed` or `processed_at` — safe to re-run.

### Error Handling

- Token missing → log "TwinMind token not found in credentials, skipping direct sync" and continue
- Token expired (HTTP 401) → log "TwinMind token expired, skipping direct sync" and continue
- Network error → log error and continue
- Malformed response → log and continue

The monitor always falls through to the Supabase fetch, so it processes any previously synced meetings even if direct sync fails.

---

## What Is NOT Changing

- `twinmind_meetings` Supabase schema — no migration needed
- The launchd plist — already correct (`/Users/alvin/claudeprojects/claude-telegram-relay`)
- `TWINMIND_NLM_NOTEBOOK_ID` — already set in `.env`
- The session-start hook in `CLAUDE.md` — kept as a redundant safety sync
- All existing processing logic in `twinmind-monitor.ts`

---

## Success Criteria

- [ ] TwinMind monitor syncs new meetings without Claude Code open
- [ ] Graceful fallback when token is expired or network fails
- [ ] No duplicate processing (upsert is idempotent, `processed` flag respected)
- [ ] Tested end-to-end: run `bun run src/twinmind-monitor.ts --force` and verify Telegram receives new meetings
