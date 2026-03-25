import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type EmailCategory =
  | "receipt"
  | "ncc_meeting"
  | "ncc_sermon_content"
  | "ncc_sermon_notify"
  | "payment_reminder"
  | "appointment"
  | "actionable"
  | "ignore";

const VALID_CATEGORIES = new Set<EmailCategory>([
  "receipt", "ncc_meeting", "ncc_sermon_content", "ncc_sermon_notify",
  "payment_reminder", "appointment", "actionable", "ignore",
]);

export interface EmailMeta {
  subject: string;
  sender: string;
  snippet: string;
}

export interface ReceiptDetails {
  vendor: string; amount: number; currency: string; date: string;
}
export interface AppointmentDetails {
  title: string; date: string; start_time: string; end_time: string;
  location: string; attendees: string[];
}
export interface ActionableDetails {
  summary: string; sender_name: string;
}
export interface PaymentDetails {
  service: string; amount: number; currency: string; due_date: string;
}
export interface SermonDetails {
  title: string; body: string;
}

export function isNccSender(sender: string): boolean {
  const lower = sender.toLowerCase();
  return lower.includes("newcreation") || lower.includes("ncc") || lower.includes("noah");
}

export async function classifyEmail(meta: EmailMeta): Promise<EmailCategory> {
  const prompt = `Classify this email into exactly one category. Reply with ONLY the category name.

Priority order (use the first that matches):
1. receipt — purchase confirmation, expense, payment received
2. ncc_meeting — sender is New Creation Church or Noah, contains a meeting/event date
3. ncc_sermon_content — sender is New Creation Church or Noah, contains sermon notes/transcript/slides
4. ncc_sermon_notify — sender is New Creation Church or Noah, notifies of a sermon but has no content
5. payment_reminder — subscription renewal, payment due, overdue invoice
6. appointment — calendar invite, meeting request with date/time
7. actionable — requires a response, decision, or follow-up
8. ignore — newsletter, marketing, FYI, no action needed

Subject: ${meta.subject}
From: ${meta.sender}
Snippet: ${meta.snippet}`;

  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 20,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (res.content[0] as any).text.trim().toLowerCase() as EmailCategory;
  return VALID_CATEGORIES.has(raw) ? raw : "ignore";
}

export async function extractReceiptDetails(subject: string, body: string): Promise<ReceiptDetails> {
  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: `Extract receipt details as JSON. Reply with ONLY valid JSON, no markdown.\n\nEmail subject: ${subject}\nEmail body:\n${body.slice(0, 2000)}\n\nSchema: {"vendor":"","amount":0,"currency":"SGD","date":""}`,
    }],
  });
  try {
    return JSON.parse((res.content[0] as any).text.trim());
  } catch {
    return { vendor: subject, amount: 0, currency: "SGD", date: new Date().toISOString().slice(0, 10) };
  }
}

export async function extractAppointmentDetails(subject: string, body: string): Promise<AppointmentDetails> {
  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `Extract appointment details as JSON. Reply with ONLY valid JSON, no markdown.\n\nEmail subject: ${subject}\nEmail body:\n${body.slice(0, 2000)}\n\nSchema: {"title":"","date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM","location":"","attendees":[]}`,
    }],
  });
  try {
    return JSON.parse((res.content[0] as any).text.trim());
  } catch {
    return { title: subject, date: "", start_time: "", end_time: "", location: "", attendees: [] };
  }
}

export async function extractActionableDetails(subject: string, sender: string, body: string): Promise<ActionableDetails> {
  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 150,
    messages: [{
      role: "user",
      content: `Summarise why this email needs action in one sentence. Reply with ONLY valid JSON, no markdown.\n\nFrom: ${sender}\nSubject: ${subject}\nSnippet: ${body.slice(0, 500)}\n\nSchema: {"summary":"","sender_name":""}`,
    }],
  });
  try {
    return JSON.parse((res.content[0] as any).text.trim());
  } catch {
    return { summary: subject, sender_name: sender.split("<")[0].trim() };
  }
}

export async function extractPaymentDetails(subject: string, body: string): Promise<PaymentDetails> {
  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 150,
    messages: [{
      role: "user",
      content: `Extract payment reminder details as JSON. Reply with ONLY valid JSON, no markdown.\n\nEmail subject: ${subject}\nEmail body:\n${body.slice(0, 1000)}\n\nSchema: {"service":"","amount":0,"currency":"SGD","due_date":"YYYY-MM-DD"}`,
    }],
  });
  try {
    return JSON.parse((res.content[0] as any).text.trim());
  } catch {
    return { service: subject, amount: 0, currency: "SGD", due_date: "" };
  }
}

// Sermon body is used verbatim — no extraction needed, the full content goes to NotebookLM
export async function extractSermonDetails(subject: string, body: string): Promise<SermonDetails> {
  return { title: subject, body: body.slice(0, 10000) };
}
