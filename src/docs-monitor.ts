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
  postCommentReply,
  type DocComment,
  type DocReply,
} from "./lib/docs-api";
import { getSupabase } from "./lib/supabase";

await loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_USER_ID!;

// ============================================================
// TELEGRAM HELPER
// Returns the raw API result (with message_id) for task linkage.
// We use fetch directly here rather than sendTelegramMessage because
// sendTelegramMessage returns boolean only — we need message_id.
// ============================================================

async function sendMessage(text: string): Promise<{ message_id?: number } | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "MarkdownV2",
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result || null;
  } catch {
    return null;
  }
}

// ============================================================
// PHASE 1: Gmail Discovery
// ============================================================

async function discoverDocsFromGmail(): Promise<void> {
  const token = await getBotAccessToken();

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
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!msgRes.ok) continue;
      const msgData = await msgRes.json();

      const docId = extractDocIdFromEmail(msgData);
      if (!docId) {
        console.log(`Could not extract doc ID from email ${msg.id}`);
        await markEmailRead(token, msg.id);
        continue;
      }

      const sb = getSupabase();
      if (sb) {
        const title = await fetchDocTitle(docId).catch(() => "Untitled Document");
        await sb
          .from("watched_docs")
          .upsert({ doc_id: docId, doc_title: title, active: true }, { onConflict: "doc_id" });
        console.log(`Watching doc: ${title} (${docId})`);
      }

      await markEmailRead(token, msg.id);
    } catch (err) {
      console.error(`Error processing email ${msg.id}:`, err);
    }
  }
}

function extractDocIdFromEmail(msgData: any): string | null {
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
      console.warn(`Lost access to doc ${docId}, deactivating`);
      await sb.from("watched_docs").update({ active: false }).eq("doc_id", docId);
      await sendMessage(
        `⚠️ Docs bot lost access to *${escapeMarkdown(docTitle)}*.\nMake sure altoh.bot@gmail.com has at least Commenter access.`
      );
    } else {
      console.error(`Error fetching comments for ${docId}:`, err);
    }
    return;
  }

  if (!comments.length) return;

  // Collect all IDs to check: top-level comments + all reply IDs
  const allIds: string[] = [];
  for (const c of comments) {
    allIds.push(c.id);
    for (const r of c.replies) allIds.push(r.id);
  }

  const { data: processed } = await sb
    .from("processed_comments")
    .select("comment_id")
    .in("comment_id", allIds);

  const processedIds = new Set((processed || []).map((r: any) => r.comment_id));

  // Handle new top-level comments
  for (const comment of comments) {
    if (!processedIds.has(comment.id)) {
      await handleNewComment(docId, docTitle, comment);
      processedIds.add(comment.id); // avoid double-processing within same run
    }
  }

  // Handle new user replies within already-processed comment threads
  for (const comment of comments) {
    if (!processedIds.has(comment.id)) continue; // only in threads we've handled
    for (const reply of comment.replies) {
      if (!processedIds.has(reply.id) && reply.author !== "alt bot") {
        await handleNewReply(docId, docTitle, comment, reply);
        processedIds.add(reply.id);
      }
    }
  }
}

async function handleNewComment(
  docId: string,
  docTitle: string,
  comment: DocComment
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  console.log(
    `New comment in "${docTitle}" from ${comment.author}: ${comment.content.slice(0, 80)}`
  );

  let docText = "";
  try {
    docText = await fetchDocAsText(docId);
  } catch (err) {
    console.warn("Could not fetch doc text for context:", err);
  }

  const draft = await draftReply(docTitle, comment, docText);

  // Post draft immediately to the doc comment thread
  let replyId: string | null = null;
  try {
    replyId = await postCommentReply(docId, comment.id, draft);
    console.log(`Posted draft reply to doc (replyId: ${replyId})`);
  } catch (err) {
    console.error("Failed to post draft to doc:", err);
  }

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
        replyId,
      },
    })
    .select()
    .single();

  if (!task) {
    console.error("Failed to create async task");
    return;
  }

  const postedNote = replyId
    ? `_Draft posted to doc\\. Reply here to update it in the doc\\._`
    : `_Could not post to doc — reply here to set a draft\\._`;

  const msgText =
    `📄 New comment in *${escapeMarkdown(docTitle)}*\n` +
    `From: ${escapeMarkdown(comment.author)}\n\n` +
    `> ${escapeMarkdown(comment.content)}\n\n` +
    `*Drafted reply:*\n${escapeMarkdown(draft)}\n\n` +
    `${postedNote}\n` +
    `\`/skip ${task.id}\` to delete from doc`;

  const sentMsg = await sendMessage(msgText);

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

  // Mark the top-level comment and our bot reply as processed
  const inserts: any[] = [{ comment_id: comment.id, doc_id: docId, task_id: String(task.id) }];
  if (replyId) inserts.push({ comment_id: replyId, doc_id: docId, task_id: String(task.id) });
  await sb.from("processed_comments").insert(inserts);
}

