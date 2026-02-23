# TwinMind Meeting Summary Monitor — Design

## Summary

A scheduled service that checks TwinMind every 30 minutes for new meeting summaries, creates two infographic styles via NotebookLM, and sends everything to Telegram.

## Architecture

Standalone TypeScript script (`src/twinmind-monitor.ts`) run by launchd on `StartCalendarInterval` — same pattern as `morning-briefing.ts` and `smart-checkin.ts`.

## Flow

```
launchd fires (every 30 min, 8:00–22:00)
  → Load env + last-checked timestamp from state file
  → Call TwinMind summary_search (filter: start_time > last_checked)
  → If no new summaries → log "no new meetings" → exit
  → For each new summary:
      1. Format summary as Telegram markdown → send to bot
      2. Add summary text as source to persistent NLM notebook
      3. Create standard infographic:
         nlm infographic create <notebook-id> --source-ids <new-source-id> -y
      4. Create sketchnote infographic:
         nlm infographic create <notebook-id> --source-ids <new-source-id> --focus "sketchnote style" -y
      5. Poll nlm studio status until both complete (timeout: 5 min each)
      6. Download both → /tmp/twinmind-<meeting-id>-standard.png, /tmp/twinmind-<meeting-id>-sketchnote.png
      7. Send both infographics to Telegram via sendPhoto API
      8. Clean up temp files
  → Update last-checked timestamp → exit
```

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scheduling | StartCalendarInterval (29 intervals, 8am–10pm) | Survives sleep, fires after wake if missed |
| NLM notebook | Single persistent notebook | Accumulates all meetings; --source-ids isolates per-meeting |
| State tracking | `logs/twinmind-monitor-state.json` | Stores `lastCheckedTime` ISO string |
| Dedup | TwinMind `start_time` filter | Only fetches summaries newer than last check |
| Infographic timeout | 5 min per infographic | If timeout, send summary text only with warning |
| Infographic styles | Standard + sketchnote (via --focus) | Two visual perspectives of same content |
| Telegram delivery | 3 messages: summary text, standard infographic, sketchnote | Immediate text value, then visuals follow |

## New Files

| File | Purpose |
|------|---------|
| `src/twinmind-monitor.ts` | Main service script |
| `launchd/com.go.twinmind-monitor.plist.template` | launchd template with 29 calendar intervals |

## New Env Vars

```
TWINMIND_NLM_NOTEBOOK_ID=<notebook-id>   # Persistent NLM notebook for meeting infographics
```

## Error Handling

- **TwinMind API failure** → log error, exit (retry next interval)
- **NLM source add failure** → log error, skip infographics, still send summary text
- **NLM infographic creation/poll failure** → send summary text only, log warning
- **Telegram send failure** → log error, do NOT update lastCheckedTime (retry next run)
- **Multiple new summaries** → process sequentially to avoid NLM rate limits

## Telegram Output (per meeting)

**Message 1 — Summary text:**
```
📋 New Meeting Summary

**{meeting_title}**
{start_time} — {end_time}

{summary text}

{action items if any}
```

**Message 2 — Standard infographic:**
Photo with caption: `📊 Infographic: {meeting_title}`

**Message 3 — Sketchnote infographic:**
Photo with caption: `✏️ Sketchnote: {meeting_title}`
