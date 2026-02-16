# Gobot Changelog

## v2.5.0 — 2026-02-16

**Reliability & VPS Hardening**

Six bugs fixed that were discovered in production, plus VPS documentation improvements.

### Bug Fixes
- **ElevenLabs voice calls fail on empty context** — `buildVoiceAgentContext()` and `initiatePhoneCall()` now provide fallback text when Supabase returns empty memory, chat history, or goals. Previously, ElevenLabs received empty dynamic variables and the agent had no context.
- **Call transcripts sent twice** — Added `processedCallIds` dedup set. Both the polling loop and webhook handler now check before processing, so only the first one to complete sends the summary.
- **Morning briefing sent twice** — Added dedup check using `lastBriefingDate` in `checkin-state.json`. If a briefing was already sent today (e.g. after sleep/wake catch-up), it skips.
- **Phantom DONE/CANCEL tags** — Intent detection now requires minimum 5 characters for `[DONE:]` and `[CANCEL:]` tags, preventing vague matches. All intent processing is logged for visibility.
- **Bot promises to fix itself** — Added LIMITATIONS section to both system prompts (direct API + Agent SDK) explicitly telling Claude it cannot modify its own code, restart services, or debug itself.
- **AI news hallucinated** — Grok news source: temperature set to 0, search mode forced to `"on"`, system prompt requires source links. Response is now validated for search citations — if none found, returns "quiet day" instead of hallucinated news.

### Improvements
- **API budget default raised to $15** — `.env.example` now recommends $15 and includes budget guidance ($5 light / $15 moderate / $50+ heavy).
- **deploy.sh is PM2-aware** — Checks for PM2 and uses `pm2 restart` when available, falls back to `nohup` otherwise. No more conflict between PM2 process management and deploy script.
- **DONE tag instructions tightened** — System prompt now instructs Claude to only use `[DONE:]` when the user explicitly states completion, and to use the full goal text.
- **Added `gobot-master/` to .gitignore** — Prevents accidental commits of stale directory copies.

### Documentation
- **VPS Hardening section** in `docs/troubleshooting.md`:
  - fail2ban lockout recovery (how to unban via hosting panel)
  - SSH key best practices (no passphrase for server keys, IdentitiesOnly)
  - UFW firewall rules for the bot
  - API budget guidance with cost tiers

### Updated Files
- `src/lib/voice.ts` — Fallback context + logging for empty Supabase data
- `src/vps-gateway.ts` — `processedCallIds` dedup for polling + webhook
- `src/morning-briefing.ts` — Dedup check via `checkin-state.json`
- `src/lib/memory.ts` — Min 5-char requirement + logging for DONE/CANCEL tags
- `src/lib/anthropic-processor.ts` — LIMITATIONS section in system prompt, tightened DONE instructions
- `src/lib/agent-session.ts` — LIMITATIONS section in Agent SDK system prompt
- `src/lib/data-sources/sources/grok-news.ts` — Temp 0, search forced on, citation validation
- `.env.example` — Budget raised to $15, added usage guidance
- `deploy.sh` — PM2-aware restart
- `docs/troubleshooting.md` — VPS hardening section
- `.gitignore` — Added `gobot-master/`

### Compatibility
- Fully backward compatible. No config changes required.
- Existing `.env` files with `DAILY_API_BUDGET=5.00` continue to work (the change is only in `.env.example` for new setups).

---

## v2.3.0 — 2026-02-12

**Call-to-Task Auto-Execution**

- **Auto-task from calls** — When you end a phone call with the bot, it now detects actionable tasks in the transcript (e.g. "create a presentation", "research X") and automatically starts executing them. You'll see a "Starting task from call" notification followed by live progress updates in Telegram.
- **Works everywhere** — Task auto-execution routes through the same hybrid pipeline: Mac-local (Claude Code, free) when awake, VPS (Anthropic API) when offline.
- **Call summary improvements (Mac)** — Mac-initiated calls now get a proper summary sent to Telegram (previously only saved transcript silently).

### Updated
- `src/lib/voice.ts` — Added `extractTaskFromTranscript()` using Haiku for fast, cheap task detection
- `src/vps-gateway.ts` — Added `executeCallTask()` + `processCallTaskOnVPS()`, wired into both webhook and polling transcript paths
- `src/bot.ts` — Mac call handler now summarizes transcripts and auto-executes detected tasks via `callClaudeAndReply()`

### Compatibility
- Fully backward compatible. No config changes required.
- Requires `ANTHROPIC_API_KEY` for task extraction (uses Haiku). Without it, calls work as before (summary only, no auto-execution).

---

## v2.2.0 — 2026-02-12

**Persistent Image Storage + Formatting Fixes**

- **Persistent image storage** — Photos sent to the bot are now stored in Supabase Storage with AI-generated descriptions, tags, and optional semantic search via embeddings. Images survive restarts and can be recalled later.
- **Image cataloguing** — Claude automatically generates a structured description and tags for each image using the `[ASSET_DESC]` tag format, stored in the `assets` table.
- **Semantic image search** — With an OpenAI API key, images get vector embeddings for similarity search via the `match_assets` RPC function.
- **VPS photo support** — VPS gateway now handles photos: forwards to Mac when online, processes with Haiku vision when offline.
- **Hybrid photo forwarding** — `/process` endpoint on Mac now accepts `photoFileId` from VPS for local processing with Claude Code.
- **Markdown bold fix** — `**bold**` text now correctly renders as bold in Telegram (converted to `*bold*`).
- **Streaming progress for all message types** — Voice messages, photos, and documents now get the same live progress updates as text messages. Complex tasks show real-time tool usage regardless of how you send them.

