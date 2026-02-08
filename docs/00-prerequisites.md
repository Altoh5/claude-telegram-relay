# Module 0: Prerequisites

> Before you begin building, make sure your environment is ready.
> This module covers every tool and account you need.

---

## Why macOS?

This project uses **macOS launchd** to keep the bot running 24/7. launchd is the
native macOS service manager -- it starts your bot at login, restarts it if it
crashes, and runs scheduled tasks (check-ins, morning briefings) reliably.

There is no equivalent single command on Linux (`systemd` is close but different)
or Windows. The plist templates in `launchd/` and the setup script at
`setup/configure-launchd.ts` are macOS-specific.

**If you are on Linux**, you could adapt the project to use systemd unit files
instead of plist files, but that is not covered by the setup scripts.

**Minimum macOS version:** Any version that supports launchd (macOS 10.4+).
In practice, you want macOS 12+ for good Bun compatibility.

---

## Required: Bun Runtime

Bun is the JavaScript/TypeScript runtime used throughout this project.
It is chosen over Node.js for its speed, built-in TypeScript support,
and native `Bun.spawn()` for subprocess management.

### Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### Verify

```bash
bun --version
# Should output 1.0.0 or higher
```

The project requires Bun >= 1.0.0 (see `package.json` `engines` field).

---

## Required: Claude Code CLI

Claude Code is the AI engine behind the bot. The bot spawns `claude` as a
subprocess for every message (see `src/lib/claude.ts`). You need the CLI
installed and authenticated.

### Install

```bash
npm install -g @anthropic-ai/claude-code
```

### Authenticate

```bash
claude
# Follow the browser-based OAuth flow
```

### Verify

```bash
claude --version
# Should output a version string
claude -p "Hello" --output-format text
# Should return a response from Claude
```

If the `claude` binary is not on your PATH, you can set `CLAUDE_PATH` in
your `.env` file to point to its absolute location.

---

## Required: Telegram Account

You need a Telegram account to create a bot and receive messages.
If you do not have one, download the Telegram app on your phone
and create an account with your phone number.

You will also need:
- **Your user ID** (a numeric ID, not your username)
- **A bot token** (from BotFather)

These are covered in detail in [Module 1: Telegram Setup](./01-telegram-setup.md).

---

## Required: Supabase Account (Free Tier)

Supabase provides the persistent database for conversation history,
memory (facts and goals), and structured logging.

### Create an Account

1. Go to [supabase.com](https://supabase.com)
2. Sign up with GitHub or email
3. Create a new project (any name, choose a region close to you)
4. Wait for the project to initialize (~2 minutes)

### What You Need

From your Supabase project dashboard (Settings > API):

| Value | Where to Find | Example |
|-------|---------------|---------|
| Project URL | Settings > API > Project URL | `https://abc123.supabase.co` |
| anon public key | Settings > API > anon public | `eyJhbGci...` |
| service_role key | Settings > API > service_role | `eyJhbGci...` |

The **service_role key** bypasses Row Level Security and is used by the bot
for write operations. Keep it secret -- never commit it to git.

Database setup is covered in [Module 3: Supabase Memory](./03-supabase-memory.md).

---

## Optional: ElevenLabs Account

Enables two features:
- **Voice replies**: The bot can respond to voice messages with audio (TTS)
- **Phone calls**: The bot can call you via Twilio integration

You need:
- ElevenLabs API key
- A voice ID (choose or clone a voice in their dashboard)
- For calls: an ElevenLabs agent ID and Twilio phone number ID

See [Module 8: Optional Integrations](./08-optional-integrations.md) for setup.

---

## Optional: Google Gemini API Key

Enables **voice message transcription**. When someone sends a voice message
on Telegram, the bot downloads the audio, sends it to Gemini for
transcription, then sends the text to Claude for processing.

Get a free API key at [ai.google.dev](https://ai.google.dev).

See `src/lib/transcribe.ts` for implementation details.

---

## Optional: xAI (Grok) API Key

Enables **AI news in morning briefings**. The bot queries Grok with
real-time X/Twitter search to find the latest AI news.

Get an API key at [x.ai](https://x.ai).

See `src/morning-briefing.ts` lines 110-160 for implementation.

---

## Optional: OpenRouter API Key

Provides a **cloud fallback** when Claude Code is unavailable (auth failures,
rate limits, timeouts). OpenRouter proxies requests to models like
Moonshot Kimi, GPT-4, Llama, and others.

Get an API key at [openrouter.ai](https://openrouter.ai).

The default fallback model is `moonshotai/kimi-k2.5` (configurable via
`OPENROUTER_MODEL` in `.env`).

---

## Optional: Ollama (Local LLM)

Provides a **local fallback** when both Claude and OpenRouter are unavailable.
Ollama runs LLMs on your own machine -- no API key needed.

### Install

```bash
brew install ollama
ollama serve
ollama pull qwen3-coder
```

The default local model is `qwen3-coder` (configurable via `OLLAMA_MODEL`
in `.env`). See `src/lib/fallback-llm.ts` for the fallback chain logic.

---

## Quick Verification

After installing the required tools, run the setup script:

```bash
cd /path/to/go-telegram-bot
bun run setup
```

This runs `setup/install.ts` which:
1. Checks your platform is macOS
2. Verifies Bun is installed
3. Checks for Claude CLI
4. Installs npm dependencies
5. Creates required directories (`logs/`, `temp/`, `uploads/`, `config/`)
6. Creates `.env` from `.env.example` if it does not exist

---

## Environment Variables Reference

All variables are listed in `.env.example`. The required ones are:

```
TELEGRAM_BOT_TOKEN=     # From BotFather
TELEGRAM_USER_ID=       # Your numeric Telegram user ID
SUPABASE_URL=           # Your Supabase project URL
SUPABASE_ANON_KEY=      # Your Supabase anon key
```

Everything else is optional. See `.env.example` for the full list.

---

**Next module:** [01 - Telegram Setup](./01-telegram-setup.md)
