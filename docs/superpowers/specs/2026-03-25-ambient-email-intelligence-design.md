# Ambient Email & Receipt Intelligence

**Date:** 2026-03-25
**Status:** Approved for implementation

---

## Overview

GoBot monitors two Gmail inboxes every 30 minutes and classifies incoming content using a two-pass approach (lightweight classify → targeted extraction). Classified content triggers one of six flows delivered via Telegram with inline action buttons. Photos of receipts sent directly to the bot are also handled.

---

## Inboxes

| Inbox | Focus |
|---|---|
| `alvin@straitsinteractive.com` | General SI: receipts, appointments, actionables, payment reminders |
| `tool.alvin@gmail.com` | NCC/Noah emails only: meetings, sermon content, payment reminders |

Emails not matching any classification are silently ignored. Processed email IDs are stored in Convex to prevent duplicate processing.

---

## Architecture

### Background Service — `src/gmail-monitor.ts`

Runs every 30 minutes via launchd (`com.go.gmail-monitor`). Follows the same pattern as `twinmind-monitor.ts`.

**Per-run steps:**

1. Read last-run timestamp from Convex (`gmailMonitor:getLastRun`)
2. Fetch emails from both inboxes since last run using `mcp__google-workspace__gmail_search`
3. For each email, run **Pass 1** (Haiku-tier): classify into one of:
   - `receipt` / `appointment` / `actionable` / `ncc_meeting` / `ncc_sermon_content` / `ncc_sermon_notify` / `payment_reminder` / `ignore`
4. Skip `ignore` and `ncc_sermon_notify` immediately
5. For all others, run **Pass 2** (Sonnet-tier): extract structured details and trigger the appropriate flow
6. Update last-run timestamp in Convex

**NCC/Noah filter:** For `tool.alvin@gmail.com`, only process emails where sender matches `newcreation`, `ncc`, or sender name is `Noah`. All other senders in that inbox are ignored.

### Convex Schema Additions

```
gmailMonitor: defineTable({
  inbox: v.string(),           // "si" | "tool"
  last_run: v.number(),        // unix ms
})

gmailProcessed: defineTable({
  message_id: v.string(),      // Gmail message ID
  classified_as: v.string(),
  processed_at: v.number(),
}).index("by_message_id", ["message_id"])
```

### Pass 1 — Classification Prompt (Haiku)

```
Classify this email into exactly one category. Reply with only the category name.

Categories:
- receipt: purchase confirmation, expense, invoice, payment receipt
- appointment: calendar invite, meeting request, event confirmation with date/time
- actionable: requires a response, decision, or follow-up
- ncc_meeting: from New Creation Church or Noah, contains a meeting or event date
- ncc_sermon_content: from New Creation Church or Noah, contains sermon notes, transcript, or slides
- ncc_sermon_notify: from New Creation Church or Noah, notifies of a sermon but has no content
- payment_reminder: subscription renewal, payment due, overdue invoice
- ignore: newsletter, marketing, FYI, no action needed

Subject: {subject}
From: {sender}
Snippet: {snippet}
```

### Pass 2 — Extraction Prompts (Sonnet)

Each category gets a targeted extraction prompt that outputs structured JSON used to compose the Telegram message and action buttons.

---

## Flow 1 — Receipt

**Triggers:** Email classified as `receipt` in either inbox, OR user sends a photo to the bot.

**Steps:**
1. Bot sends: *"Receipt detected — what's this for, and who's it with?"*
2. User replies with context
3. Bot formats an expense summary:
   > `[Expense] SGD 43.17 — {vendor} | For: {purpose} | With: {person} | Date: {date}`
4. If triggered by photo, image is included in the forward message
5. Bot sends the formatted message to Alvin with a **[Ready to Forward to Honey]** button
6. Tapping the button sends Alvin the pre-formatted text block, ready to copy-paste or forward

**Data extracted in Pass 2:** vendor, amount, currency, date