async function handleNewReply(
  docId: string,
  docTitle: string,
  comment: DocComment,
  reply: DocReply
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  console.log(`New reply in "${docTitle}" from ${reply.author}: ${reply.content.slice(0, 80)}`);

  let docText = "";
  try {
    docText = await fetchDocAsText(docId);
  } catch {}

  // Include the full thread context in the prompt
  const threadContext = `Original comment from ${comment.author}: "${comment.content}"\nFollow-up from ${reply.author}: "${reply.content}"`;
  const draft = await draftFollowUp(docTitle, threadContext, docText);

  let replyId: string | null = null;
  try {
    replyId = await postCommentReply(docId, comment.id, draft);
    console.log(`Posted follow-up reply to doc (replyId: ${replyId})`);
  } catch (err) {
    console.error("Failed to post follow-up reply to doc:", err);
  }

  const { data: task } = await sb
    .from("async_tasks")
    .insert({
      chat_id: CHAT_ID,
      original_prompt: `Follow-up reply in "${docTitle}"`,
      status: "needs_input",
      metadata: {
        type: "docs_comment",
        docId,
        docTitle,
        commentId: comment.id,
        commentAuthor: reply.author,
        commentText: reply.content,
        draft,
        replyId,
      },
    })
    .select()
    .single();

  if (!task) {
    console.error("Failed to create async task for reply");
    return;
  }

  const postedNote = replyId
    ? `_Draft posted to doc\\. Reply here to update it in the doc\\._`
    : `_Could not post to doc — reply here to set a draft\\._`;

  const msgText =
    `📄 Follow\\-up in *${escapeMarkdown(docTitle)}*\n` +
    `From: ${escapeMarkdown(reply.author)}\n\n` +
    `> ${escapeMarkdown(reply.content)}\n\n` +
    `*Drafted reply:*\n${escapeMarkdown(draft)}\n\n` +
    `${postedNote}\n` +
    `\`/skip ${task.id}\` to delete from doc`;

  const sentMsg = await sendMessage(msgText);

  if (sentMsg?.message_id) {
    await sb
      .from("async_tasks")
      .update({ metadata: { ...task.metadata, telegramMessageId: sentMsg.message_id } })
      .eq("id", task.id);
  }

  // Mark the user's reply and the bot's reply as processed
  const inserts: any[] = [{ comment_id: reply.id, doc_id: docId, task_id: String(task.id) }];
  if (replyId) inserts.push({ comment_id: replyId, doc_id: docId, task_id: String(task.id) });
  await sb.from("processed_comments").insert(inserts);
}

async function callClaude(prompt: string): Promise<string> {
  const { runClaudeWithTimeout } = await import("./lib/claude");
  // Pass empty MCP config + --strict-mcp-config to skip MCP server initialization,
  // which otherwise takes 60-180s and causes timeouts in background scripts.
  const result = await runClaudeWithTimeout(prompt, 60_000, {
    extraArgs: ["--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config"],
  });
  return result?.trim() || "";
}

async function draftFollowUp(
  docTitle: string,
  threadContext: string,
  docText: string
): Promise<string> {
  try {
    const contextSection = docText
      ? `\n\nDocument content:\n<doc>\n${docText.slice(0, 6000)}\n</doc>`
      : "";
    const prompt =
      `You are a helpful AI assistant for Alvin Toh. Draft a concise, professional reply to the following follow-up question in a Google Doc comment thread.${contextSection}\n\n` +
      `Document: "${docTitle}"\n` +
      `${threadContext}\n\n` +
      `Write only the reply text, no preamble. Be helpful and specific.`;
    const result = await callClaude(prompt);
    return result || "(Draft unavailable — write your reply above)";
  } catch (err) {
    console.error("Draft follow-up failed:", err);
    return "(Draft unavailable — write your reply above)";
  }
}

async function draftReply(
  docTitle: string,
  comment: DocComment,
  docText: string
): Promise<string> {
  try {
    const contextSection = docText
      ? `\n\nDocument content:\n<doc>\n${docText.slice(0, 6000)}\n</doc>`
      : "";
    const prompt =
      `You are a helpful AI assistant for Alvin Toh. Draft a concise, professional reply to the following comment left in a Google Doc.${contextSection}\n\n` +
      `Document: "${docTitle}"\n` +
      `Comment from ${comment.author}: "${comment.content}"\n\n` +
      `Write only the reply text, no preamble. Be helpful and specific.`;
    const result = await callClaude(prompt);
    return result || "(Draft unavailable — write your reply above)";
  } catch (err) {
    console.error("Draft reply failed:", err);
    return "(Draft unavailable — write your reply above)";
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
