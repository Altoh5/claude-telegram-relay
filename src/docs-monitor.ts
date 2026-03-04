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
  updateCommentReply,
  appendToDoc,
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

  // Apply doc body edit if Claude produced one
  let docEdited = false;
  if (draft.docEdit) {
    try {
      await appendToDoc(docId, draft.docEdit);
      docEdited = true;
      console.log(`Appended doc edit (${draft.docEdit.length} chars)`);
    } catch (err) {
      console.error("Failed to apply doc edit:", err);
    }
  }

  // Post reply to the comment thread
  let replyId: string | null = null;
  try {
    replyId = await postCommentReply(docId, comment.id, draft.reply);
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
        draft: draft.reply,
        docEdit: draft.docEdit,
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

  const editNote = docEdited ? `\n✏️ _Doc body updated_` : "";

  const msgText =
    `📄 New comment in *${escapeMarkdown(docTitle)}*\n` +
    `From: ${escapeMarkdown(comment.author)}\n\n` +
    `> ${escapeMarkdown(comment.content)}\n\n` +
    `*Drafted reply:*\n${escapeMarkdown(draft.reply)}\n\n` +
    `${postedNote}${editNote}\n` +
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

  // Apply doc body edit if Claude produced one
  let docEdited = false;
  if (draft.docEdit) {
    try {
      await appendToDoc(docId, draft.docEdit);
      docEdited = true;
      console.log(`Appended doc edit (${draft.docEdit.length} chars)`);
    } catch (err) {
      console.error("Failed to apply doc edit:", err);
    }
  }

  let replyId: string | null = null;
  try {
    replyId = await postCommentReply(docId, comment.id, draft.reply);
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
        draft: draft.reply,
        docEdit: draft.docEdit,
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

  const editNote = docEdited ? `\n✏️ _Doc body updated_` : "";

  const msgText =
    `📄 Follow\\-up in *${escapeMarkdown(docTitle)}*\n` +
    `From: ${escapeMarkdown(reply.author)}\n\n` +
    `> ${escapeMarkdown(reply.content)}\n\n` +
    `*Drafted reply:*\n${escapeMarkdown(draft.reply)}\n\n` +
    `${postedNote}${editNote}\n` +
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
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const model = process.env.OPENROUTER_MODEL || "moonshotai/kimi-k2.5";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://go-telegram-bot.local",
        "X-Title": "Go Telegram Bot",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API failed (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    const msg = data.choices?.[0]?.message;
    return ((msg?.content || msg?.reasoning || "") as string).trim();
  } finally {
    clearTimeout(timeout);
  }
}

interface DraftResult {
  reply: string;
  docEdit: string | null;
}

function parseDraftResult(raw: string): DraftResult {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      reply: parsed.reply || "(Draft unavailable — write your reply above)",
      docEdit: parsed.docEdit || null,
    };
  } catch {
    // Fallback: treat entire output as a reply with no doc edit
    return { reply: raw || "(Draft unavailable — write your reply above)", docEdit: null };
  }
}

async function draftFollowUp(
  docTitle: string,
  threadContext: string,
  docText: string
): Promise<DraftResult> {
  try {
    const contextSection = docText
      ? `\n\nDocument content:\n<doc>\n${docText.slice(0, 6000)}\n</doc>`
      : "";
    const prompt =
      `You are a helpful AI assistant for Alvin Toh. Handle the following follow-up in a Google Doc comment thread.${contextSection}\n\n` +
      `Document: "${docTitle}"\n` +
      `${threadContext}\n\n` +
      `Respond with a JSON object (no markdown fences) with two fields:\n` +
      `- "reply": A concise, professional reply to post in the comment thread.\n` +
      `- "docEdit": If the comment asks you to add, write, or change content in the document body, provide the text to append to the document. Otherwise null.\n\n` +
      `Example: {"reply": "Done — added a conclusion section.", "docEdit": "## Conclusion\\n\\nIn summary..."}\n` +
      `Example: {"reply": "Great point, I'll look into that.", "docEdit": null}`;
    const result = await callClaude(prompt);
    return parseDraftResult(result);
  } catch (err) {
    console.error("Draft follow-up failed:", err);
    return { reply: "(Draft unavailable — write your reply above)", docEdit: null };
  }
}

async function draftReply(
  docTitle: string,
  comment: DocComment,
  docText: string
): Promise<DraftResult> {
  try {
    const contextSection = docText
      ? `\n\nDocument content:\n<doc>\n${docText.slice(0, 6000)}\n</doc>`
      : "";
    const prompt =
      `You are a helpful AI assistant for Alvin Toh. Handle the following comment left in a Google Doc.${contextSection}\n\n` +
      `Document: "${docTitle}"\n` +
      `Comment from ${comment.author}: "${comment.content}"\n\n` +
      `Respond with a JSON object (no markdown fences) with two fields:\n` +
      `- "reply": A concise, professional reply to post in the comment thread.\n` +
      `- "docEdit": If the comment asks you to add, write, or change content in the document body, provide the text to append to the document. Otherwise null.\n\n` +
      `Example: {"reply": "Done — added the requested section.", "docEdit": "## New Section\\n\\nContent here..."}\n` +
      `Example: {"reply": "Thanks for the feedback!", "docEdit": null}`;
    const result = await callClaude(prompt);
    return parseDraftResult(result);
  } catch (err) {
    console.error("Draft reply failed:", err);
    return { reply: "(Draft unavailable — write your reply above)", docEdit: null };
  }
}

function escapeMarkdown(text: string | undefined | null): string {
  if (!text) return "";
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
