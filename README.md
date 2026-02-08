# Go — Always-On AI Telegram Bot

An always-on Telegram bot powered by Claude Code with multi-agent routing, proactive check-ins, persistent memory, and morning briefings. Built for macOS.

## What It Does

```
You (Telegram) → Go Bot → Claude Code → Response → You (Telegram)
                    ↓
              Multi-Agent System
              ├── Research Agent (ReAct)
              ├── Content Agent (RoT)
              ├── Finance Agent (CoT)
              ├── Strategy Agent (ToT)
              └── Critic Agent (Devil's Advocate)
```

- **Relay**: Send messages on Telegram, get Claude Code responses back
- **Multi-Agent**: Route messages to specialized agents via Telegram forum topics
- **Memory**: Persistent facts, goals, and conversation history via Supabase
- **Proactive**: Smart check-ins that know when to reach out (and when not to)
- **Briefings**: Daily morning summary with goals, calendar, and AI news
- **Always-On**: Survives reboots via macOS launchd services
- **Resilient**: Falls back to OpenRouter/Ollama when Claude is unavailable
- **Voice** (optional): Text-to-speech replies and phone calls via ElevenLabs

## Quick Start

### Prerequisites

- **macOS** (for launchd always-on services)
- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **[Claude Code](https://claude.ai/claude-code)** CLI installed and authenticated

### Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/go-telegram-bot.git
cd go-telegram-bot

# Open with Claude Code
claude

# Claude reads CLAUDE.md and guides you through setup
```

That's it. Claude Code reads the `CLAUDE.md` file and walks you through a guided conversation to:

1. Create a Telegram bot via BotFather
2. Set up Supabase for persistent memory
3. Personalize your profile and agents
4. Test the bot
5. Configure always-on services
6. Set up optional integrations (voice, AI news, fallback LLMs)

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Telegram SDK | [grammY](https://grammy.dev) |
| AI Backend | [Claude Code](https://claude.ai/claude-code) CLI |
| Database | [Supabase](https://supabase.com) (PostgreSQL) |
| Always-On | macOS launchd |
| Voice (opt.) | [ElevenLabs](https://elevenlabs.io) |
| Transcription (opt.) | [Google Gemini](https://ai.google.dev) |
| AI News (opt.) | [Grok/xAI](https://x.ai) |
| Fallback LLM (opt.) | [OpenRouter](https://openrouter.ai) / [Ollama](https://ollama.ai) |

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Telegram    │────▶│  Go Bot      │────▶│  Claude Code    │
│  (grammY)   │◀────│  (Bun)       │◀────│  CLI Subprocess │
└─────────────┘     └──────┬───────┘     └─────────────────┘
                           │
                    ┌──────┴───────┐
                    │  Supabase    │
                    │  - Messages  │
                    │  - Memory    │
                    │  - Logs      │
                    └──────────────┘

┌─────────────────────────────────────┐
│  launchd Services                    │
│  ├── com.go.telegram-relay (daemon)  │
│  ├── com.go.smart-checkin (periodic) │
│  ├── com.go.morning-briefing (daily) │
│  └── com.go.watchdog (hourly)        │
└─────────────────────────────────────┘
```

## Course Modules

This repo doubles as a learning resource. Each module covers one architectural layer:

| # | Module | What You Learn |
|---|--------|---------------|
| 00 | [Prerequisites](docs/00-prerequisites.md) | What you need before starting |
| 01 | [Telegram Setup](docs/01-telegram-setup.md) | BotFather, forum groups, security |
| 02 | [Core Relay](docs/02-core-relay.md) | The relay pattern, Claude subprocess |
| 03 | [Supabase Memory](docs/03-supabase-memory.md) | Persistent memory, conversation history |
| 04 | [Multi-Agent System](docs/04-multi-agent-system.md) | Reasoning frameworks, agent routing |
| 05 | [Smart Check-ins](docs/05-smart-checkins.md) | Proactive AI, context gathering |
| 06 | [Morning Briefing](docs/06-morning-briefing.md) | Data aggregation, formatting |
| 07 | [launchd Always-On](docs/07-launchd-always-on.md) | macOS services, sleep survival |
| 08 | [Optional Integrations](docs/08-optional-integrations.md) | Voice, fallback, extensibility |
| 09 | [Hooks & Security](docs/09-hooks-security.md) | Message redaction, validation |
| 10 | [Customization Guide](docs/10-customization-guide.md) | Add agents, integrations |

Also:
- [Architecture Deep Dive](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)

## Commands

```bash
bun run start              # Start bot manually
bun run checkin            # Run smart check-in
bun run briefing           # Run morning briefing
bun run watchdog           # Run health check
bun run setup              # Install dependencies
bun run setup:launchd      # Configure launchd services
bun run setup:verify       # Full health check
bun run test:telegram      # Test Telegram connectivity
bun run test:supabase      # Test Supabase connectivity
bun run uninstall          # Remove launchd services
```

## License

MIT
