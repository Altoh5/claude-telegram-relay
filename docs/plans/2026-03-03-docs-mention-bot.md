# Google Docs @Mention Bot — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Monitor Gmail for Docs @mention notifications, poll watched docs for new comments via Drive API, draft replies with Claude, and post them after human approval via Telegram.

**Architecture:** Hybrid Gmail (discovery) + Drive API (comments/replies). `docs-monitor.ts` runs as a launchd service polling every 60s. New comments become async_tasks that surface in Telegram for edit-then-post approval.

**Tech Stack:** Bun, GrammY, Google Drive REST API v3, Gmail REST API v1, Supabase, existing `async_tasks` table, `claude -p` subprocess.

---

## Task 1: Update bot OAuth scopes (add `drive`)

The current refresh token only has `gmail.readonly` + `documents`. Posting comment replies requires `drive` scope.

**Files:**
- Modify: `setup/setup-google-oauth-bot.ts`

**Step 1: Add `drive` scope**

In `setup/setup-google-oauth-bot.ts`, update the `SCOPES` constant:

```typescript
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive",
].join(" ");
```

(Remove `https://www.googleapis.com/auth/documents` — `drive` is a superset.)

**Step 2: Re-run the OAuth flow**

Make sure incognito is signed in as `altoh.bot@gmail.com`, then:

```bash
bun run setup/setup-google-oauth-bot.ts
```

When prompted, save to `.env`. This replaces `GOOGLE_BOT_DOCS_REFRESH_TOKEN` with a new token that includes `drive` scope.

**Step 3: Verify the new token has drive scope**

```bash
# Quick check — should return 200 with files list
source .env
ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=$GOOGLE_CLIENT_ID&client_secret=$GOOGLE_CLIENT_SECRET&refresh_token=$GOOGLE_BOT_DOCS_REFRESH_TOKEN&grant_type=refresh_token" \
  | bun -e "const d = await Bun.stdin.json(); console.log(d.access_token)")
curl -s "https://www.googleapis.com/drive/v3/files?pageSize=1" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | grep -q '"files"' && echo "✅ drive scope ok" || echo "❌ failed"
```

Expected: `✅ drive scope ok`

**Step 4: Commit**

```bash
git add setup/setup-google-oauth-bot.ts
git commit -m "feat: add drive scope to bot OAuth setup script"
```

---

## Task 2: Create Supabase tables

**Files:**
- Modify: `db/schema.sql` (append)

**Step 1: Add migrations via Supabase MCP**

Run these two SQL statements in the Supabase MCP (project `ikzomtgjcqbukcpitptu`):

```sql
-- Table 1: docs the bot is watching
CREATE TABLE IF NOT EXISTS watched_docs (
  doc_id     TEXT PRIMARY KEY,
  doc_title  TEXT,
  active     BOOLEAN NOT NULL DEFAULT true,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table 2: comment IDs already processed (prevents double-replies)
CREATE TABLE IF NOT EXISTS processed_comments (
  comment_id    TEXT PRIMARY KEY,
  doc_id        TEXT NOT NULL REFERENCES watched_docs(doc_id),
  task_id       TEXT,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Step 2: Verify tables exist**

```bash
bun -e "
  const { createClient } = await import('@supabase/supabase-js');
  await import('./src/lib/env').then(m => m.loadEnv());
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error: e1 } = await sb.from('watched_docs').select('doc_id').limit(1);
  const { error: e2 } = await sb.from('processed_comments').select('comment_id').limit(1);
  console.log(e1 ? '❌ watched_docs: ' + e1.message : '✅ watched_docs ok');
  console.log(e2 ? '❌ processed_comments: ' + e2.message : '✅ processed_comments ok');
