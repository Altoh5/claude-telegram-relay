# Gobot — Always-On AI Telegram Agent

> Claude Code reads this file automatically. Follow the setup phases below.
> Each phase is designed to be completed through conversation with Claude Code.

## Repository & Git Workflow

**Source of truth:** `autonomee/gobot` (GitHub organization repo)

| Repo | Role | Status |
|------|------|--------|
| `autonomee/gobot` | Main repo — all work happens here | Active |
| `godagoo/gobot` | Personal archive (was the original) | Archived, read-only |

### How to make changes (Goda):
```bash
cd ~/development/gobot
# Remote is already set to autonomee/gobot
git pull origin master
# make changes...
git add <files>
git commit -m "description"
git push origin master
```

### How community members contribute:
1. Clone: `git clone https://github.com/autonomee/gobot.git`
2. Create a branch: `git checkout -b fix/my-fix`
3. Push branch: `git push origin fix/my-fix`
4. Open PR on GitHub against `master`
5. Goda reviews and merges

### Access:
- **Autonomee Community team** (21 members) has **Write** access
- Members can push branches and create PRs
- Members **cannot** fork to personal accounts (org setting)
- Only admins (Goda, Sjotie) can merge to `master`

## What This Sets Up

An always-on Telegram agent that:
- Relays your messages to Claude and sends back responses
- **Two processing engines**: Claude Code CLI (local, uses your subscription) or Anthropic API (VPS, pay-per-token). Both are fully compliant with Anthropic's Terms of Service.
- **Hybrid mode**: VPS always on, forwards to local when your machine is awake
- Runs multiple specialized AI agents (Research, Content, Finance, Strategy, Critic)
- **Extensible via MCP**: Connect any MCP servers you use (email, calendar, project management, etc.)
- **Human-in-the-loop**: Claude asks for confirmation via inline buttons before taking actions
- Proactively checks in with smart context awareness
- Sends morning briefings with pluggable data sources (goals, calendar, email, news, tasks)
- Persists memory (facts, goals, conversation history) via Supabase
- Stores images persistently in Supabase Storage with AI-generated descriptions and semantic search
- Survives reboots via launchd (macOS) or PM2 + scheduler (Windows/Linux)
- Falls back to OpenRouter/Ollama when Claude is unavailable
- Optional: voice replies, phone calls, audio transcription

## Prerequisites

Before starting, ensure you have:
- [ ] **macOS, Windows, or Linux**
- [ ] **Bun** runtime installed (`curl -fsSL https://bun.sh/install | bash`)
  - **Important:** After installing Bun, restart your terminal or add Bun to your PATH:
    ```bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    ```
  - To make this permanent, add those two lines to your `~/.zshrc` (macOS) or `~/.bashrc` (Linux)
- [ ] **Claude Code** CLI installed and authenticated (`claude --version`)
- [ ] A **Telegram** account
- [ ] **Windows/Linux only**: PM2 for daemon services (`npm install -g pm2`)

## What to Expect During Setup

Claude Code will ask for permission before running commands or editing files. When you see a permission prompt:
- **"Allow tool access"** — Select "Allow for this session" or "Always allow" to let Claude Code run setup commands
- **macOS "Background Items" popup** — When launchd services start, macOS may show a notification saying *"Software from 'Jared Sumner' can run in the background"*. This is normal — Jared Sumner is the creator of the Bun runtime. Click **Allow** to let the bot services run.

---

## Phase 0: Environment Scan (Automatic, ~1 min)

> **Claude Code: Run this BEFORE starting Phase 1. Always. Even if the user says they're starting fresh.**

### What Claude Code does:

**Step 1 — Ask the user:**

"Have you previously set up a Telegram bot with Claude Code, or any similar AI assistant project? For example, the free mini-course relay, or your own custom setup?"

**Step 2 — Scan regardless of answer:**

Even if the user says "no," run these checks silently. They may have forgotten, or someone else set it up on their machine.

