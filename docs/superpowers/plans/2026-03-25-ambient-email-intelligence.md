# Ambient Email & Receipt Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monitor two Gmail inboxes every 30 minutes, classify incoming emails and photos into actionable flows (receipt, appointment, actionable, NCC sermon, payment reminder), and surface them to the user via Telegram with inline buttons.

**Architecture:** A new background service `gmail-monitor.ts` polls both inboxes using Gmail REST API (not MCP), runs a two-pass Haiku→Sonnet classifier, and routes to flow modules. Photo classification is injected into the existing `handlePhotoMessage` function after vision description is computed, before the generic Claude call. All new callbacks are handled in the existing `handleCallbackQuery` in `bot.ts`.

**Tech Stack:** Bun, Grammy (Telegram), Convex (state tracking), Supabase (async_tasks), Gmail REST API, Google Calendar REST API, Google Maps Places API, Anthropic API (Haiku + Sonnet), NotebookLM CLI (`nlm`), Firecrawl CLI, launchd (macOS scheduler)

**Spec:** `docs/superpowers/specs/2026-03-25-ambient-email-intelligence-design.md`

---

## File Map

### New Files
| File | Responsibility |
|---|---|
| `convex/gmailMonitor.ts` | Convex functions: last-run timestamps + processed message IDs |
| `src/lib/gmail-classifier.ts` | Pass 1 (Haiku classify) + Pass 2 (Sonnet extract) for emails |
| `src/lib/flows/receipt.ts` | Receipt flow — works for both email and photo triggers |
| `src/lib/flows/appointment.ts` | Appointment + NCC meeting flow with Google Calendar REST |
| `src/lib/flows/actionable.ts` | Actionable email flow |
| `src/lib/flows/payment-reminder.ts` | Payment reminder flow |
| `src/lib/flows/photo-classifier.ts` | Photo Pass 1 + food/place (Maps API) + product (Firecrawl) flows |
| `src/gmail-monitor.ts` | Background service — orchestrates both inboxes |
| `launchd/com.go.gmail-monitor.plist.template` | launchd schedule template (30-min intervals) |

### Modified Files
| File | Change |
|---|---|
| `convex/schema.ts` | Add `gmailMonitor` and `gmailProcessed` tables |
| `src/bot.ts` | (1) Inject photo classifier into `handlePhotoMessage`. (2) Add new callback handlers for `gm:` and `ph:` prefixes |
| `.env.example` | Add `SERMONS_NLM_NOTEBOOK_ID`, `GOOGLE_MAPS_API_KEY` |

---

## Task 1: Convex Schema + Functions

**Files:**
- Modify: `convex/schema.ts`
- Create: `convex/gmailMonitor.ts`

- [ ] **Step 1: Add tables to schema.ts**

Open `convex/schema.ts` and add inside the `defineSchema({...})` call:

```typescript
gmailMonitor: defineTable({
  inbox: v.string(),     // "si" | "tool"
  last_run: v.number(),  // unix ms
}).index("by_inbox", ["inbox"]),

gmailProcessed: defineTable({
  message_id: v.string(),
  classified_as: v.string(),
  processed_at: v.number(),
}).index("by_message_id", ["message_id"]),
```

- [ ] **Step 2: Create convex/gmailMonitor.ts**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const getLastRun = query({
  args: { inbox: v.string() },
  handler: async (ctx, { inbox }) => {
    const row = await ctx.db
      .query("gmailMonitor")
      .withIndex("by_inbox", (q) => q.eq("inbox", inbox))
      .first();
    return row?.last_run ?? null;
  },
});

export const setLastRun = mutation({
  args: { inbox: v.string(), timestamp: v.number() },
  handler: async (ctx, { inbox, timestamp }) => {
    const existing = await ctx.db
      .query("gmailMonitor")
      .withIndex("by_inbox", (q) => q.eq("inbox", inbox))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { last_run: timestamp });
    } else {
      await ctx.db.insert("gmailMonitor", { inbox, last_run: timestamp });
    }
  },
});

export const isProcessed = query({
  args: { message_id: v.string() },
  handler: async (ctx, { message_id }) => {
    const row = await ctx.db
      .query("gmailProcessed")
      .withIndex("by_message_id", (q) => q.eq("message_id", message_id))
      .first();
    return row !== null;
  },
});

export const markProcessed = mutation({
  args: { message_id: v.string(), classified_as: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("gmailProcessed", {
      ...args,
      processed_at: Date.now(),
    });
  },
});
```

- [ ] **Step 3: Deploy to Convex dev**

```bash
cd ~/claudeprojects/claude-telegram-relay
npx convex dev --once
```

Expected: `✔ Convex functions ready!` with no schema errors.

- [ ] **Step 4: Smoke-test the functions**

```bash
npx convex run gmailMonitor:getLastRun '{"inbox":"si"}'
# Expected: null

npx convex run gmailMonitor:setLastRun '{"inbox":"si","timestamp":1700000000000}'
npx convex run gmailMonitor:getLastRun '{"inbox":"si"}'
# Expected: 1700000000000

npx convex run gmailMonitor:isProcessed '{"message_id":"test123"}'
# Expected: false
```

- [ ] **Step 5: Commit**

```bash
git add convex/schema.ts convex/gmailMonitor.ts
git commit -m "feat: add gmailMonitor + gmailProcessed Convex tables"
```

---

## Task 2: Gmail Classifier (Pass 1 + Pass 2)

**Files:**
- Create: `src/lib/gmail-classifier.ts`
- Create: `src/lib/gmail-classifier.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/gmail-classifier.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";