### New Files
- `src/lib/asset-store.ts` — Upload, describe, search, and manage persistent image/file assets

### Updated
- `db/schema.sql` — Added `assets` table with pgvector embeddings, indexes, RLS policies, and `match_assets` RPC
- `src/bot.ts` — Restructured photo handler with asset persistence, added IMAGE CATALOGUING prompt, expanded `/process` endpoint for photo forwarding
- `src/vps-gateway.ts` — Added `message:photo` handler (Mac-forward + VPS-fallback), bold conversion in `sendResponse()`
- `src/lib/telegram.ts` — Added `**bold**` → `*bold*` conversion in `sendResponse()`
- `.env.example` — Added note about embedding use of `OPENAI_API_KEY`
- `CLAUDE.md` — Documented image persistence, upgrade instructions, project structure update

### Upgrade Instructions
1. `git pull && bun install`
2. Re-run `db/schema.sql` in Supabase SQL editor (safe — uses `IF NOT EXISTS`)
3. Create a Storage bucket named `gobot-assets` in Supabase Dashboard (Settings → Storage → New Bucket → public)
4. Optional: Set `OPENAI_API_KEY` in `.env` for semantic image search

### Compatibility
- Fully backward compatible. No config changes required.
- Photos work without `OPENAI_API_KEY` — semantic search is optional.
- Existing Supabase data is untouched.

---

## v2.1.0 — 2026-02-12

**Smart Routing + Streaming Progress + Agent SDK**

- **Tiered model routing** — Messages auto-classified by complexity: Haiku (simple, fast, cheap), Sonnet (medium), Opus (complex, powerful). ~60% of messages route to Haiku, saving 50-60% on VPS API costs.
- **Streaming progress updates (Mac)** — Complex tasks show real-time progress in Telegram: which tools are being used, Claude's initial plan. Progress updates in-place and disappears when done. Simple messages respond instantly.
- **Agent SDK on VPS (optional)** — Full Claude Code capabilities for Sonnet/Opus VPS requests. Loads your MCP servers, skills, hooks, and CLAUDE.md. Enable with `USE_AGENT_SDK=true`.
- **Human-in-the-loop everywhere** — Inline button confirmations work consistently across Mac (subprocess resume), VPS direct API (messages snapshot), and VPS Agent SDK (session resume).
- **Daily budget tracking (VPS)** — Set `DAILY_API_BUDGET` to cap daily spend. Auto-downgrades Opus→Sonnet when budget runs low.

### New Files
- `src/lib/model-router.ts` — Complexity classifier + tiered model selection
- `src/lib/agent-session.ts` — Agent SDK wrapper for VPS mode

### Updated
- `src/lib/claude.ts` — Added `callClaudeStreaming()` with JSONL parsing and progress callbacks
- `src/bot.ts` — Streaming progress for complex messages, model tier routing
- `src/vps-gateway.ts` — Tiered routing: Haiku→direct API, Sonnet/Opus→Agent SDK
- `src/lib/anthropic-processor.ts` — Accepts optional model parameter
- `.env.example` — Added `USE_AGENT_SDK`, `DAILY_API_BUDGET`
- `CLAUDE.md` — Documented tiered routing, Agent SDK, streaming progress

### Compatibility
- Fully backward compatible. No config changes required.
- Local-only: `git pull && bun install` — new features work automatically.
- VPS: model routing active immediately. Agent SDK is opt-in.

---

## v2.0.0 — 2026-02-09

**VPS Gateway + Hybrid Mode**

- VPS gateway mode (`bun run vps`) — Anthropic Messages API with built-in tools
- Hybrid mode — VPS forwards to local machine when awake, processes directly when offline
- Human-in-the-loop tools: ask user confirmation, phone calls
- Human-in-the-loop — Claude asks confirmation via inline Telegram buttons before acting
- Voice on VPS — transcription, TTS replies, and outbound phone calls
- Auto-deploy via GitHub webhook
- Local machine health checking with heartbeat failover

### New Files
- `src/vps-gateway.ts` — VPS entry point (webhook mode)
- `src/lib/anthropic-processor.ts` — Anthropic API with tool definitions
- `src/lib/mac-health.ts` — Local machine health checking
- `src/lib/task-queue.ts` — Human-in-the-loop task management
- `deploy.sh` — Auto-deploy script

### Updated
- `src/lib/voice.ts` — Added transcript summarization + voice agent context
- `src/lib/transcribe.ts` — Added buffer-based transcription for VPS
- `src/lib/supabase.ts` — Added async tasks + node heartbeat functions
- `db/schema.sql` — Added async_tasks + node_heartbeat tables
- `.env.example` — Full VPS/hybrid mode documentation

---

## v1.0.0 — 2026-01-15

**Core Relay + Multi-Agent System**

- Telegram relay with Claude Code CLI subprocess
- 6 specialized AI agents (General, Research, Content, Finance, Strategy, Critic)
- Forum topic routing for multi-agent system
- Persistent memory via Supabase (facts, goals, conversation history)
- Smart check-ins with context-aware decision making
- Morning briefings with goals and MCP server context
- Always-on services via launchd (macOS) / PM2 (Windows/Linux)
- Fallback LLM chain: Claude → OpenRouter → Ollama
- Voice replies (ElevenLabs TTS)
- Phone calls (ElevenLabs + Twilio)
- Audio transcription (Gemini)
- Cross-platform support (macOS, Windows, Linux)
