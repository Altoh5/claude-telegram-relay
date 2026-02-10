# Gobot — Always-On AI Telegram Agent

> Claude Code reads this file automatically. Follow the setup phases below.
> Each phase is designed to be completed through conversation with Claude Code.

## What This Sets Up

An always-on Telegram agent that:
- Relays your messages to Claude and sends back responses
- **Two processing engines**: Claude Code CLI (local, free with subscription) or Anthropic API (VPS, pay-per-token)
- **Hybrid mode**: VPS always on, forwards to local when your machine is awake
- Runs multiple specialized AI agents (Research, Content, Finance, Strategy, Critic)
- **Built-in tools**: Gmail, Calendar, Notion, WhatsApp, phone calls (VPS mode)
- **Human-in-the-loop**: Claude asks for confirmation via inline buttons before taking actions
- Proactively checks in with smart context awareness
- Sends morning briefings with your goals, calendar, and AI news
- Persists memory (facts, goals, conversation history) via Supabase
- Survives reboots via launchd (macOS) or PM2 + scheduler (Windows/Linux)
- Falls back to OpenRouter/Ollama when Claude is unavailable
- Optional: voice replies, phone calls, audio transcription

## Prerequisites

Before starting, ensure you have:
- [ ] **macOS, Windows, or Linux**
- [ ] **Bun** runtime installed (`curl -fsSL https://bun.sh/install | bash`)
- [ ] **Claude Code** CLI installed and authenticated (`claude --version`)
- [ ] A **Telegram** account
- [ ] **Windows/Linux only**: PM2 for daemon services (`npm install -g pm2`)

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
- **macOS**: Runs `bun run setup:launchd -- --service all` to generate and load launchd services
- **Windows/Linux**: Runs `bun run setup:services -- --service all` to configure PM2 + scheduler
- Verifies services are running
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

### Tell me:
"Set up [integration name]" with your API keys, or "Skip integrations"

---

## Phase 9: VPS Deployment (Optional, ~30 min)

### What This Does
Deploy the bot to a cloud VPS so it runs 24/7 without depending on your local machine.

| Mode | How It Works | Cost |
|------|-------------|------|
| **Local Only** | Runs on your desktop, uses Claude Code CLI | Free with Claude subscription |
| **VPS** (recommended for 24/7) | Same `bot.ts` on VPS with Claude Code CLI + `ANTHROPIC_API_KEY` | VPS (~$5/mo) + API tokens |
| **Hybrid** | VPS always on, forwards to local when awake to save on API tokens | VPS cost + subscription |

### How VPS Works — Same Code, Full Power

The key insight: **Claude Code CLI works with an `ANTHROPIC_API_KEY` environment variable.** When set, it uses the Anthropic API (pay-per-token) instead of requiring a browser-based subscription login. But you still get ALL Claude Code features:

- **MCP servers** — Gmail, Calendar, Notion, whatever you've configured
- **Skills** — Your custom Claude Code skills (presentations, research, etc.)
- **Hooks** — Pre/post tool execution hooks
- **CLAUDE.md** — Project instructions loaded automatically
- **Built-in tools** — WebSearch, Read, Write, Bash, etc.

This means: **clone the repo on VPS, install Claude Code, set your API key, and run `bun run start`.** Same experience as local. One codebase everywhere.

### VPS Gateway (Optional Speed Optimization)

For faster responses, the VPS gateway (`src/vps-gateway.ts`) uses the Anthropic Messages API directly — no Claude Code overhead. Responds in 2-5s instead of 10-60s, but with limited capabilities (Supabase context only, no MCP servers or skills). Use this if speed matters more than tool access.

### Hybrid Mode

VPS catches messages 24/7. When your local machine is awake, forward messages there — local uses Claude Code with your subscription (free), keeping API costs down. When your machine sleeps, VPS handles it with its own Claude Code + API key.