"
```

Expected: both `✅`.

**Step 3: Append to schema.sql and commit**

Append the SQL above to `db/schema.sql`, then:

```bash
git add db/schema.sql
git commit -m "feat: add watched_docs and processed_comments tables"
```

---

## Task 3: Create `src/lib/google-bot-auth.ts`

Token refresh for the bot account. Same pattern as `src/lib/data-sources/google-auth.ts` but reads `GOOGLE_BOT_DOCS_REFRESH_TOKEN`.

**Files:**
- Create: `src/lib/google-bot-auth.ts`

**Step 1: Write the file**

```typescript
/**
 * Google OAuth Token Refresh — Bot Account (altoh.bot@gmail.com)
 *
 * Same pattern as src/lib/data-sources/google-auth.ts but uses the
 * bot account's refresh token (GOOGLE_BOT_DOCS_REFRESH_TOKEN).
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID        (shared with main account)
 *   GOOGLE_CLIENT_SECRET    (shared with main account)
 *   GOOGLE_BOT_DOCS_REFRESH_TOKEN
 */

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export function isBotAuthAvailable(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_BOT_DOCS_REFRESH_TOKEN
  );
}

export async function getBotAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const refreshToken = process.env.GOOGLE_BOT_DOCS_REFRESH_TOKEN!;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing bot OAuth env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_BOT_DOCS_REFRESH_TOKEN"
    );
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bot token refresh failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.accessToken;
}
```

**Step 2: Smoke test**

```bash
bun -e "
  await import('./src/lib/env').then(m => m.loadEnv());
  const { getBotAccessToken } = await import('./src/lib/google-bot-auth');
  const token = await getBotAccessToken();
  console.log(token ? '✅ token ok: ' + token.slice(0, 20) + '...' : '❌ no token');
"
```

Expected: `✅ token ok: ya29.a0...`

**Step 3: Commit**

```bash
git add src/lib/google-bot-auth.ts
git commit -m "feat: add google-bot-auth.ts for bot account token refresh"
```

---

## Task 4: Create `src/lib/docs-api.ts`

Three functions: export doc as text, list comments, post a reply.

**Files:**
- Create: `src/lib/docs-api.ts`

**Step 1: Write the file**

```typescript
/**
 * Google Drive API helpers for Docs comment bot.
 *
 * All calls use the bot account (altoh.bot@gmail.com) via google-bot-auth.ts.
 * The bot must have at least Commenter access on any doc it replies to.
 */

import { getBotAccessToken } from "./google-bot-auth";

export interface DocComment {
  id: string;
  content: string;
  author: string;
  resolved: boolean;
  createdTime: string;
}

/**
 * Export a Google Doc as plain text for Claude context.
 */
export async function fetchDocAsText(docId: string): Promise<string> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    throw new Error(`Drive export failed (${response.status}): ${await response.text()}`);
  }
  const text = await response.text();
  // Truncate to ~8000 chars to stay within Claude context
  return text.length > 8000 ? text.slice(0, 8000) + "\n\n[...truncated]" : text;
}

/**
 * Fetch doc metadata (title).
 */
export async function fetchDocTitle(docId: string): Promise<string> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}?fields=name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) return "Untitled Document";
  const data = await response.json();
  return data.name || "Untitled Document";
}

/**
 * List all unresolved comments on a doc.
 */
export async function listComments(docId: string): Promise<DocComment[]> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/comments?fields=comments(id,content,author,resolved,createdTime)&includeDeleted=false`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    throw new Error(`Drive comments failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  const comments: DocComment[] = (data.comments || []).map((c: any) => ({
    id: c.id,
    content: c.content || "",
    author: c.author?.displayName || "Unknown",
    resolved: c.resolved || false,
    createdTime: c.createdTime || "",
  }));
  return comments.filter((c) => !c.resolved);
}

/**
 * Post a reply to a comment thread.
 */
export async function postCommentReply(
  docId: string,
  commentId: string,
  text: string
): Promise<void> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/comments/${commentId}/replies?fields=id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    }
  );
  if (!response.ok) {
    throw new Error(`Post reply failed (${response.status}): ${await response.text()}`);
  }
}
```

**Step 2: Smoke test** (needs a real doc shared with the bot account — skip if no doc yet)

```bash
bun -e "
  await import('./src/lib/env').then(m => m.loadEnv());
  const { listComments } = await import('./src/lib/docs-api');
  // Replace with a doc ID shared with altoh.bot@gmail.com
  const comments = await listComments('YOUR_DOC_ID_HERE');
  console.log('Comments:', JSON.stringify(comments, null, 2));
