# Gobot Changelog

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
- Morning briefings with goals, calendar, AI news
- Always-on services via launchd (macOS) / PM2 (Windows/Linux)
- Fallback LLM chain: Claude → OpenRouter → Ollama
- Voice replies (ElevenLabs TTS)
- Phone calls (ElevenLabs + Twilio)
- Audio transcription (Gemini)
- Cross-platform support (macOS, Windows, Linux)
