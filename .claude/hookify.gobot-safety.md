---
name: GoBot Safety Rules
description: Protect GoBot development sessions
---

## Rules

### Block rm of logs directory
- event: bash
- pattern: rm\s+-rf?\s+logs/
- action: block
- message: "Blocked: logs/ contains service logs needed for debugging. Delete specific files instead."

### Warn before editing .env
- event: edit
- pattern: \.env$
- action: warn
- message: "Warning: Editing .env will affect live bot credentials. Ensure launchd services are stopped if changing tokens."

### Warn before modifying launchd plists
- event: edit
- pattern: launchd/.*\.plist
- action: warn
- message: "Warning: Editing a plist template. Remember to re-run `bun run setup:launchd` and reload services after changes."

### Warn before editing db/schema.sql
- event: edit
- pattern: db/schema\.sql
- action: warn
- message: "Warning: schema.sql changes affect live Supabase. Use IF NOT EXISTS — never DROP existing tables."

### Block stopping SSH on VPS
- event: bash
- pattern: systemctl\s+(stop|disable)\s+ssh
- action: block
- message: "Blocked: stopping SSH will lock you out of the VPS."
