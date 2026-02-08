# Module 6: Morning Briefing

> This module explains the daily morning briefing -- a Telegram message
> that summarizes your goals, calendar, and optionally AI news.

---

## What the Briefing Includes

Every morning (default 9:00 AM), the bot sends you a structured summary:

```
GOOD MORNING [Name]
Saturday, February 8

TODAY: Clear schedule (or list of events)

GOALS (3 active)
- Finish course outline (by Feb 10)
- Launch newsletter
- Review sponsorship proposal

---
Reply to chat with me
```

If you have the xAI API key configured, a second message follows with
AI news from X/Twitter.

---

## Key File: src/morning-briefing.ts

This is a standalone script (230 lines) that runs independently from
the main bot via launchd:

| Section | Lines | Purpose |
|---------|-------|---------|
| Data gathering | 35-160 | Fetch goals, calendar, AI news |
| Build and send | 166-216 | Assemble and deliver the briefing |
| Main | 222-229 | Entry point |

---

## Data Gathering

The briefing fetches data from three sources **in parallel**:

```typescript
const [goals, calendar, aiNews] = await Promise.all([
  getActiveGoals(),
  getCalendarToday(),
  getAINews(),
]);
```

### Goals (lines 35-82)

The `getActiveGoals()` function tries Supabase first:

```typescript
const response = await fetch(
  `${SUPABASE_URL}/rest/v1/memory?type=eq.goal&select=content,metadata&order=created_at.desc&limit=5`,
  { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
);
```

If Supabase is not configured, it falls back to reading `memory.json`:

```typescript
const content = await readFile(join(PROJECT_ROOT, "memory.json"), "utf-8");
const memory = JSON.parse(content);
```

Returns a count and formatted list of active goals.

### Calendar (lines 84-130)

Calendar events are fetched via the **Google Calendar REST API directly**,
not through a Claude subprocess. This is a critical architectural choice:

```typescript
import { getValidAccessToken, KEYCHAIN_CALENDAR } from "./lib/google-auth";

const accessToken = await getValidAccessToken(KEYCHAIN_CALENDAR);
const res = await fetch(
  `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
  { headers: { Authorization: `Bearer ${accessToken}` } }
);
```

**Why not use Claude subprocess?** Claude subprocesses initialize all MCP
servers on startup, which takes 60-180 seconds from launchd (background).
Direct API calls complete in under 1 second. See
[Architecture > Direct API vs Claude Subprocess](./architecture.md) for details.

The OAuth token is read from the macOS Keychain (stored there by the
Google MCP server during initial setup) and auto-refreshed when expired.
If Google Calendar is not configured, it gracefully shows "Calendar not configured".

### AI News (lines 110-160)

If `XAI_API_KEY` is configured, the bot queries Grok for real-time AI news:

```typescript
const response = await fetch("https://api.x.ai/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${XAI_API_KEY}`,
  },
  body: JSON.stringify({
    model: "grok-3-fast",
    messages: [
      {
        role: "system",
        content: "You are an AI news analyst with real-time access to X/Twitter.",
      },
      {
        role: "user",
        content: `Today is ${today}. Search X/Twitter for the most important AI news from the last 24 hours. Max 5 items.`,
      },
    ],
    search: {
      mode: "auto",
      sources: [{ type: "x" }, { type: "web" }],
      recency_filter: "day",
    },
  }),
});
```

The `search` parameter enables Grok's real-time web and X/Twitter search.

---

## Telegram Message Formatting

The briefing uses Telegram Markdown formatting:

```typescript
let briefing = `GOOD MORNING ${userName.toUpperCase()}\n_${dateStr}_\n\n`;
briefing += calendar + "\n\n";
briefing += `GOALS (${goals.count} active)\n`;
briefing += goals.goals.join("\n");
briefing += "\n\n---\n_Reply to chat with me_";
```

The `sendTelegramMessage()` function in `src/lib/telegram.ts` handles
sanitization -- if Markdown parsing fails (Telegram is strict), it
retries without formatting:

```typescript
if (response.status === 400 && options?.parseMode) {
  const fallback = await fetch(url, {
    body: JSON.stringify({
      chat_id: chatId,
      text: message.replace(/\*/g, "").replace(/_/g, ""),
    }),
  });
}
```

AI news is sent as a separate message (with a 1-second delay) to keep
the main briefing clean and concise.

---

## User Profile for Greeting

The briefing reads `config/profile.md` to extract your name:

```typescript
const profile = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
const nameMatch = profile.match(/^#\s*(.+)/m);
if (nameMatch) userName = nameMatch[1].trim();
```

If no profile exists, it defaults to "there" (as in "Good morning there").

---

## How to Customize

### Change the Time

Edit `config/schedule.json`:

```json
{
  "morning_briefing": {
    "hour": 7,
    "minute": 30,
    "enabled": true
  }
}
```

Then regenerate the launchd plist:

```bash
bun run setup:launchd -- --service morning-briefing
```

### Disable AI News

Simply do not set the `XAI_API_KEY` in your `.env`. The function
returns an empty string when the key is missing:

```typescript
if (!XAI_API_KEY) {
  return "";
}
```

### Add Your Own Data Sources

To add a new section to the briefing:

1. Create an async function that returns formatted text
2. Add it to the `Promise.all()` call
3. Include it in the briefing message assembly

Example -- adding weather:

```typescript
async function getWeather(): Promise<string> {
  // Call a weather API
  return "Weather: 5C, partly cloudy";
}

// In buildAndSendBriefing():
const [goals, calendar, aiNews, weather] = await Promise.all([
  getActiveGoals(),
  getCalendarToday(),
  getAINews(),
  getWeather(),
]);
```

### Running Manually

Test the briefing without waiting for the schedule:

```bash
bun run briefing
# or
bun run src/morning-briefing.ts
```

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/morning-briefing.ts` | Complete briefing script |
| `src/lib/telegram.ts` | `sendTelegramMessage()` with Markdown sanitization |
| `src/lib/google-auth.ts` | OAuth token management for calendar API |
| `config/schedule.example.json` | Briefing time configuration |
| `config/profile.example.md` | User profile template for greeting |
| `launchd/com.go.morning-briefing.plist.template` | Service schedule |

---

**Next module:** [07 - launchd Always-On](./07-launchd-always-on.md)