// We mock the Anthropic call so tests don't cost tokens
const mockAnthropicCreate = mock(async (args: any) => ({
  content: [{ type: "text", text: "receipt" }],
}));

mock.module("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockAnthropicCreate };
  },
}));

const { classifyEmail, extractEmailDetails } = await import("./gmail-classifier");

describe("classifyEmail", () => {
  it("returns classification from Haiku response", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "receipt" }],
    });
    const result = await classifyEmail({
      subject: "Your receipt from Grab",
      sender: "receipts@grab.com",
      snippet: "SGD 12.50 charged on 24 Mar",
    });
    expect(result).toBe("receipt");
  });

  it("returns ignore for unrecognised response", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "unknown_garbage" }],
    });
    const result = await classifyEmail({
      subject: "Weekly digest",
      sender: "newsletter@example.com",
      snippet: "Top stories this week",
    });
    expect(result).toBe("ignore");
  });
});

describe("isNccSender", () => {
  it("matches New Creation Church domain", async () => {
    const { isNccSender } = await import("./gmail-classifier");
    expect(isNccSender("announcements@newcreation.org.sg")).toBe(true);
    expect(isNccSender("Noah <noah@ncc.org.sg>")).toBe(true);
    expect(isNccSender("random@gmail.com")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/lib/gmail-classifier.test.ts
```

Expected: error — `gmail-classifier` not found.

- [ ] **Step 3: Implement gmail-classifier.ts**

Create `src/lib/gmail-classifier.ts`:

```typescript
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

export async function extractSermonDetails(subject: string, body: string): Promise<SermonDetails> {
  return { title: subject, body: body.slice(0, 10000) };
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test src/lib/gmail-classifier.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gmail-classifier.ts src/lib/gmail-classifier.test.ts
git commit -m "feat: add email classifier — Pass 1 (Haiku) + Pass 2 (Sonnet)"
```

---

## Task 3: Receipt Flow

**Files:**
- Create: `src/lib/flows/receipt.ts`
- Create: `src/lib/flows/receipt.test.ts`

The receipt flow is shared between email and photo triggers. It creates an `async_tasks` HITL entry, waits for the user's reply, formats the expense, and sends a forward-ready message.

- [ ] **Step 1: Write failing tests**

Create `src/lib/flows/receipt.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";

const mockSendTelegram = mock(async () => ({ ok: true, result: { message_id: 1 } }));
mock.module("../telegram", () => ({ sendTelegramMessage: mockSendTelegram }));

const mockCreateTask = mock(async () => ({ id: "task-1" }));
const mockUpdateTask = mock(async () => true);
mock.module("../supabase", () => ({
  createTask: mockCreateTask,
  updateTask: mockUpdateTask,
}));

const { formatExpenseMessage, buildReceiptForwardText } = await import("./receipt");

describe("formatExpenseMessage", () => {
  it("formats expense with all fields", () => {
    const result = formatExpenseMessage({
      vendor: "Grab",
      amount: 12.5,
      currency: "SGD",
      date: "2026-03-24",
      purpose: "Client lunch",
      with_person: "Rishi",
    });
    expect(result).toContain("[Expense]");
    expect(result).toContain("SGD 12.50");
    expect(result).toContain("Grab");
    expect(result).toContain("Client lunch");
    expect(result).toContain("Rishi");
  });
});

describe("buildReceiptForwardText", () => {
  it("includes image path marker when photo-triggered", () => {
    const result = buildReceiptForwardText({
      vendor: "FairPrice", amount: 23.4, currency: "SGD",
      date: "2026-03-24", purpose: "Groceries", with_person: "self",
    }, "/tmp/photo.jpg");
    expect(result).toContain("[Photo attached]");
  });

  it("omits image marker for email-triggered receipts", () => {
    const result = buildReceiptForwardText({
      vendor: "Grab", amount: 5, currency: "SGD",
      date: "2026-03-24", purpose: "Ride", with_person: "self",
    });
    expect(result).not.toContain("[Photo attached]");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/lib/flows/receipt.test.ts
```

Expected: error — `receipt` module not found.

- [ ] **Step 3: Create src/lib/flows/receipt.ts**

```typescript
import { sendTelegramMessage } from "../telegram";
import { createTask, updateTask } from "../supabase";

export interface ReceiptData {
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  purpose?: string;
  with_person?: string;
}

export function formatExpenseMessage(data: ReceiptData & { purpose: string; with_person: string }): string {
  const amt = `${data.currency} ${data.amount.toFixed(2)}`;
  return `[Expense] ${amt} — ${data.vendor} | For: ${data.purpose} | With: ${data.with_person} | Date: ${data.date}`;
}

export function buildReceiptForwardText(
  data: ReceiptData & { purpose: string; with_person: string },
  imagePath?: string
): string {
  let text = formatExpenseMessage(data);
  if (imagePath) text += "\n[Photo attached]";
  return text;
}

/**
 * Initiates the receipt HITL flow.
 * Sends "Receipt detected" message and creates async_tasks row awaiting user reply.
 */
export async function startReceiptFlow(opts: {
  botToken: string;
  chatId: string;
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  imagePath?: string;
}): Promise<void> {
  const { botToken, chatId, vendor, amount, currency, date, imagePath } = opts;

  const desc = vendor
    ? `Receipt from ${vendor} (${currency} ${amount.toFixed(2)}) — what's this for, and who's it with?`
    : "Receipt detected — what's this for, and who's it with?";

  const task = await createTask(chatId, desc);
  if (!task) return;

  await updateTask(task.id, {
    status: "needs_input",
    metadata: {
      type: "receipt_pending",
      vendor,
      amount,
      currency,
      date,
      image_path: imagePath ?? null,
    },
  });

  await sendTelegramMessage(botToken, chatId, desc);
}

/**
 * Completes the receipt flow after the user has replied.
 * Called from bot.ts when a needs_input receipt_pending task exists for this chat.
 */
export async function completeReceiptFlow(opts: {
  botToken: string;
  chatId: string;
  taskId: string;
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  purpose: string;
  with_person: string;
  imagePath?: string;
}): Promise<void> {
  const { botToken, chatId, taskId, imagePath, ...data } = opts;

  const forwardText = buildReceiptForwardText(
    { ...data, purpose: data.purpose, with_person: data.with_person },
    imagePath
  );

  // Store forward_text in metadata so the ph:copy: callback can retrieve it
  await updateTask(taskId, { status: "completed", metadata: { forward_text: forwardText } });

  // Send forward-ready message with inline button (spec requires a button, not just text)
  const keyboard = {
    inline_keyboard: [[{ text: "📋 Copy Message for Honey", callback_data: `ph:copy:${taskId}` }]],
  };
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `✅ Expense logged. Tap the button to get the forward-ready text.`,
      reply_markup: keyboard,
    }),
  });
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test src/lib/flows/receipt.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/receipt.ts src/lib/flows/receipt.test.ts
git commit -m "feat: add receipt flow with HITL async_tasks support"
```

---

## Task 4: Appointment Flow

**Files:**
- Create: `src/lib/flows/appointment.ts`
- Create: `src/lib/flows/appointment.test.ts`

Uses Google Calendar REST API directly (same `GOOGLE_REFRESH_TOKEN` as gmail data source).

- [ ] **Step 1: Write failing tests**

Create `src/lib/flows/appointment.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";

mock.module("../data-sources/google-auth", () => ({
  getGoogleAccessToken: mock(async () => "fake-token"),
}));

const mockFetch = mock(async () => ({
  ok: true,
  json: async () => ({ id: "event123", htmlLink: "https://calendar.google.com/event123" }),
}));
globalThis.fetch = mockFetch as any;

const { buildCalendarEvent, createCalendarEvent } = await import("./appointment");

describe("buildCalendarEvent", () => {
  it("builds correct event body from appointment details", () => {
    const event = buildCalendarEvent({
      title: "WMI Workshop",
      date: "2026-04-02",
      start_time: "14:00",
      end_time: "15:00",
      location: "WMI Office",
      attendees: ["jason@wmi.com"],
    });
    expect(event.summary).toBe("WMI Workshop");
    expect(event.start.dateTime).toContain("2026-04-02T14:00");
    expect(event.location).toBe("WMI Office");
    expect(event.attendees).toHaveLength(1);
  });

  it("handles missing end_time by defaulting to +1 hour", () => {
    const event = buildCalendarEvent({
      title: "Meeting",
      date: "2026-04-02",
      start_time: "10:00",
      end_time: "",
      location: "",
      attendees: [],
    });
    expect(event.end.dateTime).toContain("11:00");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/lib/flows/appointment.test.ts
```

- [ ] **Step 3: Create src/lib/flows/appointment.ts**

```typescript
import { getGoogleAccessToken } from "../data-sources/google-auth";

export interface AppointmentDetails {
  title: string;
  date: string;        // YYYY-MM-DD
  start_time: string;  // HH:MM
  end_time: string;    // HH:MM (empty = start + 1h)
  location: string;
  attendees: string[];
}

export function buildCalendarEvent(details: AppointmentDetails) {
  const tz = process.env.USER_TIMEZONE || "Asia/Singapore";

  // If end_time is empty, default to start + 1 hour
  let endTime = details.end_time;
  if (!endTime && details.start_time) {
    const [h, m] = details.start_time.split(":").map(Number);
    endTime = `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  return {
    summary: details.title,
    location: details.location || undefined,
    start: { dateTime: `${details.date}T${details.start_time}:00`, timeZone: tz },
    end: { dateTime: `${details.date}T${endTime}:00`, timeZone: tz },
    attendees: details.attendees.map((email) => ({ email })),
  };
}

export async function createCalendarEvent(details: AppointmentDetails): Promise<string> {
  const token = await getGoogleAccessToken();
  const event = buildCalendarEvent(details);

  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Calendar API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.htmlLink ?? "";
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test src/lib/flows/appointment.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/appointment.ts src/lib/flows/appointment.test.ts
git commit -m "feat: add appointment flow with Google Calendar REST"
```

---

## Task 5: Actionable + Payment Reminder Flows

**Files:**
- Create: `src/lib/flows/actionable.ts`
- Create: `src/lib/flows/actionable.test.ts`
- Create: `src/lib/flows/payment-reminder.ts`
- Create: `src/lib/flows/payment-reminder.test.ts`

Both flows just format a Telegram message and create an `async_tasks` entry — no external API calls.

- [ ] **Step 1: Write failing tests**

Create `src/lib/flows/actionable.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockCreateTask = mock(async () => ({ id: "task-abc" }));
const mockUpdateTask = mock(async () => {});
const mockSendTelegramMessage = mock(async () => {});

mock.module("../supabase", () => ({
  createTask: mockCreateTask,
  updateTask: mockUpdateTask,
}));
mock.module("../telegram", () => ({
  sendTelegramMessage: mockSendTelegramMessage,
}));

const { triggerActionableFlow } = await import("./actionable");

describe("triggerActionableFlow", () => {
  beforeEach(() => {
    mockCreateTask.mockClear();
    mockUpdateTask.mockClear();
    mockSendTelegramMessage.mockClear();
  });

  it("creates a task with correct metadata", async () => {
    await triggerActionableFlow({
      botToken: "tok",
      chatId: "123",
      subject: "Budget approval",
      senderName: "Rishi",
      summary: "Approve Q2 budget SGD 4200",
      messageId: "msg-1",
    });
    expect(mockCreateTask).toHaveBeenCalledWith("123", "Email action: Budget approval");
    expect(mockUpdateTask).toHaveBeenCalledWith("task-abc", expect.objectContaining({
      status: "pending",
      metadata: expect.objectContaining({ type: "email_task", subject: "Budget approval" }),
    }));
  });

  it("sends Telegram message with Make Task / Add to Calendar / Ignore buttons", async () => {
    await triggerActionableFlow({
      botToken: "tok",
      chatId: "123",
      subject: "Test",
      senderName: "Rishi",
      summary: "A summary",
      messageId: "msg-2",
    });
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    const [, , text, opts] = mockSendTelegramMessage.mock.calls[0];
    expect(text).toContain("Rishi");
    const buttons = opts.buttons.flat().map((b: any) => b.text);
    expect(buttons).toContain("Make Task");
    expect(buttons).toContain("Add to Calendar");
    expect(buttons).toContain("Ignore");
  });

  it("returns early without sending if createTask returns null", async () => {
    mockCreateTask.mockResolvedValueOnce(null);
    await triggerActionableFlow({
      botToken: "tok", chatId: "123", subject: "X", senderName: "Y", summary: "Z", messageId: "m",
    });
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });
});
```

Create `src/lib/flows/payment-reminder.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockCreateTask = mock(async () => ({ id: "task-pay" }));
const mockUpdateTask = mock(async () => {});
const mockSendTelegramMessage = mock(async () => {});

mock.module("../supabase", () => ({
  createTask: mockCreateTask,
  updateTask: mockUpdateTask,
}));
mock.module("../telegram", () => ({
  sendTelegramMessage: mockSendTelegramMessage,
}));

const { triggerPaymentReminderFlow } = await import("./payment-reminder");

describe("triggerPaymentReminderFlow", () => {
  beforeEach(() => {
    mockCreateTask.mockClear();
    mockUpdateTask.mockClear();
    mockSendTelegramMessage.mockClear();
  });

  it("creates a task with payment metadata", async () => {
    await triggerPaymentReminderFlow({
      botToken: "tok",
      chatId: "123",
      service: "Canva Pro",
      amount: 17.9,
      currency: "SGD",
      dueDate: "2026-03-28",
      messageId: "msg-pay",
    });
    expect(mockCreateTask).toHaveBeenCalledWith("123", "Payment reminder: Canva Pro");
    expect(mockUpdateTask).toHaveBeenCalledWith("task-pay", expect.objectContaining({
      status: "pending",
      metadata: expect.objectContaining({ type: "email_task", service: "Canva Pro", amount: 17.9 }),
    }));
  });

  it("sends Telegram message with amount and due date", async () => {
    await triggerPaymentReminderFlow({
      botToken: "tok",
      chatId: "123",
      service: "Canva Pro",
      amount: 17.9,
      currency: "SGD",
      dueDate: "2026-03-28",
      messageId: "msg-pay",
    });
    const [, , text] = mockSendTelegramMessage.mock.calls[0];
    expect(text).toContain("Canva Pro");
    expect(text).toContain("17.90");
    expect(text).toContain("2026-03-28");
  });

  it("sends Make Task and Ignore buttons", async () => {
    await triggerPaymentReminderFlow({
      botToken: "tok", chatId: "123", service: "X", amount: 0, currency: "SGD", dueDate: "", messageId: "m",
    });
    const [, , , opts] = mockSendTelegramMessage.mock.calls[0];
    const buttons = opts.buttons.flat().map((b: any) => b.text);
    expect(buttons).toContain("Make Task");
    expect(buttons).toContain("Ignore");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/lib/flows/actionable.test.ts src/lib/flows/payment-reminder.test.ts
```

Expected: FAIL — `Cannot find module './actionable'` / `Cannot find module './payment-reminder'`

- [ ] **Step 3: Create src/lib/flows/actionable.ts**

```typescript
import { sendTelegramMessage } from "../telegram";
import { createTask, updateTask } from "../supabase";

export async function triggerActionableFlow(opts: {
  botToken: string;
  chatId: string;
  subject: string;
  senderName: string;
  summary: string;
  messageId: string;
}): Promise<void> {
  const { botToken, chatId, subject, senderName, summary, messageId } = opts;

  const task = await createTask(chatId, `Email action: ${subject}`);
  if (!task) return;

  await updateTask(task.id, {
    status: "pending",
    metadata: { type: "email_task", subject, sender: senderName, summary, source_email_id: messageId },
  });

  const buttons = [
    [
      { text: "Make Task", callback_data: `gm:task:${task.id}` },
      { text: "Add to Calendar", callback_data: `gm:cal:${task.id}` },
      { text: "Ignore", callback_data: `gm:ign:${task.id}` },
    ],
  ];

  const msg = `📧 *Email from ${senderName}*\n\n${summary}`;

  await sendTelegramMessage(botToken, chatId, msg, {
    parseMode: "Markdown",
    buttons,
  });
}
```

- [ ] **Step 4: Create src/lib/flows/payment-reminder.ts**

```typescript
import { sendTelegramMessage } from "../telegram";
import { createTask, updateTask } from "../supabase";

export async function triggerPaymentReminderFlow(opts: {
  botToken: string;
  chatId: string;
  service: string;
  amount: number;
  currency: string;
  dueDate: string;
  messageId: string;
}): Promise<void> {
  const { botToken, chatId, service, amount, currency, dueDate, messageId } = opts;

  const task = await createTask(chatId, `Payment reminder: ${service}`);
  if (!task) return;

  await updateTask(task.id, {
    status: "pending",
    metadata: { type: "email_task", service, amount, currency, due_date: dueDate, source_email_id: messageId },
  });

  const dueLine = dueDate ? ` due ${dueDate}` : "";
  const amtLine = amount > 0 ? ` — ${currency} ${amount.toFixed(2)}` : "";

  const buttons = [
    [
      { text: "Make Task", callback_data: `gm:task:${task.id}` },
      { text: "Ignore", callback_data: `gm:ign:${task.id}` },
    ],
  ];

  const msg = `💳 *Payment reminder*: ${service}${amtLine}${dueLine}`;

  await sendTelegramMessage(botToken, chatId, msg, {
    parseMode: "Markdown",
    buttons,
  });
}
```

- [ ] **Step 5: Run tests to confirm passing**

```bash
bun test src/lib/flows/actionable.test.ts src/lib/flows/payment-reminder.test.ts
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/flows/actionable.ts src/lib/flows/actionable.test.ts src/lib/flows/payment-reminder.ts src/lib/flows/payment-reminder.test.ts
git commit -m "feat: add actionable and payment-reminder flows with tests"
```

---

## Task 6: Photo Classifier Flow

**Files:**
- Create: `src/lib/flows/photo-classifier.ts`
- Create: `src/lib/flows/photo-classifier.test.ts`

Handles photo classification (Pass 1), Google Maps venue lookup, Firecrawl product search, and memory saves.

- [ ] **Step 1: Write failing tests**

Create `src/lib/flows/photo-classifier.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";

const mockCreate = mock(async () => ({
  content: [{ type: "text", text: "food_place" }],
}));

mock.module("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

const { classifyPhoto } = await import("./photo-classifier");

describe("classifyPhoto", () => {
  it("returns food_place classification", async () => {
    const result = await classifyPhoto({
      caption: "Dinner at Boon Tong Kee",
      visionDescription: "A plate of chicken rice at a restaurant",
    });
    expect(result).toBe("food_place");
  });

  it("defaults to general for unknown classification", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "something_random" }],
    });
    const result = await classifyPhoto({
      caption: "",
      visionDescription: "A sunset photo",
    });
    expect(result).toBe("general");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/lib/flows/photo-classifier.test.ts
```

- [ ] **Step 3: Create src/lib/flows/photo-classifier.ts**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { sendTelegramMessage } from "../telegram";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type PhotoCategory = "receipt" | "food_place" | "product" | "general";

const VALID_PHOTO_CATEGORIES = new Set<PhotoCategory>(["receipt", "food_place", "product", "general"]);

export async function classifyPhoto(opts: {
  caption: string;
  visionDescription: string;
}): Promise<PhotoCategory> {
  const { caption, visionDescription } = opts;

  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 20,
    messages: [{
      role: "user",
      content: `Classify this photo into exactly one category. Reply with ONLY the category name.

Categories:
- receipt — shows a bill, invoice, or payment confirmation
- food_place — shows food, a restaurant, café, or place to eat
- product — shows a product the user may be considering purchasing
- general — anything else

Caption: ${caption || "(none)"}
Image description: ${visionDescription}`,
    }],
  });

  const raw = (res.content[0] as any).text.trim().toLowerCase() as PhotoCategory;
  return VALID_PHOTO_CATEGORIES.has(raw) ? raw : "general";
}

export async function lookupVenueAndNotify(opts: {
  botToken: string;
  chatId: string;
  venueName: string;
  assetId?: string;
}): Promise<void> {
  const { botToken, chatId, venueName, assetId } = opts;

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    await sendTelegramMessage(botToken, chatId, `📍 Looks like: *${venueName}*. (Google Maps API not configured — set GOOGLE_MAPS_API_KEY to get reviews.)`, { parseMode: "Markdown" });
    return;
  }

  let placeSummary = "";
  let rating = "";

  try {
    const mapsRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.editorialSummary,places.reviews",
      },
      body: JSON.stringify({ textQuery: `${venueName} Singapore` }),
    });

    if (mapsRes.ok) {
      const data = await mapsRes.json();
      const place = data.places?.[0];
      if (place) {
        rating = place.rating ? `${place.rating}★ (${place.userRatingCount} reviews)` : "";
        const editorial = place.editorialSummary?.text || "";
        const topReview = place.reviews?.[0]?.text?.text?.slice(0, 120) || "";
        placeSummary = [editorial, topReview].filter(Boolean).join(" — ");
      }
    }
  } catch (err) {
    console.warn(`Maps API lookup failed: ${err}`);
  }

  const ratingLine = rating ? `\n${rating}` : "";
  const summaryLine = placeSummary ? `\n_"${placeSummary}"_` : "";

  // Send with inline buttons using Telegram Bot API directly (background service doesn't have grammy ctx)
  const keyboard = {
    inline_keyboard: [[
      { text: "Add Note", callback_data: `ph:note:${assetId || "x"}` },
      { text: "Skip", callback_data: `ph:skip:${assetId || "x"}` },
    ]],
  };

  const msg = `📍 *${venueName}*${ratingLine}${summaryLine}\n\nWant to add your own note?`;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: msg,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }),
  });
}

export async function lookupProductAndNotify(opts: {
  botToken: string;
  chatId: string;
  productName: string;
  assetId?: string;
}): Promise<void> {
  const { botToken, chatId, productName, assetId } = opts;

  let reviewSummary = "";
  let priceRange = "";

  try {
    const { execSync } = await import("child_process");
    const searchOut = execSync(
      `firecrawl search "${productName} review price Singapore" --limit 3 --json`,
      { encoding: "utf-8", timeout: 15000 }
    );
    const results = JSON.parse(searchOut);
    const snippets = results?.data?.web?.slice(0, 2).map((r: any) => r.description || "").filter(Boolean);
    reviewSummary = snippets?.join(" — ").slice(0, 200) || "";
  } catch {
    reviewSummary = "";
  }

  const reviewLine = reviewSummary ? `\n_${reviewSummary}_` : "";
  const priceLine = priceRange ? ` ~SGD ${priceRange}` : "";

  const keyboard = {
    inline_keyboard: [[
      { text: "Save for Later", callback_data: `ph:save:${assetId || "x"}` },
      { text: "Skip", callback_data: `ph:skip:${assetId || "x"}` },
    ]],
  };

  const msg = `🛍️ *${productName}*${priceLine}${reviewLine}\n\nSave this to come back to?`;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: msg,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }),
  });
}

