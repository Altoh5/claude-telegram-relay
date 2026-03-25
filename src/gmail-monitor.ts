/**
 * Gmail Monitor
 *
 * Polls two Gmail inboxes every 30 minutes. Classifies emails and
 * triggers appropriate flows via Telegram.
 *
 * Run manually: bun run src/gmail-monitor.ts [--force]
 * Scheduled: launchd com.go.gmail-monitor every 30 min
 */

import { loadEnv } from "./lib/env";
import { getGoogleAccessToken } from "./lib/data-sources/google-auth";
import { getBotAccessToken } from "./lib/google-bot-auth";
import { getConvex, api } from "./lib/convex";
import {
  classifyEmail,
  isNccSender,
  extractReceiptDetails,
  extractAppointmentDetails,
  extractActionableDetails,
  extractPaymentDetails,
  extractSermonDetails,
} from "./lib/gmail-classifier";
import { startReceiptFlow } from "./lib/flows/receipt";
import { triggerActionableFlow } from "./lib/flows/actionable";
import { triggerPaymentReminderFlow } from "./lib/flows/payment-reminder";
import { createCalendarEvent } from "./lib/flows/appointment";
import { sendTelegramMessage } from "./lib/telegram";
import { createTask, updateTask } from "./lib/supabase";
import { spawnSync } from "child_process";

await loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_USER_ID || "";
const SERMONS_NLM_NOTEBOOK_ID = process.env.SERMONS_NLM_NOTEBOOK_ID || "";
const FORCE = process.argv.includes("--force");

const INBOXES = [
  { id: "si" as const, label: "SI", getToken: getGoogleAccessToken },
  { id: "tool" as const, label: "Tool", getToken: getBotAccessToken },
] as const;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// Gmail REST helpers
// ────────────────────────────────────────────────────────────────

async function fetchNewMessages(token: string, sinceMs: number): Promise<string[]> {
  const sinceSeconds = Math.floor(sinceMs / 1000);
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread+after:${sinceSeconds}&maxResults=20`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail list error: ${res.status}`);
  const data = await res.json();
  return (data.messages || []).map((m: any) => m.id as string);
}

async function fetchMessageDetails(token: string, messageId: string): Promise<{
  subject: string; sender: string; snippet: string; body: string;
} | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const msg = await res.json();

  const headers = msg.payload?.headers || [];
  const subject = headers.find((h: any) => h.name === "Subject")?.value || "(no subject)";
  const sender = headers.find((h: any) => h.name === "From")?.value || "";
  const snippet = msg.snippet || "";

  // Extract plain text body
  let body = "";
  const parts = msg.payload?.parts || [msg.payload];
  for (const part of parts) {
    if (part?.mimeType === "text/plain" && part?.body?.data) {
      body = Buffer.from(part.body.data, "base64").toString("utf-8");
      break;
    }
  }
  if (!body) body = snippet;

  return { subject, sender, snippet, body };
}

async function markAsRead(token: string, messageId: string): Promise<void> {
  await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    }
  );
}

// ────────────────────────────────────────────────────────────────
// Per-email routing
// ────────────────────────────────────────────────────────────────