### What you need:
1. **A VPS** — Any provider works. [Hostinger](https://hostinger.com?REFERRALCODE=1GODA06) is recommended (promo code **GODAGO** for discount)
2. **Anthropic API key** — From [console.anthropic.com](https://console.anthropic.com)
3. **Claude Code CLI** — Installed on your VPS (`npm install -g @anthropic-ai/claude-code`)

### What Claude Code does:
- Walks you through provisioning and hardening the VPS (SSH keys, UFW, fail2ban)
- Installs Bun and Claude Code CLI
- Clones your repo from GitHub
- Sets up `.env` with `ANTHROPIC_API_KEY` + Supabase credentials
- Configures MCP servers on VPS (same ones you use locally)
- Configures PM2 for process management
- Sets up GitHub webhook for auto-deploy (optional)

### VPS .env setup:
```bash
# Required for VPS — Claude Code uses this instead of subscription
ANTHROPIC_API_KEY=sk-ant-api03-your_key_here

# Same credentials as local
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_USER_ID=your_user_id
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
```

### Tell me:
"Deploy to VPS" and I'll walk you through it.

---

## Phase 10: Verification (Required, ~2 min)

### What Claude Code does:
- Runs `bun run setup:verify` for full health check
- Tests all configured services
- Reports pass/fail for each component

### Tell me:
"Run verification"

---

## Giving Claude "Hands" — MCP Servers & Tool Access

Claude Code on its own is a brain — it can think and reason, but it can't interact
with the outside world. **MCP servers** and **direct APIs** are what give it "hands"
to actually do things:

```
Claude Code (brain)
  │
  ├── MCP Server: Gmail        → read, send, reply to emails
  ├── MCP Server: Calendar     → check schedule, create events
  ├── MCP Server: Notion       → query tasks, update databases
  ├── MCP Server: Supabase     → persistent memory, goals, facts
  ├── MCP Server: [your tools] → whatever you connect
  │
  └── Built-in Tools           → web search, file read, code execution
```

**How to connect MCP servers:** Follow the setup guides for each MCP server you want.
Once configured in your Claude Code settings, the bot automatically has access to them
because it spawns Claude Code subprocesses that inherit your MCP configuration.

**Local mode:** Claude Code CLI uses your MCP servers directly.
**VPS mode:** Uses Anthropic API with Supabase context. External service access
happens when your local machine handles the message (hybrid mode).

## Project Structure

```
src/
  bot.ts                 # Main relay daemon (local mode, polling)
  vps-gateway.ts         # VPS gateway (webhook mode, Anthropic API)
  smart-checkin.ts       # Proactive check-ins
  morning-briefing.ts    # Daily briefing
  watchdog.ts            # Health monitor
  lib/                   # Shared utilities
    env.ts               # Environment loader
    telegram.ts          # Telegram helpers
    claude.ts            # Claude Code subprocess (local mode)
    anthropic-processor.ts  # Anthropic API processor (VPS mode)
    mac-health.ts        # Local machine health checking (hybrid mode)
    task-queue.ts        # Human-in-the-loop task management
    supabase.ts          # Database client + async tasks + heartbeat
    memory.ts            # Facts, goals, intents
    fallback-llm.ts      # Backup LLM chain
    voice.ts             # ElevenLabs TTS/calls/context
    transcribe.ts        # Gemini transcription (file + buffer)
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
deploy.sh               # Auto-deploy script (VPS)
setup/
  install.ts             # Prerequisites checker + installer
  configure-launchd.ts   # macOS launchd plist generator
  configure-services.ts  # Windows/Linux PM2 + scheduler
  verify.ts              # Full health check
  test-telegram.ts       # Telegram connectivity test
  test-supabase.ts       # Supabase connectivity test
  uninstall.ts           # Clean removal (cross-platform)
launchd/
  templates/             # Plist templates for services (macOS)
logs/                    # Service log files
docs/
  architecture.md        # Architecture deep dive
  troubleshooting.md     # Common issues and fixes
```

## Useful Commands

```bash
# Local mode (polling, uses Claude Code CLI)
bun run start

# VPS mode (webhook, uses Anthropic API directly)
bun run vps

# Run check-in manually
bun run checkin

# Run morning briefing manually
bun run briefing

# Full health check
bun run setup:verify

# --- macOS ---
launchctl list | grep com.go                           # Check service status
launchctl unload ~/Library/LaunchAgents/com.go.telegram-relay.plist  # Stop
launchctl load ~/Library/LaunchAgents/com.go.telegram-relay.plist    # Start

# --- VPS (PM2) ---
pm2 start src/vps-gateway.ts --name go-bot --interpreter bun  # Start
pm2 status                         # Check service status
pm2 restart go-bot                 # Restart
pm2 logs go-bot --lines 50        # View logs

# --- Windows/Linux (local mode with PM2) ---
npx pm2 status                      # Check service status
npx pm2 restart go-telegram-relay   # Restart a service
npx pm2 logs                        # View logs
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

**VPS gateway not processing:**
- Check `ANTHROPIC_API_KEY` is set and valid
- Verify Telegram webhook is set: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Check PM2 logs: `pm2 logs go-bot --lines 50`
- For hybrid mode: verify `MAC_HEALTH_URL` is reachable from VPS

**VPS Google API errors (401/403):**
- Refresh tokens expire if unused for 6+ months -- re-export from your Mac
- Run `bun run setup/export-tokens.ts` on your Mac to get fresh tokens
- Verify `GMAIL_REFRESH_TOKEN` and `WORKSPACE_REFRESH_TOKEN` in VPS `.env`

**Human-in-the-loop buttons not working:**
- Ensure `async_tasks` table exists in Supabase (run `db/schema.sql`)
- Check that the bot has callback_query permissions (BotFather settings)
- Stale tasks auto-remind after 2 hours

**Supabase connection errors:**
- Verify your keys in `.env` match the Supabase dashboard
- Ensure the `service_role` key is used (not just `anon`) for write operations
- Check that `db/schema.sql` was fully applied (all tables exist)