"
```

**Step 3: Commit**

```bash
git add src/lib/docs-api.ts
git commit -m "feat: add docs-api.ts with Drive comment/reply helpers"
```

---

## Task 5: Create `src/docs-monitor.ts`

The main polling service. Two phases per loop: Gmail discovery, then Drive comment polling.

**Files:**
- Create: `src/docs-monitor.ts`

**Step 1: Write the file**

```typescript
/**
 * Google Docs @Mention Bot — Monitor Service
 *
 * Phase 1 (Gmail): Detects new @mention emails → adds docs to watched_docs.
 * Phase 2 (Drive): Polls watched docs for new comments → Claude draft → Telegram HITL.
 *
 * Run manually: bun run src/docs-monitor.ts
 * Scheduled:    launchd com.go.docs-monitor (every 60s, 8am-10pm)
 */

import { loadEnv } from "./lib/env";
import { getBotAccessToken, isBotAuthAvailable } from "./lib/google-bot-auth";
import {
  fetchDocAsText,
  fetchDocTitle,
  listComments,
  type DocComment,
} from "./lib/docs-api";
import { sendTelegramMessage } from "./lib/telegram";
import { createClient } from "@supabase/supabase-js";

await loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_USER_ID!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ============================================================
// PHASE 1: Gmail Discovery
// ============================================================

/**
 * Check Gmail for unread @mention emails from Google Docs.
 * Extracts doc IDs and upserts them into watched_docs.
 */