async function processEmail(opts: {
  inboxId: "si" | "tool";
  messageId: string;
  subject: string;
  sender: string;
  snippet: string;
  body: string;
}): Promise<void> {
  const { inboxId, messageId, subject, sender, snippet, body } = opts;

  // NCC filter for tool inbox
  if (inboxId === "tool" && !isNccSender(sender)) return;

  const category = await classifyEmail({ subject, sender, snippet });
  console.log(`  [${inboxId}] ${subject} → ${category}`);

  if (category === "ignore" || category === "ncc_sermon_notify") return;

  if (category === "receipt") {
    const details = await extractReceiptDetails(subject, body);
    await startReceiptFlow({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      vendor: details.vendor,
      amount: details.amount,
      currency: details.currency,
      date: details.date,
    });
    return;
  }

  if (category === "appointment" || category === "ncc_meeting") {
    const details = await extractAppointmentDetails(subject, body);
    const task = await createTask(CHAT_ID, `Calendar: ${details.title}`);
    if (!task) {
      console.error("  Failed to create async_tasks row for appointment — skipping");
      return;
    }
    await updateTask(task.id, {
      status: "pending",
      metadata: { type: "email_calendar", appointment_details: details, source_email_id: messageId },
    });

    const dateStr = details.date && details.start_time
      ? `${details.date} ${details.start_time}${details.end_time ? "–" + details.end_time : ""}`
      : "(date not extracted)";
    const locationStr = details.location ? ` at ${details.location}` : "";

    const buttons = [
      [
        { text: "Add to Calendar", callback_data: `gm:cal:${task.id}` },
        { text: "Skip", callback_data: `gm:skip:${task.id}` },
      ],
    ];

    await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
      `📅 *${details.title}*\n${dateStr}${locationStr}\n\nAdd to calendar?`,
      { parseMode: "Markdown", buttons }
    );
    return;
  }

  if (category === "actionable") {
    const details = await extractActionableDetails(subject, sender, body);
    await triggerActionableFlow({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      subject,
      senderName: details.sender_name,
      summary: details.summary,
      messageId,
    });
    return;
  }

  if (category === "payment_reminder") {
    const details = await extractPaymentDetails(subject, body);
    await triggerPaymentReminderFlow({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      service: details.service,
      amount: details.amount,
      currency: details.currency,
      dueDate: details.due_date,
      messageId,
    });
    return;
  }

  if (category === "ncc_sermon_content" && SERMONS_NLM_NOTEBOOK_ID) {
    const { title, body: sermonBody } = await extractSermonDetails(subject, body);
    try {
      // Use spawnSync with args array to avoid shell injection on sermon content
      const result = spawnSync(
        "nlm",
        ["source", "add", "--notebook", SERMONS_NLM_NOTEBOOK_ID, "--text", sermonBody],
        { timeout: 60000, encoding: "utf-8" }
      );
      if (result.status !== 0) throw new Error(result.stderr || "nlm exited with non-zero status");
      await sendTelegramMessage(BOT_TOKEN, CHAT_ID, `📖 Sermon notes added to NotebookLM: _${title}_`, { parseMode: "Markdown" });
    } catch (err) {
      await sendTelegramMessage(BOT_TOKEN, CHAT_ID, `⚠️ Failed to add sermon to NotebookLM: ${err}`);
    }
    return;
  }
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log("Gmail Monitor starting...");
  const cx = getConvex();
  if (!cx) { console.error("CONVEX_URL not set"); process.exit(1); }
  if (!BOT_TOKEN || !CHAT_ID) { console.error("TELEGRAM_BOT_TOKEN or CHAT_ID not set"); process.exit(1); }

  let totalProcessed = 0;

  for (const inbox of INBOXES) {
    console.log(`\n[${inbox.label}] Checking inbox...`);
    try {
      const token = await inbox.getToken();
      const lastRun = await cx.query(api.gmailMonitor.getLastRun, { inbox: inbox.id });
      const since = FORCE ? Date.now() - SEVEN_DAYS_MS : (lastRun ?? Date.now() - SEVEN_DAYS_MS);

      const messageIds = await fetchNewMessages(token, since);
      console.log(`  Found ${messageIds.length} new message(s) since ${new Date(since).toISOString()}`);

      for (const messageId of messageIds) {
        const alreadyDone = await cx.query(api.gmailMonitor.isProcessed, { message_id: messageId });
        if (alreadyDone) { console.log(`  Skipping ${messageId} (already processed)`); continue; }

        const details = await fetchMessageDetails(token, messageId);
        if (!details) continue;

        try {
          await processEmail({ inboxId: inbox.id, messageId, ...details });
          totalProcessed++;
        } catch (err) {
          console.error(`  Error processing ${messageId}: ${err}`);
        }

        await cx.mutation(api.gmailMonitor.markProcessed, { message_id: messageId, classified_as: "processed" });
        await markAsRead(token, messageId);
      }

      await cx.mutation(api.gmailMonitor.setLastRun, { inbox: inbox.id, timestamp: Date.now() });
    } catch (err) {
      console.error(`[${inbox.label}] Inbox error: ${err}`);
    }
  }

  console.log(`\nDone. Processed ${totalProcessed} email(s).`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