/**
 * Saves a place or product memory entry to Convex.
 */
export async function saveMemoryEntry(content: string): Promise<void> {
  try {
    const { getConvex, api } = await import("../convex");
    const cx = getConvex();
    if (!cx) return;
    await cx.mutation(api.memory.insert, { type: "fact", content });
  } catch (err) {
    console.warn(`Memory save failed: ${err}`);
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test src/lib/flows/photo-classifier.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/photo-classifier.ts src/lib/flows/photo-classifier.test.ts
git commit -m "feat: add photo classifier — receipt/food/product with Maps API + Firecrawl"
```

---

## Task 7: Inject Photo Classifier into bot.ts

**Files:**
- Modify: `src/bot.ts`

**Injection point:** In `handlePhotoMessage`, after vision description is computed (line ~1185) and before `classifyComplexity` / `callClaudeWithProgress` (line ~1190).

- [ ] **Step 1: Find the exact injection point**

```bash
grep -n "usedVisionFallback\|photoPrompt\|classifyComplexity" src/bot.ts | head -10
```

Note the line number where `photoPrompt` is first assigned.

- [ ] **Step 2: Add photo classification block**

After the line where `photoPrompt` is built (the `let photoPrompt: string;` block, around line 1173), add:

```typescript
// --- Photo classification ---
// classifyPhoto runs after vision description is available
let photoCategory: import("./lib/flows/photo-classifier").PhotoCategory = "general";
try {
  const { classifyPhoto } = await import("./lib/flows/photo-classifier");
  photoCategory = await classifyPhoto({
    caption,
    visionDescription: usedVisionFallback ? photoPrompt : (vision || ""),
  });
} catch (err) {
  console.warn("[photo] Classification failed:", err);
}

if (photoCategory === "receipt") {
  const { startReceiptFlow } = await import("./lib/flows/receipt");
  await startReceiptFlow({
    botToken: BOT_TOKEN,
    chatId,
    vendor: "",
    amount: 0,
    currency: "SGD",
    date: new Date().toISOString().slice(0, 10),
    imagePath: localPath,
  });
  return;
}

if (photoCategory === "food_place") {
  const { lookupVenueAndNotify } = await import("./lib/flows/photo-classifier");
  // Extract venue name from caption or use generic "this place"
  const venueName = caption && caption.length > 3 ? caption : "this place";
  await lookupVenueAndNotify({ botToken: BOT_TOKEN, chatId, venueName, assetId: asset?.id });
  return;
}

if (photoCategory === "product") {
  const { lookupProductAndNotify } = await import("./lib/flows/photo-classifier");
  const productName = caption && caption.length > 3 ? caption : "this product";
  await lookupProductAndNotify({ botToken: BOT_TOKEN, chatId, productName, assetId: asset?.id });
  return;
}
// photoCategory === "general" — fall through to existing Claude handling
```

- [ ] **Step 3: Identify where `vision` variable is set**

Check that the variable holding the vision description text is accessible at the injection point. Run:

```bash
grep -n "const vision\|let vision\|describeImage" src/bot.ts | head -5
```

Adjust the import in Step 2 to use the correct variable name.

- [ ] **Step 4: Add new callback handlers to handleCallbackQuery**

In `src/bot.ts`, find `handleCallbackQuery` and add before the final `if (!data.startsWith("atask:")) return;` line:

```typescript
// ---- Photo flow callbacks ----
if (data.startsWith("ph:note:")) {
  const assetId = data.replace("ph:note:", "");
  // Ask user for their personal note
  await ctx.editMessageText("What did you think / want to remember about this place?").catch(() => {});
  // Store pending note request in async_tasks
  const chatId = String(ctx.chat?.id || "");
  const task = await createTask(chatId, "Photo place note");
  if (task) {
    await updateTask(task.id, {
      status: "needs_input",
      metadata: { type: "place_note_pending", asset_id: assetId },
    });
  }
  return;
}

if (data.startsWith("ph:save:")) {
  const assetId = data.replace("ph:save:", "");
  // Save product to memory with asset reference
  const { saveMemoryEntry } = await import("./lib/flows/photo-classifier");
  await saveMemoryEntry(`[Product saved for later] Asset: ${assetId}. Date: ${new Date().toISOString().slice(0, 10)}`);
  await ctx.editMessageText("✅ Saved for later.").catch(() => {});
  return;
}

if (data.startsWith("ph:skip:")) {
  await ctx.editMessageText("✓").catch(() => {});
  return;
}

if (data.startsWith("ph:copy:")) {
  const taskId = data.replace("ph:copy:", "");
  // Retrieve the formatted forward text from the task metadata
  const { getTaskById } = await import("./lib/supabase");
  const task = await getTaskById(taskId);
  const forwardText = task?.metadata?.forward_text || "(expense details not found)";
  await ctx.reply(`Forward to Honey:\n\n${forwardText}`).catch(() => {});
  return;
}

// ---- Gmail flow callbacks ----
if (data.startsWith("gm:cal:")) {
  const taskId = data.replace("gm:cal:", "");
  await ctx.editMessageText("📅 Adding to calendar...").catch(() => {});
  try {
    const sb = (await import("./lib/supabase")).getSupabase();
    if (!sb) throw new Error("Supabase not available");
    const { data: task } = await sb.from("async_tasks").select("*").eq("id", taskId).single();
    if (!task?.metadata) throw new Error("Task not found");
    const { createCalendarEvent } = await import("./lib/flows/appointment");
    // metadata should have appointment details stored by gmail-monitor
    const link = await createCalendarEvent(task.metadata.appointment_details);
    await ctx.editMessageText(`✅ Added to calendar.${link ? " [View](" + link + ")" : ""}`).catch(() => {});
  } catch (err: any) {
    await ctx.editMessageText(`❌ Calendar error: ${err.message}`).catch(() => {});
  }
  return;
}

if (data.startsWith("gm:task:")) {
  const taskId = data.replace("gm:task:", "");
  await updateTask(taskId, { status: "pending" });
  await ctx.editMessageText("✅ Saved as a task.").catch(() => {});
  return;
}

if (data.startsWith("gm:skip:") || data.startsWith("gm:ign:")) {
  const taskId = data.replace("gm:skip:", "").replace("gm:ign:", "");
  await updateTask(taskId, { status: "failed", result: "ignored by user" });
  await ctx.editMessageText("✓ Ignored.").catch(() => {});
  return;
}
```

- [ ] **Step 5: Test locally**

```bash
bun run start
```

Send a photo of a restaurant to the bot. Verify it replies with a venue lookup instead of a generic response.

- [ ] **Step 6: Commit**

```bash
git add src/bot.ts
git commit -m "feat: inject photo classifier into handlePhotoMessage + add gm:/ph: callbacks"
```

---

## Task 8: Gmail Monitor Background Service

**Files:**
- Create: `src/gmail-monitor.ts`

This is the main orchestrator — fetches emails, classifies, routes to flows.

- [ ] **Step 1: Create src/gmail-monitor.ts**

```typescript
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
```

- [ ] **Step 2: Test manually**

```bash
bun run src/gmail-monitor.ts --force
```

Expected: runs without crash, logs inbox activity. Check for any obvious errors.

- [ ] **Step 3: Commit**

```bash
git add src/gmail-monitor.ts
git commit -m "feat: add gmail-monitor background service"
```

---

## Task 9: launchd Service + Env Vars

**Files:**
- Create: `launchd/com.go.gmail-monitor.plist.template`
- Modify: `.env.example`

- [ ] **Step 1: Create the plist template**

```bash
cp launchd/com.go.twinmind-monitor.plist.template launchd/com.go.gmail-monitor.plist.template
```

Edit the new file — change:
- `Label` → `com.go.gmail-monitor`
- `ProgramArguments` script → `src/gmail-monitor.ts`
- Log paths → `logs/gmail-monitor.log` and `logs/gmail-monitor.error.log`
- Comment → `Every 30 min, 8am-10pm`

- [ ] **Step 2: Add env vars to .env.example**

```bash
grep -n "TWINMIND_NLM_NOTEBOOK_ID\|GOOGLE_MAPS" .env.example
```

If not present, add to `.env.example`:

```
# Gmail Monitor
SERMONS_NLM_NOTEBOOK_ID=b4641586-cd2b-456c-be59-5f4238995e9d
GOOGLE_MAPS_API_KEY=
```

- [ ] **Step 3: Register the launchd service**

Run via the existing setup helper, or manually:

```bash
# Generate the plist (substitute placeholders)
bun run setup:launchd -- --service gmail-monitor
```

Or manually load:

```bash
cp launchd/com.go.gmail-monitor.plist.template ~/Library/LaunchAgents/com.go.gmail-monitor.plist
# Edit the plist to replace {{BUN_PATH}}, {{PROJECT_ROOT}}, etc.
launchctl load ~/Library/LaunchAgents/com.go.gmail-monitor.plist
launchctl list | grep gmail-monitor
```

Expected: service listed with exit code 0.

- [ ] **Step 4: Verify first scheduled run**

```bash
tail -f logs/gmail-monitor.log
```

Wait for next 30-min mark or trigger manually:

```bash
bun run src/gmail-monitor.ts
```

- [ ] **Step 5: Commit**

```bash
git add launchd/com.go.gmail-monitor.plist.template .env.example
git commit -m "feat: add gmail-monitor launchd service + env vars"
```

---

## Task 10: Handle Receipt Reply in bot.ts

The receipt flow creates a `needs_input` task and waits for user reply. Wire up the reply handler in `bot.ts` text message processing.

**Files:**
- Modify: `src/bot.ts`

- [ ] **Step 1: Find where text messages are processed**

```bash
grep -n "needs_input\|getStaleTasks\|handleTaskCallback\|receipt_pending" src/bot.ts | head -10
```

- [ ] **Step 2: Add receipt reply detection**

In the text message handler (before the generic Claude call), add a check for pending receipt tasks:

```typescript
// Check for pending receipt reply
const sb = (await import("./lib/supabase")).getSupabase();
if (sb) {
  const { data: pendingReceipts } = await sb
    .from("async_tasks")
    .select("*")
    .eq("chat_id", chatId)
    .eq("status", "needs_input")
    .eq("metadata->>type", "receipt_pending")
    .order("created_at", { ascending: false })
    .limit(1);

  if (pendingReceipts && pendingReceipts.length > 0) {
    const task = pendingReceipts[0];
    // Parse "for X with Y" from user reply using a quick Haiku call
    const client = new (await import("@anthropic-ai/sdk")).default();
    const parseRes = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `Parse this expense note into JSON. Reply with ONLY valid JSON.\nNote: "${text}"\nSchema: {"purpose":"","with_person":""}`,
      }],
    });
    let parsed = { purpose: text, with_person: "self" };
    try { parsed = JSON.parse((parseRes.content[0] as any).text.trim()); } catch {}

    const { completeReceiptFlow } = await import("./lib/flows/receipt");
    await completeReceiptFlow({
      botToken: BOT_TOKEN,
      chatId,
      taskId: task.id,
      vendor: task.metadata?.vendor || "",
      amount: task.metadata?.amount || 0,
      currency: task.metadata?.currency || "SGD",
      date: task.metadata?.date || new Date().toISOString().slice(0, 10),
      purpose: parsed.purpose,
      with_person: parsed.with_person,
      imagePath: task.metadata?.image_path || undefined,
    });
    return; // Don't fall through to Claude
  }
}
```

- [ ] **Step 3: Test end-to-end receipt flow**

1. Send a photo of a receipt to the bot
2. Bot should reply: "Receipt detected — what's this for, and who's it with?"
3. Reply: "Lunch with Rishi for the WMI proposal"
4. Bot should reply with formatted expense + "Ready to Forward to Honey" message

- [ ] **Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "feat: handle receipt reply — complete HITL expense flow"
```

