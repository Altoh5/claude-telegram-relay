# Roadmap

**5 phases** | **15 requirements** | All v1 requirements mapped ✓

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|-----------------|
| 1 | VPS Agent SDK | Production-ready Agent SDK path on VPS | VPS-01..04 | 4 |
| 2 | Testing Foundation | Catch regressions before they reach users | TEST-01..05 | 5 |
| 3 | Data Sources API | Stable, self-discovering briefing plugins | DS-01..03 | 3 |
| 4 | HITL Improvements | Richer human-in-the-loop interaction patterns | HITL-01..03 | 3 |
| 5 | OpenClaw Stability | Reliable AR glasses integration | OC-01..03 | 3 |

---

## Phase 1: VPS Agent SDK

**Goal:** Make the Agent SDK path (`USE_AGENT_SDK=true`) production-ready so VPS processing has full Claude Code capabilities (MCP servers, skills, CLAUDE.md) for Sonnet/Opus requests.

**Requirements:** VPS-01, VPS-02, VPS-03, VPS-04

**Success criteria:**
1. `USE_AGENT_SDK=true` on VPS processes a message using MCP tools (e.g., Supabase query) end-to-end
2. Agent SDK subprocess loads user's CLAUDE.md and reflects its instructions
3. Session resume (`--resume sessionId`) works in Agent SDK path
4. When `@anthropic-ai/claude-agent-sdk` is absent, falls back to direct API without crashing

**Key files:** `src/lib/agent-session.ts`, `src/vps-gateway.ts`

---

## Phase 2: Testing Foundation

**Goal:** Establish a testing baseline so future changes can be made with confidence. Focus on the critical message flow and data layer.

**Requirements:** TEST-01, TEST-02, TEST-03, TEST-04, TEST-05

**Success criteria:**
1. `bun test` passes in CI with no failures
2. Core local message flow test: send mock Telegram message → verify Claude subprocess called → verify response sent
3. VPS gateway test: POST to /process → verify Anthropic API called → verify response
4. Model router: all 3 tiers (haiku/sonnet/opus) correctly classified for representative inputs
5. Convex memory: write fact → read it back → verify match

**Key files:** `src/bot.ts`, `src/vps-gateway.ts`, `src/lib/model-router.ts`, `src/lib/memory.ts`

---

## Phase 3: Data Sources API

**Goal:** Stabilize the morning briefing data source plugin API so community members can add sources without touching core code.

**Requirements:** DS-01, DS-02, DS-03

**Success criteria:**
1. `custom.example.ts` template produces a working data source with zero modification beyond business logic
2. New `.ts` file in `sources/` directory appears in briefing without editing `index.ts`
3. A data source that throws an error produces a `⚠️ [Source] unavailable` line in briefing, not a crash

**Key files:** `src/lib/data-sources/sources/custom.example.ts`, `src/lib/data-sources/registry.ts`, `src/lib/data-sources/sources/index.ts`

---

## Phase 4: HITL Improvements

**Goal:** Make the human-in-the-loop system more expressive — cover action approval, multi-choice, and destructive confirmation patterns that come up in real workflows.

**Requirements:** HITL-01, HITL-02, HITL-03

**Success criteria:**
1. Claude response with `[ACTION: description]` generates an approve/reject button pair
2. `/tasks` Telegram command lists all pending tasks with age
3. Task created >24h ago triggers a "still relevant?" follow-up and auto-cancels if no response after another 24h

**Key files:** `src/lib/task-queue.ts`, `src/bot.ts`, `convex/schema.ts`

---

## Phase 5: OpenClaw Stability

**Goal:** Make the OpenClaw AR glasses gateway reliable enough for daily use — handle multiple sessions, reconnections, and protocol versioning.

**Requirements:** OC-01, OC-02, OC-03

**Success criteria:**
1. Two simulated Clawsses clients connect simultaneously and each receives only their own responses
2. Client disconnects and reconnects — session resumes, no duplicate processing
3. Protocol version mismatch logs a clear error and suggests upgrade path

**Key files:** `src/openclaw-gateway.ts`, `src/lib/openclaw/session-manager.ts`, `src/lib/openclaw/protocol.ts`
