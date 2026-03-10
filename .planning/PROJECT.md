# GoBot — Always-On Telegram AI Agent

## What This Is

GoBot is a 24/7 Telegram agent that relays messages to Claude Code and sends back AI responses, running on both a local macOS machine and a cloud VPS. It supports multi-agent workflows (Research, Content, Finance, Strategy, Marketing, COO, CTO, Critic), persistent memory via Convex/Supabase, human-in-the-loop task queues, morning briefings, TwinMind meeting sync, and optional AR glasses integration via OpenClaw. The same codebase runs locally (Claude Code CLI with subscription) and on VPS (Anthropic API pay-per-token).

## Core Value

A always-on AI assistant reachable via Telegram from anywhere, that remembers context, manages goals, and can take real-world actions through MCP servers — without being locked to a single device or session.

## Requirements

### Validated

- ✓ Telegram message relay to Claude Code subprocess (local mode) — v1
- ✓ VPS gateway with webhook mode and Anthropic API — v1
- ✓ Hybrid mode: VPS forwards to local when machine is awake — v1
- ✓ Multi-agent routing (General, Research, Content, Finance, Strategy, Marketing, COO, CTO, Critic) — v1
- ✓ Persistent memory: facts, goals, conversation history via Convex — v1
- ✓ Human-in-the-loop task queue with Telegram inline buttons — v1
- ✓ Morning briefing with pluggable data sources (Gmail, Calendar, Notion, Goals, AI news) — v1
- ✓ Smart check-ins with configurable schedule and quiet hours — v1
- ✓ TwinMind meeting sync → Convex → Telegram summaries — v1
- ✓ Persistent asset storage (images/files) with AI descriptions and semantic search — v1
- ✓ Tiered model routing: Haiku/Sonnet/Opus by message complexity — v1
- ✓ Streaming progress updates on Mac (live tool-use feedback in Telegram) — v1
- ✓ Daily API budget tracking with automatic model downgrade — v1
- ✓ Voice replies via ElevenLabs TTS — v1
- ✓ Phone calls via ElevenLabs + Twilio — v1
- ✓ Audio transcription via Gemini — v1
- ✓ Fallback LLM chain (OpenRouter / Ollama) — v1
- ✓ launchd services on macOS; PM2 on VPS — v1
- ✓ OpenClaw WebSocket gateway for AR glasses (Clawsses) — v1

### Active

- [ ] Agent SDK full integration on VPS (USE_AGENT_SDK=true path — production-ready)
- [ ] Custom data sources for morning briefing (stable plugin API)
- [ ] Improved HITL patterns (more action types beyond ask_user / phone_call)
- [ ] OpenClaw protocol stability and multi-session support
- [ ] Automated testing suite with reasonable coverage

### Out of Scope

- Web UI / dashboard — Telegram is the intentional interface
- Multi-user support — single-owner personal assistant by design
- Native iOS/Android app — Telegram handles mobile interface
- Billing / SaaS infrastructure — personal use tool

## Context

- Owner: Alvin Toh (Singapore). Personal AI assistant for business operations at Straits Interactive.
- Runtime: Bun + TypeScript. Grammy for Telegram. Convex as primary DB (replacing Supabase for some tables).
- Deployment: macOS (launchd) locally + Railway/VPS (PM2) for 24/7 availability.
- MCP: GoBot inherits all MCP servers configured in Claude Code settings, giving it "hands" (email, calendar, Supabase, etc.).
- Community: autonomee/gobot GitHub org — 21 members with Write access. Goda (Alvin) + Sjotie merge to master.
- Current branch: `claude/task/337f9e83`

## Constraints

- **Compatibility**: No breaking changes to message flow or Telegram UX — users rely on this daily
- **Database**: Convex is primary DB; Supabase legacy tables remain for backward compatibility
- **VPS budget**: Default daily API budget $5; Opus→Sonnet downgrade when low
- **Claude ToS**: All Claude usage via official subprocess (`claude -p`) or Anthropic API — no ToS violations
- **Single codebase**: Same code runs local + VPS; feature flags via env vars only

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Grammy over telegraf | Better TypeScript types, active maintenance | ✓ Good |
| Bun over Node | Faster startup, built-in TypeScript, simpler tooling | ✓ Good |
| Convex over pure Supabase | Real-time queries, typed schema, better DX | — Pending (migration ongoing) |
| Same codebase for local+VPS | Simplifies deployment, reduces maintenance surface | ✓ Good |
| Claude subprocess (not direct API) on Mac | Uses subscription, gets full MCP/skills/hooks | ✓ Good |
| Tiered model routing | Reduces API costs ~70% while maintaining quality | ✓ Good |
| Webhook on VPS, polling locally | Polling works behind NAT; webhook needs public URL | ✓ Good |

---
*Last updated: 2026-03-10 after GSD initialization*