---

## Task 11: Place Note Reply Handler

After a user taps "Add Note" on a food/place photo, the bot asks for their note. Wire up the reply.

**Files:**
- Modify: `src/bot.ts`

- [ ] **Step 1: Add place_note_pending reply check**

In the same text message handler section (after receipt check), add:

```typescript
// Check for pending place note reply
if (sb) {
  const { data: pendingNotes } = await sb
    .from("async_tasks")
    .select("*")
    .eq("chat_id", chatId)
    .eq("status", "needs_input")
    .eq("metadata->>type", "place_note_pending")
    .order("created_at", { ascending: false })
    .limit(1);

  if (pendingNotes && pendingNotes.length > 0) {
    const task = pendingNotes[0];
    const assetId = task.metadata?.asset_id || "";

    const { saveMemoryEntry } = await import("./lib/flows/photo-classifier");
    await saveMemoryEntry(
      `[Place] Asset: ${assetId} | Personal note: ${text} | Date: ${new Date().toISOString().slice(0, 10)}`
    );

    await updateTask(task.id, { status: "completed" });
    await ctx.reply("✅ Note saved.");
    return;
  }
}
```

- [ ] **Step 2: Test place note flow**

1. Send a photo of a restaurant
2. Bot replies with venue info + "Add Note" / "Skip" buttons
3. Tap "Add Note"
4. Bot asks: "What did you think / want to remember about this place?"
5. Reply with your note
6. Bot replies: "✅ Note saved."

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat: handle place note reply — save to Convex memory"
```

---

## Final Verification

- [ ] Run full type-check:

```bash
bunx tsc --noEmit 2>&1 | grep -v "boardSessions\|projects.ts" | head -20
```

Expected: no errors in files touched by this feature.

- [ ] Run all new tests:

```bash
bun test src/lib/gmail-classifier.test.ts src/lib/flows/receipt.test.ts src/lib/flows/appointment.test.ts src/lib/flows/actionable.test.ts src/lib/flows/payment-reminder.test.ts src/lib/flows/photo-classifier.test.ts
```

Expected: all pass.

- [ ] Verify launchd service is loaded and logs are clean:

```bash
launchctl list | grep gmail-monitor
tail -20 logs/gmail-monitor.log
```

- [ ] Final commit:

```bash
git add -A
git commit -m "feat: ambient email & receipt intelligence — complete"
```
