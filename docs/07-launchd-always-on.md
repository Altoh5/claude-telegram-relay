# Module 7: launchd Always-On

> This module explains how launchd keeps your bot running 24/7 on macOS,
> survives reboots, and handles scheduled tasks reliably.

---

## Why launchd (Not cron, Not pm2)

| Option | Problem |
|--------|---------|
| **cron** | Does not restart crashed processes. No `KeepAlive`. Poor sleep handling. |
| **pm2** | Requires Node.js. Extra dependency. Not native to macOS. |
| **systemd** | Linux only. Not available on macOS. |
| **launchd** | macOS native. Survives reboot. Auto-restart. Sleep-aware scheduling. |

launchd is the macOS init system. It starts at boot, manages services,
and provides features specifically designed for always-on processes.

---

## Key Concept: StartCalendarInterval vs StartInterval

This is the single most important thing to understand about launchd scheduling:

### StartInterval

Fires every N seconds. **Pauses during sleep** and does **not** catch up.

```xml
<key>StartInterval</key>
<integer>3600</integer>  <!-- Every hour -->
```

If your Mac sleeps from 1pm to 3pm and the interval was supposed to fire
at 2pm, that execution is **lost forever**. After wake, it waits another
full interval before firing.

### StartCalendarInterval

Fires at specific times. **Catches up after wake** if the time was missed.

```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
</dict>
```

If your Mac sleeps through 9:00 AM and wakes at 9:15, this fires
**immediately** upon wake. This is critical for morning briefings and
check-ins that should not be silently skipped.

**Rule of thumb:** Always use `StartCalendarInterval` for scheduled tasks.
Use `KeepAlive` + `RunAtLoad` for long-running daemons.

---

## The Four Services

### 1. telegram-relay (Main Bot)

**Template:** `launchd/com.go.telegram-relay.plist.template`
**Strategy:** `KeepAlive` + `RunAtLoad`

```xml
<key>RunAtLoad</key>
<true/>
<key>KeepAlive</key>
<true/>
<key>ThrottleInterval</key>
<integer>10</integer>
```

- Starts at login
- Restarts if it crashes (with 10-second throttle to prevent rapid restart loops)
- Runs continuously -- this is the main bot process

### 2. smart-checkin (Proactive Messages)

**Template:** `launchd/com.go.smart-checkin.plist.template`
**Strategy:** `StartCalendarInterval` with multiple entries

```xml
<key>StartCalendarInterval</key>
<array>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>30</integer></dict>
    <!-- ... more intervals ... -->
</array>
```

Each interval is a separate dict in the array. The script runs, makes a
decision, sends a message (or not), and exits. It does not stay running.

`KeepAlive` is set to `SuccessfulExit: false`, meaning it only restarts
if the script crashes (non-zero exit), not after a normal completion.

### 3. morning-briefing (Daily Summary)

**Template:** `launchd/com.go.morning-briefing.plist.template`
**Strategy:** `StartCalendarInterval` at a fixed time

```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
</dict>
```

Runs once daily at the configured time. Because it uses
`StartCalendarInterval`, it catches up if your Mac was asleep at 9 AM.

### 4. watchdog (Health Monitor)

**Template:** `launchd/com.go.watchdog.plist.template`
**Strategy:** `StartCalendarInterval` every hour

```xml
<key>StartCalendarInterval</key>
<array>
    <dict><key>Minute</key><integer>0</integer></dict>
</array>
```

Runs every hour on the hour. Checks if the smart-checkin service
has run recently. If not, sends an alert via Telegram.

This is the "service that monitors services" -- a watchdog pattern.

---

## Template System

The plist templates live in `launchd/` and use `{{PLACEHOLDER}}` syntax:

| Placeholder | Replaced With |
|-------------|---------------|
| `{{BUN_PATH}}` | Absolute path to bun binary |
| `{{HOME}}` | User's home directory |
| `{{PROJECT_ROOT}}` | Absolute path to the project |
| `{{BUN_DIR}}` | Directory containing bun |
| `{{CLAUDE_DIR}}` | Directory containing claude CLI |
| `{{CALENDAR_INTERVALS}}` | Generated from schedule.json |
| `{{BRIEFING_HOUR}}` | Morning briefing hour |
| `{{BRIEFING_MINUTE}}` | Morning briefing minute |

