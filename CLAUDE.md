# Go - Always-On AI Telegram Bot

> Claude Code reads this file automatically. Follow the setup phases below.
> Each phase is designed to be completed through conversation with Claude Code.

## What This Sets Up

An always-on Telegram bot that:
- Relays your messages to Claude Code and sends back responses
- Runs multiple specialized AI agents (Research, Content, Finance, Strategy, Critic)
- Proactively checks in with smart context awareness
- Sends morning briefings with your goals, calendar, and AI news
- Persists memory (facts, goals, conversation history) via Supabase
- Survives reboots via macOS launchd services
- Falls back to OpenRouter/Ollama when Claude is unavailable
- Optional: voice replies, phone calls, audio transcription

## Prerequisites

Before starting, ensure you have:
- [ ] **macOS** (launchd services are macOS-only)
- [ ] **Bun** runtime installed (`curl -fsSL https://bun.sh/install | bash`)
- [ ] **Claude Code** CLI installed and authenticated (`claude --version`)
- [ ] A **Telegram** account

---

## Phase 1: Telegram Bot (Required, ~5 min)

### What you need to do:
1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create your bot
3. Copy the bot token (looks like `123456789:ABCdefGhIjKlMnOpQrStUvWxYz`)
4. Get your Telegram user ID:
   - Message [@userinfobot](https://t.me/userinfobot) on Telegram
   - It will reply with your user ID (a number like `123456789`)

### What Claude Code does:
- Creates `.env` from `.env.example` if it doesn't exist
- Saves your `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` to `.env`
- Runs `bun run setup/test-telegram.ts` to verify connectivity

### Tell me:
"Here's my bot token: [TOKEN] and my user ID: [ID]"

---

## Phase 2: Supabase (Required, ~10 min)

### What you need to do:
1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project (any name, choose a region close to you)
3. Wait for the project to finish setting up (~2 min)
4. Go to Project Settings > API and copy:
   - **Project URL** (looks like `https://abc123.supabase.co`)
   - **anon public key** (starts with `eyJ...`)
   - **service_role secret key** (starts with `eyJ...` - keep this secret!)

### What Claude Code does:
- Saves your Supabase credentials to `.env`
- Opens `db/schema.sql` and runs it in your Supabase SQL editor (you paste it)
- Runs `bun run setup/test-supabase.ts` to verify connectivity

### Tell me:
"Here are my Supabase keys: URL=[URL], anon=[KEY], service_role=[KEY]"

---

## Phase 3: Personalization (Required, ~5 min)

### What Claude Code does:
- Asks you questions about yourself (name, timezone, profession, constraints)
- Creates `config/profile.md` with your answers
- Sets `USER_TIMEZONE` in `.env`

### Tell me:
Answer the questions I'll ask about your name, timezone, and work style.

---

## Phase 4: Agent Customization (Optional, ~10 min)

The bot includes 6 pre-configured agents. You can customize them or use defaults.

### Default agents:
| Agent | Reasoning | Purpose |
|-------|-----------|---------|
| General (Orchestrator) | Adaptive | Default assistant, cross-agent coordination |
| Research | ReAct | Market intel, competitor analysis |
| Content (CMO) | RoT | Video packaging, audience growth |
| Finance (CFO) | CoT | ROI analysis, unit economics |
| Strategy (CEO) | ToT | Major decisions, long-term vision |
| Critic | Devil's Advocate | Stress-testing, pre-mortem analysis |

### To use forum topics (multi-agent routing):
1. Create a Telegram group with forum/topics enabled
2. Add your bot as admin
3. Create topics: Research, Content, Finance, Strategy, General
4. Send a message in each topic -- check logs for the topic ID numbers
5. Tell me the topic IDs and I'll update `src/agents/base.ts`

### Tell me:
"Use defaults" or "I want to customize agents" or provide your topic IDs.

---

## Phase 5: Test Core Bot (Required, ~2 min)

### What Claude Code does:
- Runs `bun run start` to start the bot manually
- Tells you to send a test message on Telegram
- Verifies the bot responds
- Ctrl+C to stop

### Tell me:
"Start the test" and then confirm if you got a response on Telegram.

---

## Phase 6: Scheduled Services (Optional, ~10 min)

### Smart Check-ins
Proactive messages based on your goals, schedule, and conversation history.

### Morning Briefing
Daily summary with goals, calendar, and optionally AI news.

### What Claude Code does:
- Asks your preferred check-in schedule (or uses defaults from `config/schedule.example.json`)
- Creates `config/schedule.json`
- Generates launchd plist files

### Tell me:
"Set up check-ins and briefings" or "Skip for now"

---

## Phase 7: Always-On (Required after Phase 5, ~5 min)

### What Claude Code does:
- Runs `bun run setup:launchd -- --service all` to generate and load all configured services
- Verifies services are running with `launchctl list | grep com.go`
- Explains how to check logs and restart services

### Tell me:
"Make it always-on"

---

## Phase 8: Optional Integrations (~5 min each)

### Voice Replies (ElevenLabs)
- Text-to-speech for voice message responses
- Requires: ElevenLabs API key + voice ID

### Phone Calls (ElevenLabs + Twilio)
- AI can call you for urgent check-ins
- Requires: ElevenLabs agent + Twilio phone number

### Audio Transcription (Gemini)
- Transcribe voice messages before sending to Claude
- Requires: Google Gemini API key

### Fallback LLM (OpenRouter / Ollama)
- Backup responses when Claude is unavailable
- OpenRouter: cloud fallback (API key)
- Ollama: local fallback (install + run)

### AI News in Briefing (Grok/xAI)
- Real-time AI news from X/Twitter
- Requires: xAI API key

### Tell me:
"Set up [integration name]" with your API keys, or "Skip integrations"

---

## Phase 9: Verification (Required, ~2 min)

### What Claude Code does:
- Runs `bun run setup:verify` for full health check
- Tests all configured services
- Reports pass/fail for each component

### Tell me:
"Run verification"

---

## Project Structure

```
src/
  bot.ts                 # Main relay daemon
  smart-checkin.ts       # Proactive check-ins
  morning-briefing.ts    # Daily briefing
  watchdog.ts            # Health monitor
  lib/                   # Shared utilities
    env.ts               # Environment loader
    telegram.ts          # Telegram helpers
    claude.ts            # Claude Code subprocess
    google-auth.ts       # Google OAuth (keychain + auto-refresh)
    supabase.ts          # Database client
    memory.ts            # Facts, goals, intents
    fallback-llm.ts      # Backup LLM chain
    voice.ts             # ElevenLabs TTS/calls
    transcribe.ts        # Gemini transcription
  agents/                # Multi-agent system
    base.ts              # Agent interface + routing
    index.ts             # Registry
    general.ts           # Orchestrator
    research.ts          # ReAct reasoning
    content.ts           # RoT reasoning
    finance.ts           # CoT reasoning
    strategy.ts          # ToT reasoning
    critic.ts            # Devil's advocate
config/
  profile.md             # User personalization
  schedule.json          # Check-in schedule
  schedule.example.json  # Default schedule template
db/
  schema.sql             # Supabase database schema
setup/
  test-telegram.ts       # Telegram connectivity test
  test-supabase.ts       # Supabase connectivity test
launchd/
  templates/             # Plist templates for services
logs/                    # Service log files
docs/
  troubleshooting.md     # Common issues and fixes
```

## Useful Commands

```bash
# Start bot manually
bun run start

# Run check-in manually
bun run checkin

# Run morning briefing manually
bun run briefing

# Check service status
launchctl list | grep com.go

# View logs
tail -f logs/telegram-relay.log

# Restart a service
launchctl unload ~/Library/LaunchAgents/com.go.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/com.go.telegram-relay.plist

# Full health check
bun run setup:verify
```

## Troubleshooting

See `docs/troubleshooting.md` for common issues and fixes.

### Quick Fixes

**Bot not responding:**
1. Check if the service is running: `launchctl list | grep com.go.telegram-relay`
2. Check logs: `tail -50 logs/telegram-relay.log`
3. Restart: `launchctl unload ~/Library/LaunchAgents/com.go.telegram-relay.plist && launchctl load ~/Library/LaunchAgents/com.go.telegram-relay.plist`

**Claude subprocess failures:**
- JSON responses are often wrapped in ```json``` fences -- the bot strips these automatically
- Always kill subprocesses on timeout to avoid zombie processes
- Check `claude --version` to ensure CLI is still authenticated
- **Key lesson:** Never use Claude subprocesses to fetch data (email, calendar, etc.) from background scripts. Claude initializes all MCP servers on startup (60-180s). Use direct REST APIs instead -- see `src/lib/google-auth.ts` and `docs/architecture.md`

**launchd services not firing on schedule:**
- `StartInterval` pauses during sleep and does NOT catch up
- `StartCalendarInterval` fires immediately after wake if the time was missed
- After editing a plist: unload then load (not just load)

**Supabase connection errors:**
- Verify your keys in `.env` match the Supabase dashboard
- Ensure the `service_role` key is used (not just `anon`) for write operations
- Check that `db/schema.sql` was fully applied (all tables exist)