async function discoverDocsFromGmail(): Promise<void> {
  const token = await getBotAccessToken();

  // Search for unread emails from the Docs notification sender
  const searchRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from:comments-noreply@docs.google.com+is:unread&maxResults=20`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!searchRes.ok) {
    console.error(`Gmail search failed: ${searchRes.status}`);
    return;
  }

  const searchData = await searchRes.json();
  const messages: { id: string }[] = searchData.messages || [];
  if (messages.length === 0) return;

  console.log(`Found ${messages.length} new @mention email(s)`);

  for (const msg of messages) {
    try {
      // Fetch full message to extract doc URL
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!msgRes.ok) continue;
      const msgData = await msgRes.json();

      // Extract doc ID from the email body/headers
      const docId = extractDocIdFromEmail(msgData);
      if (!docId) {
        console.log(`Could not extract doc ID from email ${msg.id}`);
        await markEmailRead(token, msg.id);
        continue;
      }

      // Upsert into watched_docs
      const sb = getSupabase();
      if (sb) {
        const title = await fetchDocTitle(docId).catch(() => "Untitled Document");
        await sb
          .from("watched_docs")
          .upsert({ doc_id: docId, doc_title: title, active: true }, { onConflict: "doc_id" });
        console.log(`Watching doc: ${title} (${docId})`);
      }

      // Mark email as read
      await markEmailRead(token, msg.id);
    } catch (err) {
      console.error(`Error processing email ${msg.id}:`, err);
    }
  }
}

/** Extract Google Doc ID from email body. Looks for docs.google.com URLs. */
function extractDocIdFromEmail(msgData: any): string | null {
  // Search payload parts for doc URL
  const body = extractEmailBody(msgData.payload);
  const match = body.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function extractEmailBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractEmailBody(part);
      if (result) return result;
    }
  }
  return "";
}

async function markEmailRead(token: string, messageId: string): Promise<void> {
  await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    }
  );
}

// ============================================================
// PHASE 2: Drive Comment Polling
// ============================================================

async function pollWatchedDocs(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const { data: docs, error } = await sb
    .from("watched_docs")
    .select("doc_id, doc_title")
    .eq("active", true);

  if (error || !docs?.length) return;

  for (const doc of docs) {
    await processDoc(doc.doc_id, doc.doc_title || "Untitled Document");
  }
}

async function processDoc(docId: string, docTitle: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  let comments: DocComment[];
  try {
    comments = await listComments(docId);
  } catch (err: any) {
    const msg = err.message || "";
    if (msg.includes("403") || msg.includes("404")) {
      // Bot lost access — deactivate
      console.warn(`Lost access to doc ${docId}, deactivating`);
      await sb.from("watched_docs").update({ active: false }).eq("doc_id", docId);
      await sendTelegramMessage(
        BOT_TOKEN,
        CHAT_ID,
        `⚠️ Docs bot lost access to *${docTitle}*.\nMake sure altoh.bot@gmail.com has at least Commenter access.`,
        undefined,
        "Markdown"
      );
    } else {
      console.error(`Error fetching comments for ${docId}:`, err);
    }
    return;
  }

  if (!comments.length) return;

  // Filter to unprocessed comments
  const commentIds = comments.map((c) => c.id);
  const { data: processed } = await sb
    .from("processed_comments")
    .select("comment_id")
    .in("comment_id", commentIds);

  const processedIds = new Set((processed || []).map((r: any) => r.comment_id));
  const newComments = comments.filter((c) => !processedIds.has(c.id));

  for (const comment of newComments) {
    await handleNewComment(docId, docTitle, comment);
  }
}

async function handleNewComment(
  docId: string,
  docTitle: string,
  comment: DocComment
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  console.log(`New comment in "${docTitle}" from ${comment.author}: ${comment.content.slice(0, 80)}`);

  // Fetch doc content for Claude context
  let docText = "";
  try {
    docText = await fetchDocAsText(docId);
  } catch (err) {
    console.warn("Could not fetch doc text for context:", err);
  }

  // Draft a reply with Claude
  const draft = await draftReply(docTitle, comment, docText);

  // Create async task in Supabase
  const { data: task } = await sb
    .from("async_tasks")
    .insert({
      chat_id: CHAT_ID,
      original_prompt: `Reply to Docs comment in "${docTitle}"`,
      status: "needs_input",
      metadata: {
        type: "docs_comment",
        docId,
        docTitle,
        commentId: comment.id,
        commentAuthor: comment.author,
        commentText: comment.content,
        draft,
      },
    })
    .select()
    .single();

  if (!task) {
    console.error("Failed to create async task");
    return;
  }

  // Send Telegram message
  const msgText =
    `📄 New comment in *${escapeMarkdown(docTitle)}*\n` +
    `From: ${escapeMarkdown(comment.author)}\n\n` +
    `> ${escapeMarkdown(comment.content)}\n\n` +
    `*Draft reply:*\n${escapeMarkdown(draft)}\n\n` +
    `_Reply to this message to edit the draft._\n` +
    `\`/post ${task.id}\` to publish • \`/skip ${task.id}\` to dismiss`;

  const sentMsg = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, msgText, undefined, "Markdown");

  // Store telegram message ID in task metadata
  if (sentMsg?.message_id) {
    await sb
      .from("async_tasks")
      .update({
        metadata: {
          ...task.metadata,
          telegramMessageId: sentMsg.message_id,
        },
      })
      .eq("id", task.id);
  }

  // Mark comment as processed
  await sb.from("processed_comments").insert({
    comment_id: comment.id,
    doc_id: docId,
    task_id: task.id,
  });
}