The `setup/configure-launchd.ts` script:
1. Reads the template
2. Resolves paths (`which bun`, `which claude`)
3. Loads schedule from `config/schedule.json`
4. Replaces all placeholders
5. Writes the final plist to `~/Library/LaunchAgents/`
6. Unloads any existing version
7. Loads the new plist

---

## Service Management

### Install/Update All Services

```bash
bun run setup:launchd -- --service all
```

### Install a Single Service

```bash
bun run setup:launchd -- --service telegram-relay
bun run setup:launchd -- --service smart-checkin
bun run setup:launchd -- --service morning-briefing
bun run setup:launchd -- --service watchdog
```

### Check Status

```bash
launchctl list | grep com.go
```

Output columns: PID, last exit code, label.

```
1234    0    com.go.telegram-relay
-       0    com.go.smart-checkin
-       0    com.go.morning-briefing
-       0    com.go.watchdog
```

- A PID number means the service is currently running
- `-` for PID means it is loaded but not currently running (normal for scheduled tasks)
- Exit code `0` means the last run succeeded
- Non-zero exit code means the last run failed

### Restart a Service

```bash
launchctl unload ~/Library/LaunchAgents/com.go.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/com.go.telegram-relay.plist
```

**Important:** Always unload before loading. Just running `load` on an
already-loaded service will fail silently.

### Force-Run a Scheduled Service

```bash
launchctl kickstart gui/$(id -u)/com.go.smart-checkin
```

This runs the service immediately, regardless of its schedule.

### Unload All Services

```bash
bun run uninstall
```

---

## Log File Locations

Each service writes to two log files:

| Service | stdout | stderr |
|---------|--------|--------|
| telegram-relay | `logs/telegram-relay.log` | `logs/telegram-relay.error.log` |
| smart-checkin | `logs/smart-checkin.log` | `logs/smart-checkin.error.log` |
| morning-briefing | `logs/morning-briefing.log` | `logs/morning-briefing.error.log` |
| watchdog | `logs/watchdog.log` | `logs/watchdog.error.log` |

View logs in real time:

```bash
tail -f logs/telegram-relay.log
tail -f logs/*.log  # All logs at once
```

---

## Debugging

### Service Not Starting

1. Check the plist is valid XML:
   ```bash
   plutil ~/Library/LaunchAgents/com.go.telegram-relay.plist
   ```
2. Check paths in the plist are absolute and correct
3. Check the bun path exists: `which bun`
4. Check the project root exists

### Service Keeps Restarting

Check the error log for the service:
```bash
tail -50 logs/telegram-relay.error.log
```

Common causes:
- Missing `.env` file
- Invalid bot token
- Missing dependencies (`bun install`)
- Port already in use (health server)

### Scheduled Task Not Firing

1. Verify the service is loaded: `launchctl list | grep com.go`
2. Check the schedule in the plist file
3. Remember: `StartInterval` does **not** catch up after sleep
4. Force-run to test: `launchctl kickstart gui/$(id -u)/com.go.smart-checkin`

---

## The Watchdog Pattern

The watchdog (`src/watchdog.ts`) monitors the smart-checkin service:

1. Check if `logs/smart-checkin.log` exists
2. Check when it was last modified
3. If more than 90 minutes old, send a Telegram alert

This creates a monitoring hierarchy:
- **launchd** monitors the bot (restarts on crash)
- **Watchdog** monitors scheduled services (alerts on silence)
- **You** see the alerts on Telegram

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `setup/configure-launchd.ts` | Template processor and service installer |
| `launchd/com.go.telegram-relay.plist.template` | Bot daemon template |
| `launchd/com.go.smart-checkin.plist.template` | Check-in schedule template |
| `launchd/com.go.morning-briefing.plist.template` | Briefing schedule template |
| `launchd/com.go.watchdog.plist.template` | Watchdog schedule template |
| `src/watchdog.ts` | Health monitor for scheduled services |
| `config/schedule.example.json` | Schedule configuration |

---

**Next module:** [08 - Optional Integrations](./08-optional-integrations.md)
