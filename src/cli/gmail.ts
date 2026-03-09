#!/usr/bin/env bun
/**
 * Gmail CLI
 *
 * Usage:
 *   bun src/cli/gmail.ts unread
 *   bun src/cli/gmail.ts search "<query>"
 *   bun src/cli/gmail.ts get <messageId>
 *   bun src/cli/gmail.ts send "<to>" "<subject>" "<body>"
 *   bun src/cli/gmail.ts draft "<to>" "<subject>" "<body>"
 */

import { init, getToken, output, error, run } from "./_google";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function fetchSubjects(token: string, messageIds: string[]): Promise<Array<{ id: string; from: string; subject: string; date: string }>> {
  return Promise.all(
    messageIds.map(async (id) => {
      try {
        const res = await fetch(
          `${BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) return { id, from: "", subject: "(error)", date: "" };
        const msg = await res.json();
        const headers = msg.payload?.headers || [];
        const subject = headers.find((h: any) => h.name === "Subject")?.value || "(no subject)";
        const from = headers.find((h: any) => h.name === "From")?.value || "";
        const date = headers.find((h: any) => h.name === "Date")?.value || "";
        const fromName = from.replace(/<.*>/, "").trim() || from;
        return { id, from: fromName, subject, date };
      } catch {
        return { id, from: "", subject: "(error)", date: "" };
      }
    })
  );
}

async function unread(): Promise<void> {
  const token = await getToken();

  const res = await fetch(`${BASE}/messages?q=is:unread+in:inbox&maxResults=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) error(`Gmail API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const total = data.resultSizeEstimate || 0;
  const ids = data.messages?.map((m: any) => m.id).slice(0, 10) || [];

  if (total === 0) {
    output({ total: 0, messages: [] });
    return;
  }

  const messages = await fetchSubjects(token, ids);
  output({ total, messages });
}

async function search(query: string): Promise<void> {
  const token = await getToken();

  const res = await fetch(`${BASE}/messages?q=${encodeURIComponent(query)}&maxResults=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) error(`Gmail API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const total = data.resultSizeEstimate || 0;
  const ids = data.messages?.map((m: any) => m.id).slice(0, 20) || [];

  if (total === 0) {
    output({ total: 0, messages: [] });
    return;
  }

  const messages = await fetchSubjects(token, ids);
  output({ total, messages });
}

async function getMessage(messageId: string): Promise<void> {
  const token = await getToken();

  const res = await fetch(`${BASE}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) error(`Gmail API ${res.status}: ${await res.text()}`);

  const msg = await res.json();
  const headers = msg.payload?.headers || [];
  const subject = headers.find((h: any) => h.name === "Subject")?.value || "";
  const from = headers.find((h: any) => h.name === "From")?.value || "";
  const to = headers.find((h: any) => h.name === "To")?.value || "";
  const date = headers.find((h: any) => h.name === "Date")?.value || "";

  // Extract body text
  let body = "";
  function extractText(part: any): void {
    if (part.mimeType === "text/plain" && part.body?.data) {
      body += Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    if (part.parts) part.parts.forEach(extractText);
  }
  extractText(msg.payload);

  // Fallback to snippet if no text/plain
  if (!body) body = msg.snippet || "";

  output({ id: msg.id, threadId: msg.threadId, from, to, subject, date, body: body.substring(0, 5000), labels: msg.labelIds });
}

function buildMime(to: string, subject: string, body: string): string {
  return [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
}

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const token = await getToken();
  const raw = Buffer.from(buildMime(to, subject, body)).toString("base64url");

  const res = await fetch(`${BASE}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) error(`Gmail API ${res.status}: ${await res.text()}`);

  const msg = await res.json();
  output({ id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds });
}

async function createDraft(to: string, subject: string, body: string): Promise<void> {
  const token = await getToken();
  const raw = Buffer.from(buildMime(to, subject, body)).toString("base64url");

  const res = await fetch(`${BASE}/drafts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
  });

  if (!res.ok) error(`Gmail API ${res.status}: ${await res.text()}`);

  const draft = await res.json();
  output({ draftId: draft.id, messageId: draft.message?.id });
}

// --- Main ---
run(async () => {
  await init();
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "unread":
      await unread();
      break;
    case "search":
      if (!args[0]) error("Usage: search <query>");
      await search(args[0]);
      break;
    case "get":
      if (!args[0]) error("Usage: get <messageId>");
      await getMessage(args[0]);
      break;
    case "send":
      if (args.length < 3) error("Usage: send <to> <subject> <body>");
      await sendEmail(args[0], args[1], args[2]);
      break;
    case "draft":
      if (args.length < 3) error("Usage: draft <to> <subject> <body>");
      await createDraft(args[0], args[1], args[2]);
      break;
    default:
      error(`Unknown command: ${cmd || "(none)"}. Available: unread, search, get, send, draft`);
  }
});