async function draftReply(
  docTitle: string,
  comment: DocComment,
  docText: string
): Promise<string> {
  try {
    const { runClaudeWithTimeout } = await import("./lib/claude");
    const contextSection = docText
      ? `\n\nDocument content:\n<doc>\n${docText.slice(0, 6000)}\n</doc>`
      : "";

    const prompt =
      `You are a helpful AI assistant for Alvin Toh. Draft a concise, professional reply to the following comment left in a Google Doc.${contextSection}\n\n` +
      `Document: "${docTitle}"\n` +
      `Comment from ${comment.author}: "${comment.content}"\n\n` +
      `Write only the reply text, no preamble. Be helpful and specific.`;

    const result = await runClaudeWithTimeout(prompt, 30_000);
    return result?.trim() || "(Draft unavailable — write your reply above)";
  } catch (err) {
    console.error("Claude draft failed:", err);
    return "(Claude unavailable — write your reply above)";
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  if (!isBotAuthAvailable()) {
    console.error(
      "Bot OAuth not configured. Run: bun run setup/setup-google-oauth-bot.ts"
    );
    process.exit(1);
  }

  console.log(`[${new Date().toISOString()}] docs-monitor starting`);

  try {
    await discoverDocsFromGmail();
  } catch (err) {
    console.error("Gmail discovery error:", err);
  }

  try {
    await pollWatchedDocs();
  } catch (err) {
    console.error("Drive polling error:", err);
  }

  console.log(`[${new Date().toISOString()}] docs-monitor done`);
}

await main();
```

**Step 2: Test a dry run (no docs needed yet)**

```bash
bun run src/docs-monitor.ts
```

Expected (with no watched docs yet):
```
[2026-...] docs-monitor starting
[2026-...] docs-monitor done
```

**Step 3: Commit**

```bash
git add src/docs-monitor.ts
git commit -m "feat: add docs-monitor.ts — Gmail discovery + Drive comment polling"
```

---

## Task 6: Handle `/post` and `/skip` in `bot.ts`

Add three behaviours to the existing `handleTextMessage` function in `src/bot.ts`:
1. `/post <taskId>` — fetch task, call `postCommentReply`, confirm
2. `/skip <taskId>` — mark task cancelled
3. Reply to a docs draft message → update `draft` in task metadata

**Files:**
- Modify: `src/bot.ts`

**Step 1: Add the import at the top of `bot.ts`**

Near the other imports, add:

```typescript
import { postCommentReply } from "./lib/docs-api";
```

**Step 2: Add handlers inside `handleTextMessage`**

Add these blocks *before* the final `processMessage` call (around line 400, after the existing command handlers):

```typescript
// /post <taskId> — publish a docs comment draft
if (lowerText.startsWith("/post ")) {
  const taskId = text.slice(6).trim();
  await handleDocsPost(ctx, taskId);
  return;
}

// /skip <taskId> — dismiss a docs comment task
if (lowerText.startsWith("/skip ")) {
  const taskId = text.slice(6).trim();
  await handleDocsSkip(ctx, taskId);
  return;
}

// Reply to a docs draft message — update the draft
const replyToId = ctx.message?.reply_to_message?.message_id;
if (replyToId) {
  const handled = await handleDocsDraftEdit(ctx, replyToId, text);
  if (handled) return;
}
```

**Step 3: Add the three handler functions** (add near the bottom of `bot.ts`, before `bot.start()`):

```typescript
async function handleDocsPost(ctx: Context, taskId: string): Promise<void> {
  const sb = getSupabase();
  if (!sb || !taskId) {
    await ctx.reply("❌ Invalid task ID.");
    return;
  }

  const { data: task } = await sb
    .from("async_tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (!task || task.metadata?.type !== "docs_comment") {
    await ctx.reply("❌ Task not found or already completed.");
    return;
  }

  const { docId, commentId, docTitle, draft } = task.metadata;

  try {
    await postCommentReply(docId, commentId, draft);
    await sb
      .from("async_tasks")
      .update({ status: "completed" })
      .eq("id", taskId);
    await ctx.reply(
      `✅ Reply posted to *${docTitle}*\n\n> ${draft}`,
      { parse_mode: "Markdown" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Failed to post reply: ${err.message}`);
  }
}

async function handleDocsSkip(ctx: Context, taskId: string): Promise<void> {
  const sb = getSupabase();
  if (!sb || !taskId) return;

  await sb
    .from("async_tasks")
    .update({ status: "failed", result: "skipped by user" })
    .eq("id", taskId);

  await ctx.reply("↩️ Comment dismissed.");
}

async function handleDocsDraftEdit(
  ctx: Context,
  replyToMessageId: number,
  newDraft: string
): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  // Find task with this telegramMessageId in metadata
  const { data: tasks } = await sb
    .from("async_tasks")
    .select("*")
    .eq("status", "needs_input")
    .eq("chat_id", String(ctx.chat?.id || ""));

  const task = (tasks || []).find(
    (t: any) => t.metadata?.telegramMessageId === replyToMessageId &&
                t.metadata?.type === "docs_comment"
  );

  if (!task) return false;

  // Update the draft in metadata
  await sb
    .from("async_tasks")
    .update({
      metadata: { ...task.metadata, draft: newDraft },
    })
    .eq("id", task.id);

  await ctx.reply(
    `✏️ Draft updated.\n\n> ${newDraft}\n\n\`/post ${task.id}\` to publish • \`/skip ${task.id}\` to dismiss`,
    { parse_mode: "Markdown" }
  );

  return true;
}
```

**Step 4: Test the flow**

Start the bot and run docs-monitor manually to generate a test task:

```bash
# Terminal 1
bun run start

# Terminal 2 — inject a test task directly into Supabase to simulate a comment
bun -e "
  await import('./src/lib/env').then(m => m.loadEnv());
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await sb.from('async_tasks').insert({
    chat_id: process.env.TELEGRAM_USER_ID,
    original_prompt: 'Test docs comment',
    status: 'needs_input',
    metadata: {
      type: 'docs_comment',
      docId: 'test-doc-id',
      docTitle: 'Test Document',
      commentId: 'test-comment-id',
      commentAuthor: 'Test User',
      commentText: 'What is the deadline for this?',
      draft: 'The deadline is March 31st.',
      telegramMessageId: 999999,
    }
  });
  console.log('Test task created');
"
```

Then in Telegram:
- Send `/post <taskId>` — should attempt to post (will fail with test IDs, that's fine)
- Send `/skip <taskId>` — should reply "↩️ Comment dismissed."

**Step 5: Commit**

```bash
git add src/bot.ts
git commit -m "feat: add /post, /skip, and draft-edit handlers for Docs comment bot"
```

---

## Task 7: Add launchd service

**Files:**
- Create: `launchd/com.go.docs-monitor.plist.template`

**Step 1: Create the template**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.go.docs-monitor</string>

    <key>ProgramArguments</key>
    <array>
        <string>{{BUN_PATH}}</string>
        <string>run</string>
        <string>src/docs-monitor.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>{{PROJECT_ROOT}}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{BUN_DIR}}:{{CLAUDE_DIR}}:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{{HOME}}</string>
        <key>GO_PROJECT_ROOT</key>
        <string>{{PROJECT_ROOT}}</string>
    </dict>

    <!-- Every 60s, 8am-10pm -->
    <key>StartCalendarInterval</key>
    <array>
        {{CALENDAR_INTERVALS}}
    </array>

    <key>StandardOutPath</key>
    <string>{{PROJECT_ROOT}}/logs/docs-monitor.log</string>

    <key>StandardErrorPath</key>
    <string>{{PROJECT_ROOT}}/logs/docs-monitor.error.log</string>
</dict>
</plist>
```

**Step 2: Register and load the service**

```bash
bun run setup:launchd -- --service docs-monitor
launchctl list | grep com.go.docs-monitor
```

Expected: service appears in launchctl list.

**Step 3: Verify logs after first run**

```bash
tail -20 logs/docs-monitor.log
```

Expected: `docs-monitor starting` / `docs-monitor done` with no errors.

**Step 4: Commit**

```bash
git add launchd/com.go.docs-monitor.plist.template
git commit -m "feat: add launchd service for docs-monitor"
```

---

## Task 8: Update `.env.example`

**Files:**
- Modify: `.env.example`

**Step 1: Add the new env var**

Find the Google section in `.env.example` and add:

```bash
# Google Docs Bot Account (altoh.bot@gmail.com)
# Run: bun run setup/setup-google-oauth-bot.ts
GOOGLE_BOT_DOCS_REFRESH_TOKEN=
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add GOOGLE_BOT_DOCS_REFRESH_TOKEN to .env.example"
```

---

## End-to-End Test

1. Share a Google Doc with `altoh.bot@gmail.com` (Commenter access)
2. @mention `altoh.bot@gmail.com` in a comment on that doc
3. Wait up to 60s for `docs-monitor.ts` to run, or trigger manually:
   ```bash
   bun run src/docs-monitor.ts
   ```
4. Telegram should receive the draft message
5. Reply to it in Telegram to refine, then send `/post <taskId>`
6. Check the Google Doc — the bot's reply should appear in the comment thread