---

## Flow 2 — Appointment

**Triggers:** Email classified as `appointment` (SI inbox) or `ncc_meeting` (tool inbox).

**Steps:**
1. Bot sends a summary with inline buttons:
   > *"Meeting with Jason (WMI) — Thu 2 Apr, 2–3pm at WMI Office. Add to calendar?"*
   - **[Add to Calendar]** / **[Skip]**
2. On **Add to Calendar**: calls `mcp__google-workspace__calendar_createEvent`, confirms with:
   > *"Added to calendar: Jason (WMI) — Thu 2 Apr, 2–3pm."*
3. On **Skip**: dismissed silently

**Data extracted in Pass 2:** title, date, time, duration, location, attendees

---

## Flow 3 — Actionable Item

**Triggers:** Email classified as `actionable` in SI inbox.

**Steps:**
1. Bot surfaces a short summary with buttons:
   > *"Email from Rishi: Budget approval needed for Q2 campaign — SGD 4,200."*
   - **[Make Task]** / **[Add to Calendar]** / **[Ignore]**
2. **Make Task** → creates a triage task in Convex (same system as triage dashboard)
3. **Add to Calendar** → same as Flow 2
4. **Ignore** → dismissed

---

## Flow 4 — NCC Sermon with Content

**Triggers:** Email from NCC/Noah classified as `ncc_sermon_content`.

**Steps:**
1. Bot silently adds full email body/attachments to the Sermons NotebookLM notebook (`b4641586-cd2b-456c-be59-5f4238995e9d`) via `nlm source add`
2. Bot confirms:
   > *"Sermon notes added to NotebookLM: '{sermon title}'."*

No action buttons needed.

---

## Flow 5 — Payment Reminder

**Triggers:** Email classified as `payment_reminder` in either inbox.

**Steps:**
1. Bot surfaces the reminder:
   > *"Payment reminder: Canva Pro — SGD 17.90 due 28 Mar."*
   - **[Make Task]** / **[Ignore]**
2. **Make Task** → creates a triage task in Convex with due date
3. **Ignore** → dismissed

**Data extracted in Pass 2:** service name, amount, currency, due date

---

## Photo Receipt Handling

The existing `handlePhotoMessage` in `bot.ts` is augmented with a classification step before the generic Claude call:

1. Run Pass 1 classification on the image (using vision description + caption)
2. If classified as `receipt` → enter Flow 1 instead of generic response
3. Otherwise → existing behaviour unchanged

---

## Error Handling

- Gmail API failures: log to Convex, skip run silently (no Telegram noise)
- Classification failures: default to `ignore` (never surface garbage)
- Calendar creation failures: send plain-text error to Alvin
- NotebookLM failures: send plain-text error to Alvin

---

## New Files

| File | Purpose |
|---|---|
| `src/gmail-monitor.ts` | Main background service |
| `src/lib/gmail-classifier.ts` | Pass 1 + Pass 2 classification logic |
| `src/lib/flows/receipt.ts` | Receipt flow handler |
| `src/lib/flows/appointment.ts` | Appointment flow handler |
| `src/lib/flows/actionable.ts` | Actionable item flow handler |
| `src/lib/flows/payment-reminder.ts` | Payment reminder flow handler |
| `convex/gmailMonitor.ts` | Last-run tracking + processed message IDs |

## Modified Files

| File | Change |
|---|---|
| `src/bot.ts` | Augment `handlePhotoMessage` with receipt classification |
| `convex/schema.ts` | Add `gmailMonitor` and `gmailProcessed` tables |
| `launchd/templates/` | Add `com.go.gmail-monitor.plist` template |

---

## Out of Scope

- Sending directly to Honey's Telegram (requires her chat ID; manual forward is the solution)
- Processing attachments beyond email body text (PDFs, Word docs)
- Handling `tool.alvin@gmail.com` emails that are not from NCC/Noah
