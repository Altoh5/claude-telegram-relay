# Module 5: Smart Check-ins

> This module explains how the bot proactively reaches out to you
> based on context, timing, and goals -- not just a dumb timer.

---

## What Smart Check-ins Do

Unlike a simple cron job that sends "How are you?" every 2 hours,
smart check-ins use Claude to **decide** whether to contact you,
**what** to say, and **how** (text or call).

The decision is based on:
- How long since your last message
- How long since the last check-in
- Your active goals and deadlines
- Recent conversation context
- Time of day and day of week
- Your user profile and constraints

---

## Key File: src/smart-checkin.ts

This is a standalone script that runs as a separate process via launchd,
not as part of the main bot:

| Section | Purpose |
|---------|---------|
| State management | Load/save check-in state from JSON |
| Data gathering | Fetch email, calendar via direct Google APIs |
| Context gathering | Read recent conversation logs |
| Decision engine | Claude prompt that decides action |
| Main execution | Run decision, send message or request call |

---

## How It Works

### 1. Load Context and Gather Data

The script gathers local context and external data:

```typescript
const state = await loadState();      // Last check-in time, pending items
const memory = await loadMemory();     // Facts and goals
const recentConvo = await getRecentConversations(); // Last 3 log files
```

It also fetches email and calendar data via **direct Google REST APIs**
(not Claude subprocesses -- see "Why Direct APIs?" below):

```typescript
const emailSummary = await checkEmails();       // Gmail REST API
const calendarContext = await getCalendarEvents(); // Calendar REST API
```

### 2. Build the Decision Prompt

A detailed prompt is assembled with all context (lines 164-205):

```
CURRENT TIME & CONTEXT:
- Time: 2:30 PM on Wednesday
- Hour: 14

USER PROFILE:
[contents of config/profile.md]

TIMING:
- Minutes since last user message: 180
- Minutes since last check-in: 240

ACTIVE GOALS:
- Finish course outline (by Friday)
- Launch newsletter

RECENT CONVERSATIONS:
[last 4000 chars of conversation history]
```

### 3. Claude Makes the Decision

Claude responds in a structured format:

```
ACTION: TEXT
MESSAGE: Hey! It's been a few hours. How's the course outline coming along?
REASON: 3+ hours since last check-in, active goal with upcoming deadline
```

The three possible actions:
- **NONE** -- no check-in needed
- **TEXT** -- send a Telegram message
- **CALL** -- request permission to call (asks first, does not call directly)

### 4. Execute the Decision

If `TEXT`, the message is sent via Telegram with inline buttons:

```typescript
const buttons = [
  [
    { text: "Snooze 30m", callback_data: "snooze" },
    { text: "Got it", callback_data: "dismiss" },
  ],
];
await sendTelegramMessage(BOT_TOKEN, CHAT_ID, message, {
  parseMode: "Markdown",
  buttons,
});
```

If `CALL`, the bot asks for permission first:

```typescript
const callButtons = [
  [
    { text: "Yes, call me", callback_data: "call_yes" },
    { text: "Not now", callback_data: "call_no" },
  ],
];
```

---

## Why Direct APIs? (Key Architecture Lesson)

The check-in script fetches emails and calendar events by calling the
Google REST APIs directly, **not** through Claude subprocesses.

This matters because Claude subprocesses initialize all configured MCP
servers on startup. From launchd (background), this takes 60-180 seconds
and frequently times out. Direct API calls complete in under 1 second.

| Data Source | Method | Speed |
|-------------|--------|-------|
| Gmail | Direct REST API via `src/lib/google-auth.ts` | <1s |
| Calendar | Direct REST API via `src/lib/google-auth.ts` | <1s |
| Goals/facts | Local file read | <1ms |
| Conversation logs | Local file read | <1ms |
| Decision ("should I check in?") | Claude subprocess | 5-15s |

**Rule of thumb:** Use direct APIs for data fetching. Use Claude only for
reasoning. See [Architecture > Direct API vs Claude Subprocess](./architecture.md).

---

## Decision Rules

The prompt includes explicit rules that guide Claude's decision:

### When to Reach Out
- 3+ hours since last check-in during working hours
- 12+ hours since last user message (definitely reach out)
- A simple "How's it going?" is always acceptable

### Hard Limits
- **No contact** if checked in less than 90 minutes ago (unless urgent)
- **No contact** before 9am or after 9pm in the user's timezone
- **Call only** for urgent items or deadline-day goals

### Call vs Text
- Text is the default action
- Call is reserved for time-sensitive situations (deadline today, urgent pending items)
- The bot always **asks permission** before calling -- it never calls unannounced

---

## State Management

The check-in state is persisted in `checkin-state.json`:

```typescript
interface CheckinState {
  lastMessageTime: string;    // When the user last sent a message
  lastCheckinTime: string;    // When the bot last checked in
  lastCallTime: string;       // When the bot last called
  pendingItems: string[];     // Items that need follow-up
  context: string;            // Any extra context
}
```

This file is read at the start of each run and updated after a check-in.
The state ensures the bot does not spam you -- it knows when it last
reached out and respects the minimum gap.

---

## Inline Buttons for Quick Responses

When the bot checks in, the message includes inline buttons:

- **Snooze 30m** -- delay the next check-in
- **Got it** -- acknowledge and dismiss

For call requests:
- **Yes, call me** -- initiate the phone call
- **Not now** -- decline the call

These buttons are handled by Grammy's callback query system in the
main bot process (`src/bot.ts`).

---

## Customizing Check-in Behavior

### Schedule Configuration

Edit `config/schedule.json` to control when check-ins run:

```json
{
  "timezone": "Europe/Berlin",
  "check_in_hours": {
    "start": 10,
    "end": 19
  },
  "check_in_intervals": [
    { "hour": 10, "minute": 30 },
    { "hour": 12, "minute": 30 },
    { "hour": 14, "minute": 30 },
    { "hour": 16, "minute": 30 },
    { "hour": 18, "minute": 30 }
  ],
  "quiet_hours": {
    "start": 21,
    "end": 8
  },
  "minimum_gap_minutes": 90
}
```

These intervals map to `StartCalendarInterval` entries in the launchd plist.

### Modifying the Decision Prompt

The decision logic lives in the `shouldCheckIn()` function (line 112).
You can modify the decision rules in the prompt to change behavior:

- Increase the minimum gap: change "90 minutes" to "120 minutes"
- Make it more proactive: lower the "3+ hours" threshold
- Add custom rules: "Always check in after lunch"
- Change the tone: modify the instruction about message style

### Running Manually

Test the check-in without waiting for the schedule:

```bash
bun run checkin
# or
bun run src/smart-checkin.ts
```

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/smart-checkin.ts` | The complete check-in script |
| `src/lib/google-auth.ts` | OAuth tokens for Gmail + Calendar APIs |
| `src/lib/claude.ts` | `runClaudeWithTimeout()` used for the decision |
| `src/lib/telegram.ts` | `sendTelegramMessage()` for Telegram API calls |
| `config/schedule.example.json` | Default schedule template |
| `launchd/com.go.smart-checkin.plist.template` | Service schedule |
| `checkin-state.json` | Persisted check-in state (runtime file) |

---

**Next module:** [06 - Morning Briefing](./06-morning-briefing.md)
