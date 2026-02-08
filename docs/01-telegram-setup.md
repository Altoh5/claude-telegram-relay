# Module 1: Telegram Setup

> This module walks you through creating a Telegram bot, getting your
> credentials, and understanding forum groups for multi-agent routing.

---

## Creating a Bot with BotFather

Every Telegram bot is created through [@BotFather](https://t.me/BotFather),
which is itself a bot run by Telegram.

### Step-by-Step

1. Open Telegram and search for `@BotFather`
2. Start a conversation and send `/newbot`
3. BotFather asks for a **display name** (e.g., "Go Assistant")
4. BotFather asks for a **username** (must end in `bot`, e.g., `go_assistant_bot`)
5. BotFather replies with your **bot token**

The token looks like this:

```
123456789:ABCdefGhIjKlMnOpQrStUvWxYz
```

**Save this token.** You will put it in your `.env` file as `TELEGRAM_BOT_TOKEN`.

### Optional: Customize Your Bot

While chatting with BotFather, you can also:
- `/setdescription` -- what users see when they open your bot
- `/setabouttext` -- the "About" section on the bot's profile
- `/setuserpic` -- upload a profile picture for your bot

---

## Getting Your Telegram User ID

The bot needs to know YOUR user ID so it only responds to you.
There are two easy ways to find it:

### Method 1: @userinfobot

1. Search for `@userinfobot` on Telegram
2. Send it any message
3. It replies with your user ID (a number like `123456789`)

### Method 2: @getmyid_bot

1. Search for `@getmyid_bot` on Telegram
2. Start the bot
3. It replies with your user ID

Save this number. It goes in `.env` as `TELEGRAM_USER_ID`.

---

## Setting Your Credentials

Open your `.env` file and fill in both values:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIjKlMnOpQrStUvWxYz
TELEGRAM_USER_ID=123456789
```

Verify the connection:

```bash
bun run test:telegram
```

This runs `setup/test-telegram.ts` which calls the Telegram `getMe` API
to confirm your token is valid.

---

## Forum Groups: What They Are

Telegram **forum groups** (also called "topics") are groups where conversations
are organized into separate threads, similar to Discord channels or Slack threads.

In this project, each forum topic maps to a specialized AI agent:

| Topic Name | Agent | Purpose |
|-----------|-------|---------|
| General | Orchestrator | Default assistant, cross-agent coordination |
| Research | Research Agent | Market intel, competitive analysis |
| Content | Content Agent (CMO) | Video packaging, audience growth |
| Finance | Finance Agent (CFO) | ROI analysis, unit economics |
| Strategy | Strategy Agent (CEO) | Major decisions, long-term planning |

When you send a message in the "Research" topic, the bot routes it to the
Research agent with its specialized system prompt and reasoning framework.

### How to Enable Topics

1. Create a new Telegram group (or use an existing one)
2. Go to Group Settings > Edit > Toggle **"Topics"** on
3. You will see a "General" topic created automatically
4. Create additional topics: tap the "+" button to add topics

### Getting Topic IDs

After creating your topics, you need their numeric IDs:

1. Add your bot to the group as an **admin**
2. Send a message in each topic
3. Check the bot logs -- the topic ID appears as `message_thread_id`

Alternatively, start the bot in debug mode and observe the log output:

```bash
bun run start
# Send a message in each topic
# Watch the console for topic IDs
```

---

## Bot Permissions

For the bot to work in a group (especially a forum group), it needs **admin
privileges**. Here is why:

- **Read messages**: The bot must see messages in all topics
- **Send messages**: The bot must reply in the same topic
- **Manage topics** (optional): If you want the bot to create/rename topics

### Adding Your Bot as Admin

1. Go to your Telegram group
2. Tap the group name to open settings
3. Go to "Administrators"
4. Tap "Add Administrator"
5. Search for your bot's username
6. Grant the permissions it needs (at minimum: read and send messages)

---

## Security: ALLOWED_USER_ID Whitelist

The bot has a hard security boundary. In `src/bot.ts` (lines 210-217),
a middleware function checks every incoming message:

```typescript
bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id || "");
  if (userId !== ALLOWED_USER_ID) {
    // Silently ignore messages from unauthorized users
    return;
  }
  await next();
});
```

This means:
- **Only YOUR Telegram user ID** can interact with the bot
- Messages from any other user are silently dropped -- no error, no response
- This prevents random people from using your Claude API credits

If you want to add multiple authorized users in the future, you would modify
this middleware to check against an array of IDs instead of a single string.

---

## Mapping Topics to Agents

Once you have your topic IDs, update `src/agents/base.ts` to map them:

```typescript
// src/agents/base.ts, line 23
export const topicAgentMap: Record<number, string> = {
  3: "research",    // Replace 3 with your Research topic ID
  4: "content",     // Replace 4 with your Content topic ID
  5: "finance",     // Replace 5 with your Finance topic ID
  6: "strategy",    // Replace 6 with your Strategy topic ID
};
```

Messages sent outside any topic (or in a DM with the bot) route to the
"general" agent by default.

---

## Testing Your Setup

After configuring everything:

```bash
# Start the bot
bun run start

# Send a message to your bot on Telegram
# You should see the bot processing in the terminal
# And a response should appear in Telegram
```

If you set up a forum group, send messages in different topics and verify
each one uses the correct agent.

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/bot.ts` | Bot initialization, security middleware, message handlers |
| `src/agents/base.ts` | Topic-to-agent mapping (`topicAgentMap`) |
| `src/agents/index.ts` | Agent registry and exports |
| `.env` | Bot token and user ID configuration |
| `setup/test-telegram.ts` | Telegram connectivity test script |

---

**Next module:** [02 - Core Relay](./02-core-relay.md)
