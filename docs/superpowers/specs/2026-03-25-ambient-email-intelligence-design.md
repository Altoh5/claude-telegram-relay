# Ambient Email & Receipt Intelligence

**Date:** 2026-03-25
**Status:** Approved for implementation

---

## Overview

GoBot monitors two Gmail inboxes every 30 minutes and classifies incoming content using a two-pass approach (lightweight classify → targeted extraction). Classified content triggers one of seven flows delivered via Telegram with inline action buttons. Photos sent directly to the bot are also classified — receipts, food/places, and products each get their own smart flow.

---

## Inboxes & OAuth Credentials

| Inbox | OAuth token env var | Focus |
|---|---|---|
| `alvin@straitsinteractive.com` | `GOOGLE_REFRESH_TOKEN` | Receipts, appointments, actionables, payment reminders |
| `tool.alvin@gmail.com` | `GOOGLE_BOT_DOCS_REFRESH_TOKEN` | NCC/Noah emails only |

**NCC/Noah filter:** For `tool.alvin@gmail.com`, only process emails where sender domain contains `newcreation` or `ncc`, or sender name is `Noah`. All other senders in that inbox are ignored.

Background services use the Gmail REST API directly (same pattern as `src/lib/data-sources/sources/gmail.ts` and `src/docs-monitor.ts`) — NOT MCP tools, which are only available in interactive sessions.

---

## Architecture

### Background Service — `src/gmail-monitor.ts`

Runs every 30 minutes via launchd (`com.go.gmail-monitor`). Follows the same pattern as `src/twinmind-monitor.ts`.

**Per-run steps:**

1. For each inbox, read last-run timestamp from Convex (`gmailMonitor:getLastRun({ inbox: "si" | "tool" })`)
2. Fetch unread emails since last-run using Gmail REST API (`GET /gmail/v1/users/me/messages?q=is:unread after:{timestamp}`)
3. For each email, check `gmailMonitor:isProcessed({ message_id })` — skip if already processed
4. Run **Pass 1** (Haiku-tier): classify (see prompt below)
5. Skip `ignore` and `ncc_sermon_notify` — mark as processed and continue
6. Run **Pass 2** (Sonnet-tier): extract structured details, trigger flow, send Telegram message
7. Mark email as processed: `gmailMonitor:markProcessed({ message_id, classified_as })`
8. Mark email as read via Gmail REST API (`POST /gmail/v1/users/me/messages/{id}/modify`, `removeLabelIds: ["UNREAD"]`)
9. Update last-run timestamp: `gmailMonitor:setLastRun({ inbox, timestamp })`

### Convex — `convex/gmailMonitor.ts`

```typescript
// Tables
gmailMonitor: defineTable({
  inbox: v.string(),        // "si" | "tool"
  last_run: v.number(),     // unix ms
}).index("by_inbox", ["inbox"])

gmailProcessed: defineTable({
  message_id: v.string(),
  classified_as: v.string(),
  processed_at: v.number(),
}).index("by_message_id", ["message_id"])

// Functions
getLastRun({ inbox: string }) → number | null
setLastRun({ inbox: string, timestamp: number }) → void
isProcessed({ message_id: string }) → boolean
markProcessed({ message_id: string, classified_as: string }) → void
```

### Pass 1 — Classification Prompt (Haiku)

```
Classify this email into exactly one category. Reply with ONLY the category name.

Priority order (use the first that matches):
1. receipt — purchase confirmation, expense, payment received
2. ncc_meeting — sender is New Creation Church or Noah, contains a meeting/event date
3. ncc_sermon_content — sender is New Creation Church or Noah, contains sermon notes/transcript/slides
4. ncc_sermon_notify — sender is New Creation Church or Noah, notifies of a sermon but has no content
5. payment_reminder — subscription renewal, payment due, overdue invoice
6. appointment — calendar invite, meeting request with date/time
7. actionable — requires a response, decision, or follow-up
8. ignore — newsletter, marketing, FYI, no action needed

Subject: {subject}
From: {sender}
Snippet: {snippet}
```

### Pass 2 — Extraction Prompts (Sonnet)

Each non-ignored category gets a targeted extraction prompt outputting structured JSON. Defined per flow below.

