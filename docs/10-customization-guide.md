# Module 10: Customization Guide

> This module walks through common customizations: adding agents,
> modifying check-ins, handling new message types, integrating APIs,
> building dashboards, and supporting multiple users.

---

## Adding a New Agent

### Step 1: Create the Agent File

Copy the template:

```bash
cp src/agents/custom-agent.example.ts src/agents/wellness.ts
```

Edit `src/agents/wellness.ts`:

```typescript
import type { AgentConfig } from "./base";
import { BASE_CONTEXT } from "./base";

const config: AgentConfig = {
  name: "Wellness Agent",
  model: "claude-opus-4-5-20251101",
  reasoning: "CoT",
  allowedTools: ["Read", "WebSearch"],
  personality: "empathetic, encouraging, science-based",
  systemPrompt: `${BASE_CONTEXT}

## WELLNESS AGENT ROLE

You are the Wellness Agent -- a health and well-being advisor.
Your job is to provide evidence-based wellness guidance.

## YOUR EXPERTISE
- Sleep hygiene and circadian rhythm optimization
- Exercise recommendations and recovery
- Stress management and mindfulness
- Nutrition basics (not medical advice)

## THINKING PROCESS (Chain of Thought)
1. LISTEN: What is the user's current state?
2. ASSESS: What wellness dimension is relevant?
3. SUGGEST: Evidence-based recommendations
4. CAVEAT: Note limitations (not medical advice)

## CONSTRAINTS
- Never replace professional medical advice
- Focus on habits and systems, not quick fixes
- Respect the user's existing routines
`,
};

export default config;
```

### Step 2: Register in base.ts

Open `src/agents/base.ts` and add a case to `getAgentConfig()`:

```typescript
case "wellness":
case "health":
  return require("./wellness").default;
```

### Step 3: Map to a Telegram Topic

In the same file, update `topicAgentMap`:

```typescript
export const topicAgentMap: Record<number, string> = {
  // ... existing mappings
  8: "wellness",  // Your wellness topic ID
};
```

### Step 4: Set Cross-Agent Permissions

Update `AGENT_INVOCATION_MAP`:

```typescript
export const AGENT_INVOCATION_MAP: Record<string, string[]> = {
  // ... existing entries
  wellness: ["critic"],
  general: ["critic", "finance", "research", "content", "strategy", "wellness"],
};
```

### Step 5: Export (Optional)

Add to `src/agents/index.ts`:

```typescript
export { default as wellnessAgent } from "./wellness";
```

And update the `AGENTS` reference:

```typescript
export const AGENTS = {
  // ... existing entries
  wellness: "Wellness Agent - Health, sleep, exercise, mindfulness (CoT reasoning)",
};
```

### Step 6: Create the Telegram Topic

1. Open your forum group
2. Create a "Wellness" topic
3. Send a message in it to discover the topic ID
4. Update the `topicAgentMap` with the actual ID

---

## Modifying Check-in Behavior

### Change the Schedule

Edit `config/schedule.json`:

```json
{
  "check_in_intervals": [
    { "hour": 9, "minute": 0 },
    { "hour": 13, "minute": 0 },
    { "hour": 17, "minute": 0 }
  ],
  "minimum_gap_minutes": 120
}
```

Then regenerate the launchd service:

```bash
bun run setup:launchd -- --service smart-checkin
```

### Modify the Decision Prompt

Edit the prompt in `src/smart-checkin.ts` around line 164.

**Make it more proactive:**
```
- YES, TEXT if it's been 2+ hours since last check-in (instead of 3)
```

**Make it less intrusive:**
```
- NO contact if checked in less than 180 minutes ago (instead of 90)
```

**Add custom rules:**
```
- Always check in around lunchtime (12-1pm) to suggest a break
- On Fridays, ask about weekend plans
```

### Change the Message Style

The decision prompt instructs Claude on tone. Modify lines like:
```
A simple "How's it going?" or "Anything I can help with?" is fine
```

To something like:
```
Use a motivational coaching tone. Reference specific goals when checking in.
```

---

## Adding New Message Handlers

The bot currently handles four message types: text, voice, photo, document.
Here is how to add more.

### Sticker Handler

```typescript
bot.on("message:sticker", (ctx) => {
  handleStickerMessage(ctx).catch(console.error);
});

async function handleStickerMessage(ctx: Context): Promise<void> {
  const sticker = ctx.message?.sticker;
  if (!sticker) return;

  const chatId = String(ctx.chat?.id || "");
  const emoji = sticker.emoji || "unknown";

  await saveMessage({
    chat_id: chatId,
    role: "user",
    content: `[Sticker: ${emoji}]`,
    metadata: { type: "sticker", stickerId: sticker.file_id },
  });

  // Respond with a fun acknowledgment
  await ctx.reply(`Nice ${emoji}!`);
}
```