1. **Check if this is a ZIP download (no git):**
   - Check if `.git/` directory exists in the project root
   - If NO `.git/`: this is a ZIP download. Tell the user:
     "This looks like a ZIP download. Run `bun run upgrade` to connect to the official repo — this lets you pull future updates with `git pull` without losing your config."
   - If `.git/` exists: check `git remote get-url origin` — verify it points to `autonomee/gobot`
   - If wrong remote: suggest `bun run upgrade` to fix it

2. **Check for existing `.env` file** in this project directory. If it exists, read it and catalog every variable that has a real value (not a placeholder like `your_bot_token_here`).

3. **Check for other bot projects** on the machine:
   - Look for `~/.claude-relay/` directory (free mini-course relay)
   - Look for `~/claude-telegram-relay/` or any folder matching `*telegram*relay*` in `~/`, `~/Desktop/`, `~/Downloads/`, `~/Documents/`, `~/development/`
   - If found, read their `.env` files for reusable credentials

4. **Check for running services:**
   - macOS: `launchctl list | grep -E "com\.go\.|claude.*relay|telegram"`
   - Linux/Windows: `pm2 list` (if pm2 exists)
   - Report any existing bot services that might conflict

5. **Check for existing Supabase MCP:**
   - Look for `supabase` in Claude Code's MCP configuration
   - If connected, test the connection

6. **Check for existing Supabase tables** (if credentials found):
   - Run `bun run setup/test-supabase.ts` to verify connectivity
   - Query for existing tables: `messages`, `memory`, `logs`, `async_tasks`, `node_heartbeat`, `call_transcripts`
   - Check if data exists in `messages` table (indicates active prior usage)

7. **Check for existing profile:**
   - Look for `config/profile.md` in this project
   - Look for `~/.claude-relay/profile.md` or similar in discovered projects

**Step 3 — Report findings:**

Present a clear summary to the user:

```
ENVIRONMENT SCAN RESULTS

Git connection: ✅ Connected to autonomee/gobot / ⚠️ ZIP download (run: bun run upgrade)
Existing setup found: Yes/No
Source: [this project / claude-telegram-relay at ~/path / other]

✅ Telegram Bot Token — found, valid
✅ Telegram User ID — found
✅ Supabase URL — found
✅ Supabase Anon Key — found
❌ Supabase Service Role Key — missing (needed for GoBot)
✅ User Name — "Sarah"
✅ User Timezone — "Europe/Berlin"
✅ Profile — found at [path]
❌ Anthropic API Key — not set (needed for VPS mode)
❌ Voice/ElevenLabs — not configured
❌ Fallback LLMs — not configured

Supabase tables:
✅ messages (1,247 rows — your history is preserved)
✅ memory (23 rows)
✅ logs (456 rows)
❌ async_tasks — missing (new in GoBot)
❌ node_heartbeat — missing (new in GoBot)

Running services:
⚠️ claude-relay daemon running (will conflict — needs stopping)

RECOMMENDATION:
I can carry over your Telegram, Supabase, and profile settings.
I'll add the missing tables without touching your existing data.
Phases 1-3 can be skipped. Starting at Phase 4 (Agents).
Stop the old relay service first? [Yes/No]
```

**Step 4 — Act on findings:**

- **Reusable credentials found:** Copy them into this project's `.env`. Confirm with the user before overwriting anything. Never delete the source.
- **Existing Supabase with data:** Run `db/schema.sql` which uses `IF NOT EXISTS` — safe for existing tables. Only new tables get created.
- **Conflicting services found:** Ask the user before stopping them. Explain that two bots polling the same Telegram token will cause message conflicts.
- **Profile found:** Offer to copy it to `config/profile.md`. Let user review it first.
- **Nothing found:** Proceed normally from Phase 1. No special handling needed.

**Step 5 — Skip completed phases:**

Based on the scan, tell the user which phases are already done and which remain. Jump directly to the first incomplete phase.

---

## Phase 1: Telegram Bot (Required, ~5 min)