### Email Task Storage

Email-sourced tasks (from Flow 1, 3, and 5) are stored in the existing `async_tasks` Supabase table, NOT in `triageTasks` (which requires `meeting_id` and is meeting-specific).

The existing `createTask(chatId, originalPrompt)` always inserts with `status: "running"`. For email flows that need a different initial status or metadata, use a two-step pattern: call `createTask`, then immediately call `updateTask(task.id, { status, metadata })`. This requires no changes to `createTask` itself.

Example for receipt pending:
```typescript
const task = await createTask(chatId, "Receipt detected");
await updateTask(task.id, { status: "needs_input", metadata: { type: "receipt_pending", vendor, amount, image_path } });
```

---

## Flow 1 — Receipt

**Triggers:** Email classified as `receipt` (either inbox), OR user sends a photo classified as a receipt.

**HITL state:** Uses `async_tasks` table with `status: "needs_input"` and `type: "receipt_pending"`. If no reply within 2 hours, bot sends a reminder. Dropped after 24 hours.

**Steps:**
1. Bot sends: *"Receipt detected — what's this for, and who's it with?"*
   - Creates `async_tasks` row: `{ type: "receipt_pending", status: "needs_input", metadata: { source, vendor, amount, image_path? } }`
2. User replies (bot correlates via `async_tasks` lookup on `needs_input` for this chat)
3. Bot formats expense summary:
   > `[Expense] SGD 43.17 — {vendor} | For: {purpose} | With: {person} | Date: {date}`
4. If photo-triggered, image is included
5. Bot sends formatted message to Alvin with **[Ready to Forward to Honey]** button — tapping shows the pre-formatted text block ready to copy/forward
6. Marks `async_tasks` row as `completed`

**Pass 2 extraction JSON:**
```json
{ "vendor": "", "amount": 0, "currency": "SGD", "date": "" }
```

---

## Flow 2 — Appointment

**Triggers:** Email classified as `appointment` (SI inbox) or `ncc_meeting` (tool inbox).

**Steps:**
1. Bot sends summary with inline buttons:
   > *"Meeting with Jason (WMI) — Thu 2 Apr, 2–3pm at WMI Office. Add to calendar?"*
   - **[Add to Calendar]** / **[Skip]**
2. **Add to Calendar** → calls Google Calendar REST API directly (`POST /calendar/v3/calendars/primary/events` with `GOOGLE_REFRESH_TOKEN`), confirms:
   > *"Added: Jason (WMI) — Thu 2 Apr, 2–3pm."*
3. **Skip** → dismissed silently

**Pass 2 extraction JSON:**
```json
{ "title": "", "date": "", "start_time": "", "end_time": "", "location": "", "attendees": [] }
```

---

## Flow 3 — Actionable Item

**Triggers:** Email classified as `actionable` (SI inbox only).

**Steps:**
1. Bot surfaces summary with buttons:
   > *"Email from Rishi: Budget approval needed for Q2 campaign — SGD 4,200."*
   - **[Make Task]** / **[Add to Calendar]** / **[Ignore]**
2. **Make Task** → creates `async_tasks` row: `{ type: "email_task", status: "pending", metadata: { subject, sender, summary, source_email_id } }`
3. **Add to Calendar** → same as Flow 2
4. **Ignore** → dismissed

---

## Flow 4 — NCC Sermon with Content

**Triggers:** Email classified as `ncc_sermon_content`.

**Steps:**
1. Bot calls `nlm source add --notebook {SERMONS_NLM_NOTEBOOK_ID} --text "{email_body}"` (same pattern as `twinmind-monitor.ts`)
2. Bot confirms:
   > *"Sermon notes added to NotebookLM: '{sermon title}'."*

**Env var:** `SERMONS_NLM_NOTEBOOK_ID` (value: `b4641586-cd2b-456c-be59-5f4238995e9d`)

---

## Flow 5 — Payment Reminder

**Triggers:** Email classified as `payment_reminder` (either inbox).

**Steps:**
1. Bot surfaces reminder:
   > *"Payment reminder: Canva Pro — SGD 17.90 due 28 Mar."*
   - **[Make Task]** / **[Ignore]**
