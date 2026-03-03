# Google Docs @Mention Bot — Design

**Date:** 2026-03-03
**Status:** Approved

## Overview

A background service that monitors Gmail for Google Docs @mention notifications,
discovers new docs automatically, then uses the Drive API to read comments and post
Claude-drafted replies — with a human-in-the-loop step via Telegram.

## Architecture

```
Gmail (altoh.bot@gmail.com)
    ↓ poll every 60s for emails from comments-noreply@docs.google.com
    ↓ parse: extract docId only
    ↓ upsert into watched_docs table in Supabase

docs-monitor.ts (60s poll loop)
    ↓ load all watched_docs from Supabase
    ↓ for each doc: GET /drive/v3/files/{docId}/comments
    ↓ skip already-processed comment IDs (tracked in Supabase)
    ↓ new comment found →
        ↓ fetch doc as plain text via Drive export
        ↓ ask Claude for draft reply (context-aware)
        ↓ create async_task + send Telegram draft

Telegram (Alvin)
    ↓ reply to message to refine draft
    ↓ /post → Drive API posts reply to Doc comment thread ✅
    ↓ /skip → mark done, no reply posted
```

## Design Decisions

- **Gmail for discovery only** — extracts doc ID from @mention emails, adds to
  `watched_docs`. No comment parsing from email (brittle).
- **Drive API for comments** — structured data, no email parsing. Polls all
  watched docs every 60s.
- **Hybrid approach chosen over:** config-list (too manual) and Gmail-only
  (email parsing is fragile and misses comment structure).
- **Human-in-the-loop via Telegram** — Claude drafts, user refines by replying,
  confirms with `/post`. Reuses existing `async_tasks` pattern.
- **Context-aware replies** — Claude reads the full doc content before drafting,
  not just the comment thread.

## Components

### New Files

**`src/docs-monitor.ts`**
- Main poll loop (60s interval)
- Two sub-loops: Gmail discovery + Drive comment polling
- Spawns Claude for draft generation
- Creates async_tasks + sends Telegram messages

**`src/lib/google-bot-auth.ts`**
- Token refresh for `altoh.bot@gmail.com`
- Uses `GOOGLE_BOT_DOCS_REFRESH_TOKEN`
- Separate cache from `google-auth.ts` (main account)

**`src/lib/docs-api.ts`**
- `fetchDocAsText(docId)` — Drive export as `text/plain`
- `listNewComments(docId, knownIds)` — Drive comments endpoint, filters resolved
- `postCommentReply(docId, commentId, text)` — Drive replies endpoint

### Modified Files

**`src/bot.ts`**
- Detect reply to a docs draft task → update draft in `async_tasks`
- Detect `/post` in docs task context → call `postCommentReply`, confirm
- Detect `/skip` → mark task cancelled

**`setup/setup-google-oauth-bot.ts`**
- Add `https://www.googleapis.com/auth/drive` scope
- Re-run to replace `GOOGLE_BOT_DOCS_REFRESH_TOKEN`

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS watched_docs (
  doc_id      TEXT PRIMARY KEY,
  doc_title   TEXT,
  active      BOOLEAN DEFAULT true,
  added_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_comments (
  id          BIGSERIAL PRIMARY KEY,
  doc_id      TEXT NOT NULL,
  comment_id  TEXT NOT NULL UNIQUE,
  task_id     TEXT,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);
```

## OAuth Scopes (bot account)

| Scope | Purpose |
|-------|---------|
| `gmail.readonly` | Detect @mention emails, discover new docs |
| `https://www.googleapis.com/auth/drive` | List comments, post replies, export doc text |

Note: Current refresh token only has `gmail.readonly` + `documents`.
Must re-run `setup/setup-google-oauth-bot.ts` with updated scopes before deployment.

## Environment Variables

```
GOOGLE_BOT_DOCS_REFRESH_TOKEN=   # bot account refresh token (drive scope)
GOOGLE_CLIENT_ID=                # existing — shared with main account
GOOGLE_CLIENT_SECRET=            # existing — shared with main account
```

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Gmail parse fails | Log and skip; don't crash loop |
| Doc not accessible | Mark `watched_docs.active = false`; Telegram warning |
| Drive API rate limit | Exponential backoff, max 3 retries; spread polls across 60s window |
| Claude draft fails | Create task anyway; send raw comment to Telegram for manual reply |
| Comment already resolved | Skip (check `resolved` field in Drive API response) |
| Task not actioned after 24h | Auto-expire to `skipped` |
| Token refresh fails | Telegram alert; halt polling |

## launchd Service

New plist: `com.go.docs-monitor` — mirrors `com.go.twinmind-monitor` pattern.
Runs every 60s, 8am–10pm.
