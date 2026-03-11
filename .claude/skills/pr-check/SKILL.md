---
name: pr-check
description: Run the full PR readiness checklist for gobot — type-check, tests, secrets scan, then draft the PR description.
disable-model-invocation: false
---

Run the gobot PR readiness checklist. Do all steps in order.

## Step 1: Type-check
```bash
npx tsc --noEmit
```
If errors: fix them before continuing.

## Step 2: Run tests
```bash
bun test
```
Report any failures. Do not proceed to PR if tests fail.

## Step 3: Secrets scan
Check that no real secrets are in staged files:
```bash
git diff --cached | grep -E "(sk-ant|eyJ|TELEGRAM_BOT_TOKEN|service_role)" | grep -v ".env.example"
```
If anything matches, flag it immediately and stop.

## Step 4: Summarize changes
Run:
```bash
git log master..HEAD --oneline
git diff master..HEAD --stat
```

## Step 5: Draft PR description
Use this template:

```markdown
## Summary
- [bullet: what changed and why]
- [bullet: key design decision if any]

## Test plan
- [ ] bun test passes
- [ ] npx tsc --noEmit passes
- [ ] Tested manually on Telegram: [describe what you tested]
- [ ] No secrets in diff

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Step 6: Create the PR
```bash
gh pr create --title "<concise title under 70 chars>" --body "<drafted body above>"
```

Return the PR URL when done.