2. **Make Task** → creates `async_tasks` row: `{ type: "email_task", status: "pending", metadata: { service, amount, currency, due_date, source_email_id } }`
3. **Ignore** → dismissed

**Pass 2 extraction JSON:**
```json
{ "service": "", "amount": 0, "currency": "SGD", "due_date": "" }
```

---

## Photo Classification Flows

The existing `handlePhotoMessage` in `src/bot.ts` is augmented with a classification step. **Injection point: after asset upload and vision pre-description (line ~1185), before the generic Claude call.** The vision description text is passed into Pass 1 as the `snippet`.

### Photo Pass 1 Prompt (Haiku)

```
Classify this photo into exactly one category. Reply with ONLY the category name.

Categories:
- receipt — shows a bill, invoice, or payment confirmation
- food_place — shows food, a restaurant, café, or place to eat
- product — shows a product the user may be considering purchasing
- general — anything else

Caption: {caption}
Image description: {vision_description}
```

### Photo Flow A — Food / Place

**Trigger:** Photo classified as `food_place`.

**Steps:**
1. Bot extracts venue name from caption or vision description, then does a two-step lookup:
   - **Step 1:** Web search using xAI Grok API (same pattern as `src/lib/data-sources/sources/grok-news.ts`) — query: `"{venue name} restaurant review Singapore"`
   - **Step 2:** If a clear review URL is found, scrape it with Firecrawl CLI for full review content
2. Bot sends a summary of Google Maps / review site results:
   > *"Looks like {restaurant name}. Google rating: 4.3★ — 'Great laksa, small portions, cash only.' Want to add your own note?"*
   - **[Add Note]** / **[Skip]**
3. **Add Note** → bot asks: *"What did you think / want to remember about this place?"*
   - Saves combined entry to Convex `memory` table via `memory:insert`: `{ type: "fact", content: "[Place] {name} — {rating}★ {reviews_summary}. Personal note: {note}. Image: {asset_id}. Date: {date}" }`
4. **Skip** → saves entry with reviews only (no personal note), same table

### Photo Flow B — Product

**Trigger:** Photo classified as `product`.

**Steps:**
1. Bot searches for product name, pricing, and reviews (Firecrawl)
2. Bot sends summary:
   > *"Looks like {product name}. ~SGD {price range}. Reviews: {summary}. Save this to come back to?"*
   - **[Save for Later]** / **[Skip]**
3. **Save for Later** → saves to Convex `memory` table via `memory:insert`: `{ type: "fact", content: "[Product] {name} — ~{price_range}. Reviews: {reviews_summary}. Image: {asset_id}. Date: {date}" }`
4. **Skip** → dismissed

### Photo Flow C — Receipt

Same as Email Flow 1, triggered from photo instead of email.

### Photo Flow D — General

Falls through to existing `handlePhotoMessage` behaviour unchanged.

---

## New Files

| File | Purpose |
|---|---|
| `src/gmail-monitor.ts` | Background service — polls both inboxes |
| `src/lib/gmail-classifier.ts` | Pass 1 + Pass 2 classification logic |
| `src/lib/flows/receipt.ts` | Receipt flow (email + photo) |
| `src/lib/flows/appointment.ts` | Appointment + NCC meeting flow |
| `src/lib/flows/actionable.ts` | Actionable item flow |
| `src/lib/flows/payment-reminder.ts` | Payment reminder flow |
| `src/lib/flows/photo-classifier.ts` | Photo Pass 1 + food/product flows |
| `convex/gmailMonitor.ts` | Last-run tracking + processed IDs |

## Modified Files

| File | Change |
|---|---|
| `src/bot.ts` | Inject photo classifier after vision description, before generic Claude call |
| `convex/schema.ts` | Add `gmailMonitor` and `gmailProcessed` tables |
| `launchd/templates/` | Add `com.go.gmail-monitor.plist` |
| `.env.example` | Add `SERMONS_NLM_NOTEBOOK_ID` |

---

## Out of Scope

- Sending directly to Honey's Telegram (requires her chat ID; manual forward is the solution)
- Processing email attachments beyond body text (PDFs, Word docs)
- Handling `tool.alvin@gmail.com` emails not from NCC/Noah
