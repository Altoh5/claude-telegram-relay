# Upstream Sync Log

Tracking changes from the original repo (`autonomee/gobot`) that may be relevant.

**Remote:** `upstream` → `git@github.com:autonomee/gobot.git`
**Branch:** `master`
**Last checked commit:** `c3983e5`
**Last checked date:** 2026-02-22

---

## 2026-02-20 — Initial merge (unrelated histories)

Merged upstream/master into local project using `--allow-unrelated-histories`.

Merge commit: `8eea185`
Upstream HEAD at merge: `1770d52` (feat: ZIP-to-git upgrade path for community users)

All upstream commits up to `1770d52` were included in the merge.

---

## 2026-02-22 — Sync #1

Checked commits: `b6635b8`, `c3983e5`

| Commit | Description | Action |
|--------|-------------|--------|
| `b6635b8` | fix: callback buttons, message truncation, and call dedup race | **Ported** |
| `c3983e5` | docs: update ToS language after Anthropic's Feb 19 legal docs update | Skipped — upstream branding/legal language, not relevant to fork |

### Changes ported from `b6635b8`:
- **`src/bot.ts`** — Added handlers for `call_yes`, `call_no`, `dismiss`, `snooze`, `call_request` callback buttons (were silently dropped before because of early `atask:` guard)
- **`src/smart-checkin.ts`** — Increased call proposal message limit from 150 to 500 chars
- **`src/vps-gateway.ts`** — Added 30s delay in transcript poller before processing, letting webhook claim the call first to prevent duplicate messages
