# Requirements

## v1 Requirements (Active Milestone)

### Agent SDK & VPS Processing

- [ ] **VPS-01**: Agent SDK path (`USE_AGENT_SDK=true`) handles Sonnet/Opus requests end-to-end without errors
- [ ] **VPS-02**: Agent SDK subprocess loads CLAUDE.md, MCP servers, and skills from user's Claude Code config
- [ ] **VPS-03**: Session persistence works across Agent SDK calls (resume with session ID)
- [ ] **VPS-04**: Agent SDK falls back gracefully to direct API when SDK unavailable

### Testing

- [ ] **TEST-01**: Core message flow (bot.ts → claude.ts → telegram response) has integration test
- [ ] **TEST-02**: VPS gateway message processing has integration test
- [ ] **TEST-03**: Model router classification has unit tests for all tiers
- [ ] **TEST-04**: Memory read/write (Convex) has integration tests
- [ ] **TEST-05**: HITL task queue (create → button tap → resume) has integration test

### Data Sources

- [ ] **DS-01**: Custom data source plugin API is documented and stable (custom.example.ts → production-ready)
- [ ] **DS-02**: Data sources auto-discover from sources/ directory without manual registration
- [ ] **DS-03**: Each data source handles auth failures gracefully (no briefing crash)

### HITL Improvements

- [ ] **HITL-01**: Action button types beyond ask_user (approve_action, pick_option, confirm_destructive)
- [ ] **HITL-02**: Pending tasks visible via `/tasks` Telegram command
- [ ] **HITL-03**: Tasks auto-expire after 24h with notification

### OpenClaw Stability

- [ ] **OC-01**: Multi-session support (multiple AR glasses connected simultaneously)
- [ ] **OC-02**: Reconnection handling (glasses disconnect/reconnect without losing session)
- [ ] **OC-03**: Protocol version negotiation documented

## v2 Requirements (Future)

- Advanced goal tracking with progress percentages and milestones
- Proactive goal nudges based on deadline proximity
- Webhook signature verification for VPS security hardening
- Rate limiting per Telegram user (not just per-IP)
- Automated dependency update PRs

## Out of Scope

- Web UI / dashboard — Telegram is the intentional interface; adding a web UI would duplicate it
- Multi-user support — single-owner design; multi-user would require auth, billing, isolation
- Native mobile app — Telegram handles all mobile UX needs
- SaaS infrastructure — this is a personal productivity tool, not a product

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| VPS-01..04 | Phase 1: VPS Agent SDK | Pending |
| TEST-01..05 | Phase 2: Testing | Pending |
| DS-01..03 | Phase 3: Data Sources | Pending |
| HITL-01..03 | Phase 4: HITL | Pending |
| OC-01..03 | Phase 5: OpenClaw | Pending |
