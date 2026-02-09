# Go — Always-On AI Telegram Bot

An always-on Telegram bot powered by Claude with multi-agent routing, proactive check-ins, persistent memory, voice calls, and morning briefings. Supports three deployment modes: local desktop, cloud VPS, or hybrid (recommended).

**Created by [Goda Go](https://youtube.com/@GodaGo)** | [AI Productivity Hub Community](https://skool.com/ai-productivity-hub)

## What It Does

```
                          ┌── Local Machine (Claude Code CLI, subscription)
You ──▶ Telegram ──▶ Bot ─┤
                          └── VPS (Anthropic API, pay-per-token)
                                  │
                                  ├── Gmail (search, send, reply)
                                  ├── Calendar (list events)
                                  ├── Notion (query tasks, search)
                                  ├── WhatsApp (find chat, send)
                                  ├── Phone Calls (ElevenLabs + Twilio)
                                  └── Human-in-the-Loop (ask before acting)
```

- **Relay**: Send messages on Telegram, get Claude responses back
- **Multi-Agent**: Route messages to specialized agents via Telegram forum topics
- **Memory**: Persistent facts, goals, and conversation history via Supabase
- **Proactive**: Smart check-ins that know when to reach out (and when not to)
- **Briefings**: Daily morning summary with goals, calendar, and AI news
- **Voice**: Text-to-speech replies, voice transcription, and phone calls
- **Human-in-the-Loop**: Claude asks for confirmation via inline buttons before taking actions
- **Hybrid Mode**: VPS catches messages 24/7, forwards to your local machine when it's awake
- **Auto-Deploy**: Push to GitHub, VPS pulls and restarts automatically

## Deployment Modes

| Mode | How It Works | Cost |
|------|-------------|------|
| **Local Only** | Runs on your desktop, uses Claude Code CLI | Free with Claude subscription ($20/mo) |
| **VPS Only** | Runs on a cloud server, uses Anthropic API directly | VPS (~$5/mo) + API tokens (~$3-15/1M tokens) |
| **Hybrid** (recommended) | VPS always on, forwards to local when awake | VPS cost + subscription (API only when local is off) |

### Why Hybrid?

Your laptop sleeps. Your VPS doesn't. With hybrid mode:
- Messages are always processed, even at 3am
- When your local machine is awake, it handles everything (free with subscription)
- When it sleeps, VPS takes over with direct Anthropic API (pay-per-token)
- You get the best of both: always-on reliability + subscription savings

## Quick Start

### Prerequisites

- **macOS, Windows, or Linux**
- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **[Claude Code](https://claude.ai/claude-code)** CLI installed and authenticated
- **Windows/Linux only**: [PM2](https://pm2.keymetrics.io/) for daemon services (`npm install -g pm2`)

### Setup

```bash
# Clone the repo
git clone https://github.com/GodaGo/go-telegram-bot.git
cd go-telegram-bot

# Install dependencies
bun install

# Open with Claude Code — it reads CLAUDE.md and guides you through setup
claude
```

Claude Code reads the `CLAUDE.md` file and walks you through a guided conversation to:

1. Create a Telegram bot via BotFather
2. Set up Supabase for persistent memory
3. Personalize your profile and agents
4. Test the bot
5. Configure always-on services
6. Set up optional integrations (voice, AI news, fallback LLMs)
7. Deploy to VPS (optional)

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Telegram SDK | [grammY](https://grammy.dev) |
| AI (Local) | [Claude Code](https://claude.ai/claude-code) CLI |
| AI (VPS) | [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) |
| Database | [Supabase](https://supabase.com) (PostgreSQL) |
| Always-On | macOS launchd / PM2 + cron / VPS webhook mode |
| Voice (opt.) | [ElevenLabs](https://elevenlabs.io) |
| Phone Calls (opt.) | ElevenLabs + [Twilio](https://twilio.com) |
| Transcription (opt.) | [Google Gemini](https://ai.google.dev) |
| WhatsApp (opt.) | [Unipile](https://unipile.com) |
| AI News (opt.) | [Grok/xAI](https://x.ai) |
| Fallback LLM (opt.) | [OpenRouter](https://openrouter.ai) / [Ollama](https://ollama.ai) |

## Architecture

### Local Mode
```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Telegram    │────▶│  Go Bot      │────▶│  Claude Code    │
│  (grammY)   │◀────│  (polling)   │◀────│  CLI Subprocess │
└─────────────┘     └──────┬───────┘     └─────────────────┘
                           │
                    ┌──────┴───────┐
                    │  Supabase    │
                    │  - Messages  │
                    │  - Memory    │
                    │  - Logs      │
                    └──────────────┘
```

### Hybrid Mode (Recommended)
```
┌───────────┐     ┌─────────────────────────────────────────────┐
│ Telegram  │     │  VPS Gateway (always on, webhook mode)      │
│           │────▶│                                              │
│           │◀────│  Is local machine alive?                     │
└───────────┘     │  ├── YES → forward to local (free)          │
                  │  └── NO  → process with Anthropic API       │
                  │           ├── Gmail tools                    │
                  │           ├── Calendar tools                 │
                  │           ├── Notion tools                   │
                  │           ├── WhatsApp tools                 │
                  │           ├── Phone call tool                │
                  │           └── ask_user (human-in-the-loop)   │
                  │                                              │
                  │  Endpoints:                                  │
                  │  /telegram    — Telegram webhook             │
                  │  /health      — Health check                 │
                  │  /context     — Voice agent context          │
                  │  /webhook/elevenlabs — Post-call transcript  │
                  │  /deploy      — GitHub auto-deploy           │
                  └──────────────────┬──────────────────────────┘
                                     │
                              ┌──────┴───────┐
                              │  Supabase    │
                              │  - Messages  │
                              │  - Memory    │
                              │  - Tasks     │
                              │  - Heartbeat │
                              └──────────────┘
```

## Learn to Build This

Step-by-step video walkthroughs for every module are available in the [AI Productivity Hub](https://skool.com/ai-productivity-hub) community on Skool.

Also in this repo:
- [Architecture Deep Dive](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)

## Commands

```bash
# Local mode
bun run start              # Start bot (polling mode, uses Claude Code CLI)

# VPS mode
bun run vps                # Start VPS gateway (webhook mode, uses Anthropic API)

# Background services
bun run checkin            # Run smart check-in
bun run briefing           # Run morning briefing
bun run watchdog           # Run health check

# Setup & testing
bun run setup              # Install dependencies
bun run setup:launchd      # Configure launchd services (macOS)
bun run setup:services     # Configure services (Windows/Linux)
bun run setup:verify       # Full health check
bun run test:telegram      # Test Telegram connectivity
bun run test:supabase      # Test Supabase connectivity
bun run uninstall          # Remove all services
```

## VPS Hosting

Need a VPS? I recommend [Hostinger](https://hostinger.com?REFERRALCODE=1GODA06) — affordable, reliable, and works great for this bot. Use promo code **GODAGO** for a discount.

## Community

Join the [AI Productivity Hub](https://skool.com/ai-productivity-hub) on Skool for:
- Step-by-step video walkthroughs of every module
- Help with setup and customization
- Share your bot builds and integrations

## License

MIT

---

Built by [Goda Go](https://youtube.com/@GodaGo)