### Location Handler

```typescript
bot.on("message:location", (ctx) => {
  handleLocationMessage(ctx).catch(console.error);
});

async function handleLocationMessage(ctx: Context): Promise<void> {
  const location = ctx.message?.location;
  if (!location) return;

  const chatId = String(ctx.chat?.id || "");
  const { latitude, longitude } = location;

  await saveMessage({
    chat_id: chatId,
    role: "user",
    content: `[Location: ${latitude}, ${longitude}]`,
    metadata: { type: "location", latitude, longitude },
  });

  const topicId = (ctx.message as any)?.message_thread_id;
  const agentName = topicId ? getAgentByTopicId(topicId) || "general" : "general";

  await callClaudeAndReply(
    ctx,
    chatId,
    `User shared their location: latitude ${latitude}, longitude ${longitude}. What's nearby? Any relevant suggestions?`,
    agentName,
    topicId
  );
}
```

### Callback Query Handler (Button Presses)

Handle inline button presses from check-ins:

```typescript
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data === "snooze") {
    await ctx.answerCallbackQuery({ text: "Snoozed for 30 minutes" });
    // Update check-in state to delay next check
  } else if (data === "dismiss") {
    await ctx.answerCallbackQuery({ text: "Dismissed" });
  } else if (data === "call_yes") {
    await ctx.answerCallbackQuery({ text: "Calling you now..." });
    // Initiate phone call
  }
});
```

---

## Integrating External APIs

### Pattern

Every integration follows the same structure:

```typescript
// src/lib/my-api.ts

const API_KEY = () => process.env.MY_API_KEY || "";

export function isMyApiEnabled(): boolean {
  return !!API_KEY();
}

export async function doSomething(input: string): Promise<string> {
  if (!API_KEY()) return "";

  try {
    const response = await fetch("https://api.example.com/endpoint", {
      headers: { Authorization: `Bearer ${API_KEY()}` },
      method: "POST",
      body: JSON.stringify({ data: input }),
    });

    if (!response.ok) return "";
    const data = await response.json();
    return data.result;
  } catch {
    return "";
  }
}
```

Key principles:
- Use a lazy function `() => process.env.KEY` instead of reading at import time
- Always check if the key exists before calling the API
- Return empty/null on failure, never throw
- Add to `.env.example` with a comment
- Add a check in `setup/verify.ts`

---

## Building a Dashboard

The health endpoint at `http://localhost:3000/health` already provides
basic bot status. You can extend it.

### Add a Stats Endpoint

In `src/bot.ts`, extend the health server:

```typescript
const healthServer = Bun.serve({
  port: HEALTH_PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        pid: process.pid,
        sessionId: sessionState.sessionId,
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/stats") {
      return new Response(JSON.stringify({
        messagesProcessed: messageCount,
        lastMessageAt: lastMessageTime,
        agentUsage: agentStats,
        averageResponseTime: avgResponseMs,
      }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("Not Found", { status: 404 });
  },
});
```

### Query Supabase Directly

Build a simple HTML dashboard that queries Supabase's REST API
using the `anon` key (read-only):

```javascript
const response = await fetch(
  `${SUPABASE_URL}/rest/v1/messages?select=*&order=created_at.desc&limit=50`,
  { headers: { apikey: SUPABASE_ANON_KEY } }
);
```

---

## Multi-User Support Considerations

The bot is designed for single-user use. To support multiple users:

### 1. User ID Array

Change the whitelist from a single ID to an array:

```typescript
const ALLOWED_USER_IDS = (process.env.TELEGRAM_USER_IDS || "").split(",");

bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id || "");
  if (!ALLOWED_USER_IDS.includes(userId)) return;
  await next();
});
```

### 2. Per-User Memory

Partition memory by user ID in Supabase queries:

```typescript
await sb.from("memory")
  .select("*")
  .eq("user_id", userId);
```

### 3. Per-User Sessions

Track session IDs per user instead of globally:

```typescript
const sessionStates: Record<string, SessionState> = {};
```

### 4. Per-User Profiles

Load different `config/profile-{userId}.md` files based on who is
sending the message.

### Caveats

- Each user's Claude calls use your API credits
- Check-ins and briefings would need per-user scheduling
- The forum group approach complicates multi-user (who owns which topic?)

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/agents/custom-agent.example.ts` | Agent template |
| `src/agents/base.ts` | Agent registration and routing |
| `src/smart-checkin.ts` | Check-in decision logic |
| `src/bot.ts` | Message handlers, health server |
| `config/schedule.example.json` | Schedule template |
| `.env.example` | Environment variable reference |

---

**Next module:** [Architecture Overview](./architecture.md)