### What you need to do:
1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create your bot
3. Copy the bot token (looks like `123456789:ABCdefGhIjKlMnOpQrStUvWxYz`)
4. Get your Telegram user ID:
   - Click this exact link: **[@userinfobot](https://t.me/userinfobot)** (make sure it says "userinfobot", not "usinfobot" or similar)
   - Send it any message (like "hi") — it immediately replies with your numeric user ID
   - Your user ID is a number like `123456789` (this is NOT your username)
   - **Warning:** There are copycat bots with similar names (like "@usinfobot"). Make sure you open the link above — the correct bot replies instantly with your ID, no menus or buttons

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
   - **Publishable key** (labeled "anon public" or "Publishable" — may start with `eyJ...` or `sb_publishable_...`)
   - **Secret key** (labeled "service_role" or "Secret" — may start with `eyJ...` or `sb_secret_...` — keep this secret!)

### What Claude Code does:
- Saves your Supabase credentials to `.env`
- Opens `db/schema.sql` and runs it in your Supabase SQL editor (you paste it)
- Runs `bun run setup/test-supabase.ts` to verify connectivity

> **WARNING — Existing Supabase data:** If you're using an existing Supabase project that already has data, **do NOT drop or delete any existing tables**. The schema uses `CREATE TABLE IF NOT EXISTS` which safely skips tables that already exist. If Claude Code suggests dropping, restructuring, or recreating tables to resolve a conflict, **say no** — your existing data will be permanently deleted. Instead, create a new separate Supabase project for the bot, or manually add only the missing tables.

> **Upgrading from a previous version?** Just re-run `db/schema.sql` — all statements use `IF NOT EXISTS` and are safe to re-run. New tables (like `assets`) will be created without touching existing data. After running the schema, create a Storage bucket named `gobot-assets` in your Supabase Dashboard (Settings → Storage → New Bucket → Name: "gobot-assets" → Make public).

### Tell me:
"Here are my Supabase keys: URL=[URL], anon=[KEY], service_role=[KEY]"

> **Note:** Supabase recently renamed their keys. "anon public key" is now called "Publishable key" and may start with `sb_publishable_` instead of `eyJ`. Both formats work — just paste whatever your dashboard shows.

---

## Phase 2.5: Semantic Search (Optional, ~5 min)

Enable AI-powered memory search. Without this, the bot still works — it just uses basic text matching instead of understanding meaning.

### What you need:
1. An OpenAI API key from [platform.openai.com](https://platform.openai.com)
2. Supabase MCP already connected (from Phase 2)

### What Claude Code does:
- Stores your OpenAI key as a Supabase secret
- Deploys two edge functions (store-telegram-message, search-memory)
- Runs the match_messages SQL function in your database
- Verifies semantic search works

### Tell me:
"Set up semantic search. My OpenAI key is [your key]" or "Skip" to use basic text search.

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
Daily summary with goals and context from your configured MCP servers.

### What Claude Code does:
- Asks your preferred check-in schedule (or uses defaults from `config/schedule.example.json`)
- Creates `config/schedule.json`
- Generates launchd plist files

### Tell me:
"Set up check-ins and briefings" or "Skip for now"

---

## Phase 6.5: Data Sources (Optional, ~5 min)

### What This Does
Morning briefings pull live data from connected services. Each source auto-enables when its env vars are set — no config files needed.

### Available Sources

| Source | Env Vars Needed | What It Shows |
|--------|----------------|---------------|
| **Goals** | _(always on)_ | Active goals from Supabase/local |
| **AI News** | `XAI_API_KEY` | Top AI news via xAI Grok API |
| **Gmail** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Unread email count + top subjects |
| **Calendar** | _(same Google OAuth)_ | Today's events with times |
| **Notion Tasks** | `NOTION_TOKEN`, `NOTION_DATABASE_ID` | Due and overdue tasks |

### Google OAuth Setup (Gmail + Calendar)
Run the interactive setup script:
```bash
bun run setup/setup-google-oauth.ts
```
This opens your browser, authorizes Gmail + Calendar read access, and saves the tokens to `.env`.

**Prerequisites:** A Google Cloud project with Gmail API and Calendar API enabled. The script walks you through it.

### xAI Grok (AI News)
1. Get an API key from [x.ai](https://x.ai)
2. Add to `.env`: `XAI_API_KEY=your_key`

### Notion Tasks
1. Create a [Notion integration](https://www.notion.so/my-integrations)
2. Share your tasks database with the integration
3. Add to `.env`:
   ```
   NOTION_TOKEN=your_integration_token
   NOTION_DATABASE_ID=your_tasks_database_id
   ```
Your Notion database needs `Due` (date) and `Status` (status with "Done") properties.

### Custom Sources
Copy the template and implement your own:
```bash
cp src/lib/data-sources/sources/custom.example.ts src/lib/data-sources/sources/my-source.ts
```
Then import it in `src/lib/data-sources/sources/index.ts`.

### VPS / Hybrid Note
Data sources use direct REST APIs — no MCP servers needed. They work on VPS, local, and hybrid mode equally.

### Tell me:
"Set up data sources" or list which ones you want, or "Skip"

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
| **Local Only** | Runs on your machine using Claude Code CLI | Claude Pro to get started ($20/mo), Max for full power ($100-200/mo) |
| **VPS** (recommended for 24/7) | Same code on VPS, Claude Code CLI + API key | VPS (~$5/mo) + API costs vary by usage and model selection |
| **Hybrid** | VPS always on, forwards to local when awake | VPS + API costs + subscription |

### How VPS Works — Same Code, Full Power

The key insight: **Claude Code CLI works with an `ANTHROPIC_API_KEY` environment variable.** When set, it uses the Anthropic API (pay-per-token). Without it, Claude Code uses your subscription authentication. Both approaches are compliant — GoBot calls `claude -p` (Claude Code's official subprocess mode), not a third-party API client. You still get ALL Claude Code features:

- **MCP servers** — whatever you've configured (email, calendar, databases, etc.)
- **Skills** — Your custom Claude Code skills (presentations, research, etc.)
- **Hooks** — Pre/post tool execution hooks
- **CLAUDE.md** — Project instructions loaded automatically
- **Built-in tools** — WebSearch, Read, Write, Bash, etc.

This means: **clone the repo on VPS, install Claude Code, set your API key, and run `bun run start`.** Same experience as local. One codebase everywhere.

### Tiered Model Routing

All processing paths now include intelligent model routing that classifies message complexity:

| Tier | Model | When | Response Time |
|------|-------|------|--------------|
| **Haiku** | claude-haiku-4-5 | Greetings, status checks, short questions | 2-5s |
| **Sonnet** | claude-sonnet-4-5 | Medium tasks, unclear complexity | 5-15s |
| **Opus** | claude-opus-4-6 | Research, analysis, strategy, long writing | 15-60s |

- **Mac mode:** Routing is UX-only — all messages use Claude Code subprocess (subscription). Sonnet/Opus tier uses **streaming subprocess** (`--output-format stream-json`) that sends live progress updates to Telegram: which tools are being used, first snippet of Claude's plan. Haiku tier uses standard subprocess (instant response, no progress needed).
- **VPS mode:** Routing selects the actual model. Haiku uses direct API (fast), Sonnet/Opus use Agent SDK when enabled.
- **Budget tracking:** Daily cost limit (`DAILY_API_BUDGET`, default $5). Auto-downgrades Opus→Sonnet when budget runs low.

### VPS Gateway + Agent SDK

The VPS gateway (`src/vps-gateway.ts`) now supports two processing modes:

**Direct API (default):** Anthropic Messages API with 2 tools (ask_user, phone_call). Fast (2-5s) but limited capabilities. Used for all Haiku requests and when Agent SDK is disabled.

**Agent SDK (`USE_AGENT_SDK=true`):** Full Claude Code capabilities on VPS for Sonnet/Opus requests. The Agent SDK spawns a Claude Code subprocess that loads:
- Your `CLAUDE.md` (project instructions)
- Your MCP servers (from Claude Code settings via `settingSources: ["user", "project"]`)
- Your skills and hooks
- Built-in tools (Read, Write, Bash, WebSearch, etc.)
- Session persistence for HITL resume

To enable: set `USE_AGENT_SDK=true` in your VPS `.env`. Requires `@anthropic-ai/claude-agent-sdk` (installed via `bun install`).

### VPS Gateway (Legacy Direct API)

When Agent SDK is disabled (or for Haiku tier), the VPS gateway falls back to direct Anthropic Messages API — no Claude Code overhead. Responds in 2-5s but with limited capabilities (Supabase context only, no MCP servers or skills).

### Hybrid Mode

VPS catches messages 24/7. When your local machine is awake, forward messages there — local uses Claude Code with your subscription, keeping API costs down. When your machine sleeps, VPS handles it with its own Claude Code + API key.

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
# Required for VPS — enables pay-per-token API access (no subscription login needed on headless servers)
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
  ├── MCP Server: [email]      → read, send, reply to emails
  ├── MCP Server: [calendar]   → check schedule, create events
  ├── MCP Server: [databases]  → query tasks, update records
  ├── MCP Server: Supabase     → persistent memory, goals, facts
  ├── MCP Server: [your tools] → whatever MCP servers you connect
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
    claude.ts            # Claude Code subprocess (local mode) + streaming progress
    anthropic-processor.ts  # Anthropic API processor (VPS mode, direct API)
    agent-session.ts     # Agent SDK processor (VPS mode, full Claude Code)
    model-router.ts      # Complexity classifier + tiered model selection
    mac-health.ts        # Local machine health checking (hybrid mode)
    task-queue.ts        # Human-in-the-loop task management
    asset-store.ts       # Persistent image/file storage with AI descriptions
    supabase.ts          # Database client + async tasks + heartbeat
    memory.ts            # Facts, goals, intents
    fallback-llm.ts      # Backup LLM chain
    data-sources/        # Pluggable morning briefing data
      types.ts           # DataSource interface
      registry.ts        # Register, discover, fetch all
      google-auth.ts     # Google OAuth token refresh
      sources/           # Individual data sources
        goals.ts         # Supabase goals (built-in)
        grok-news.ts     # AI news via xAI Grok
        gmail.ts         # Unread emails
        calendar.ts      # Today's events
        notion-tasks.ts  # Due/overdue tasks
        custom.example.ts # Template for custom sources
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
  setup-google-oauth.ts  # Google OAuth token setup (Gmail + Calendar)
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
- **Key lesson:** Never use Claude subprocesses to fetch data (email, calendar, etc.) from background scripts. Claude initializes all MCP servers on startup (60-180s). Use direct REST APIs instead -- see `docs/architecture.md`

**launchd services not firing on schedule:**
- `StartInterval` pauses during sleep and does NOT catch up
- `StartCalendarInterval` fires immediately after wake if the time was missed
- After editing a plist: unload then load (not just load)

**VPS gateway not processing:**
- Check `ANTHROPIC_API_KEY` is set and valid
- Verify Telegram webhook is set: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Check PM2 logs: `pm2 logs go-bot --lines 50`
- For hybrid mode: verify `MAC_HEALTH_URL` is reachable from VPS

**VPS API errors (401/403):**
- If using external APIs on VPS, ensure your tokens/keys are still valid
- Refresh tokens can expire if unused for 6+ months

**Human-in-the-loop buttons not working:**
- Ensure `async_tasks` table exists in Supabase (run `db/schema.sql`)
- Check that the bot has callback_query permissions (BotFather settings)
- Stale tasks auto-remind after 2 hours

**Supabase connection errors:**
- Verify your keys in `.env` match the Supabase dashboard
- Ensure the `service_role` key is used (not just `anon`) for write operations
- Check that `db/schema.sql` was fully applied (all tables exist)

<!-- Updated February 19, 2026: Clarified deployment modes and authentication following Anthropic's January 2026 ToS enforcement. -->
