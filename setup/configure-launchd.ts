/**
 * Go Telegram Bot - launchd Configuration
 *
 * Generates plist files from templates, replaces placeholders,
 * installs to ~/Library/LaunchAgents, and loads services.
 *
 * Usage:
 *   bun run setup/configure-launchd.ts --service telegram-relay
 *   bun run setup/configure-launchd.ts --service all
 *
 * Services: telegram-relay, smart-checkin, morning-briefing, watchdog, all
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(import.meta.dir);
const LAUNCHD_DIR = join(PROJECT_ROOT, "launchd");
const LAUNCH_AGENTS_DIR = join(process.env.HOME!, "Library", "LaunchAgents");

const SERVICES = ["telegram-relay", "smart-checkin", "morning-briefing", "watchdog"] as const;
type ServiceName = (typeof SERVICES)[number];

interface ScheduleInterval {
  hour?: number;
  minute?: number;
}

interface ScheduleConfig {
  morning_briefing?: {
    hour: number;
    minute: number;
    enabled: boolean;
  };
  check_in_intervals?: ScheduleInterval[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("\u2713");
const FAIL = red("\u2717");

async function runCommand(
  cmd: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch {
    return { ok: false, stdout: "", stderr: "Command not found" };
  }
}

async function resolvePath(cmd: string): Promise<string> {
  const result = await runCommand(["which", cmd]);
  return result.ok ? result.stdout : "";
}

function loadSchedule(): ScheduleConfig {
  const schedulePath = join(PROJECT_ROOT, "config", "schedule.json");
  const examplePath = join(PROJECT_ROOT, "config", "schedule.example.json");

  if (existsSync(schedulePath)) {
    try {
      return JSON.parse(readFileSync(schedulePath, "utf-8"));
    } catch {
      console.log(`  ${yellow("!")} Could not parse config/schedule.json, using defaults`);
    }
  }

  if (existsSync(examplePath)) {
    try {
      return JSON.parse(readFileSync(examplePath, "utf-8"));
    } catch {
      // fall through to defaults
    }
  }

  // Defaults
  return {
    morning_briefing: { hour: 9, minute: 0, enabled: true },
    check_in_intervals: [
      { hour: 10, minute: 30 },
      { hour: 12, minute: 30 },
      { hour: 14, minute: 30 },
      { hour: 16, minute: 30 },
      { hour: 18, minute: 30 },
    ],
  };
}

function generateCalendarIntervalsXml(intervals: ScheduleInterval[]): string {
  return intervals
    .map((interval) => {
      const parts: string[] = [];
      if (interval.hour !== undefined) {
        parts.push(`            <key>Hour</key>\n            <integer>${interval.hour}</integer>`);
      }
      if (interval.minute !== undefined) {
        parts.push(
          `            <key>Minute</key>\n            <integer>${interval.minute}</integer>`
        );
      }
      return `        <dict>\n${parts.join("\n")}\n        </dict>`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Service Configuration
// ---------------------------------------------------------------------------

async function configureService(service: ServiceName): Promise<boolean> {
  const templatePath = join(LAUNCHD_DIR, `com.go.${service}.plist.template`);
  const plistName = `com.go.${service}.plist`;
  const plistPath = join(LAUNCH_AGENTS_DIR, plistName);

  console.log(`\n  ${bold(service)}`);

  // Check template exists
  if (!existsSync(templatePath)) {
    console.log(`  ${FAIL} Template not found: launchd/com.go.${service}.plist.template`);
    return false;
  }

  // Resolve paths
  const bunPath = await resolvePath("bun");
  if (!bunPath) {
    console.log(`  ${FAIL} Could not find bun in PATH`);
    return false;
  }

  const claudePath = await resolvePath("claude");
  const bunDir = dirname(bunPath);
  const claudeDir = claudePath ? dirname(claudePath) : "/usr/local/bin";
  const home = process.env.HOME!;

  // Load schedule config
  const schedule = loadSchedule();

  // Read template
  let content = readFileSync(templatePath, "utf-8");

  // Replace common placeholders
  content = content.replace(/\{\{BUN_PATH\}\}/g, bunPath);
  content = content.replace(/\{\{HOME\}\}/g, home);
  content = content.replace(/\{\{PROJECT_ROOT\}\}/g, PROJECT_ROOT);
  content = content.replace(/\{\{BUN_DIR\}\}/g, bunDir);
  content = content.replace(/\{\{CLAUDE_DIR\}\}/g, claudeDir);

  // Service-specific placeholders
  if (service === "smart-checkin") {
    const intervals = schedule.check_in_intervals || [
      { hour: 10, minute: 30 },
      { hour: 12, minute: 30 },
      { hour: 14, minute: 30 },
      { hour: 16, minute: 30 },
      { hour: 18, minute: 30 },
    ];
    const xml = generateCalendarIntervalsXml(intervals);
    content = content.replace(/\{\{CALENDAR_INTERVALS\}\}/g, xml);
    console.log(`    Schedule: ${intervals.length} check-in intervals`);
  }

  if (service === "morning-briefing") {
    const briefing = schedule.morning_briefing || { hour: 9, minute: 0 };
    content = content.replace(/\{\{BRIEFING_HOUR\}\}/g, String(briefing.hour));
    content = content.replace(/\{\{BRIEFING_MINUTE\}\}/g, String(briefing.minute));
    console.log(
      `    Schedule: ${String(briefing.hour).padStart(2, "0")}:${String(briefing.minute).padStart(2, "0")} daily`
    );
  }

  // Unload existing if present
  if (existsSync(plistPath)) {
    console.log(`    Unloading existing service...`);
    await runCommand(["launchctl", "unload", plistPath]);
  }

  // Ensure LaunchAgents directory exists
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }

  // Write plist
  writeFileSync(plistPath, content, "utf-8");
  console.log(`  ${PASS} Written: ${dim(plistPath)}`);

  // Load service
  const loadResult = await runCommand(["launchctl", "load", plistPath]);
  if (loadResult.ok) {
    console.log(`  ${PASS} Loaded: com.go.${service}`);
  } else {
    console.log(`  ${FAIL} Load failed: ${loadResult.stderr}`);
    return false;
  }

  // Check status
  const listResult = await runCommand(["launchctl", "list"]);
  if (listResult.ok && listResult.stdout.includes(`com.go.${service}`)) {
    console.log(`  ${PASS} Status: running`);
  } else {
    console.log(`  ${yellow("!")} Status: loaded but not yet running ${dim("(may start on schedule)")}`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - launchd Configuration"));
  console.log(dim("  ========================================"));

  if (process.platform !== "darwin") {
    console.log(`\n  ${red("launchd is macOS-only.")}`);
    console.log(`  On Windows/Linux, use: ${cyan("bun run setup/configure-services.ts --service all")}`);
    process.exit(1);
  }

  // Parse --service flag
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : undefined;

  if (!serviceArg) {
    console.log(`\n  ${red("Missing --service flag")}`);
    console.log(`\n  Usage:`);
    console.log(`    bun run setup/configure-launchd.ts --service telegram-relay`);
    console.log(`    bun run setup/configure-launchd.ts --service all`);
    console.log(`\n  Available services:`);
    for (const s of SERVICES) {
      console.log(`    - ${s}`);
    }
    console.log(`    - all`);
    process.exit(1);
  }

  // Determine which services to configure
  let targets: ServiceName[];
  if (serviceArg === "all") {
    targets = [...SERVICES];
  } else if (SERVICES.includes(serviceArg as ServiceName)) {
    targets = [serviceArg as ServiceName];
  } else {
    console.log(`\n  ${red(`Unknown service: ${serviceArg}`)}`);
    console.log(`  Valid options: ${SERVICES.join(", ")}, all`);
    process.exit(1);
  }

  console.log(
    `\n  Configuring ${targets.length} service${targets.length > 1 ? "s" : ""}: ${cyan(targets.join(", "))}`
  );
  console.log(`  Project root: ${dim(PROJECT_ROOT)}`);

  let successCount = 0;
  let failCount = 0;

  for (const service of targets) {
    const ok = await configureService(service);
    if (ok) successCount++;
    else failCount++;
  }

  // Summary
  console.log(`\n${bold("  Summary:")}`);
  console.log(`  ${PASS} ${successCount} service${successCount !== 1 ? "s" : ""} configured`);
  if (failCount > 0) {
    console.log(`  ${FAIL} ${failCount} service${failCount !== 1 ? "s" : ""} failed`);
  }

  console.log(`\n  Useful commands:`);
  console.log(`    Check status:  ${cyan("launchctl list | grep com.go")}`);
  console.log(`    View logs:     ${cyan(`tail -f ${PROJECT_ROOT}/logs/*.log`)}`);
  console.log(`    Unload all:    ${cyan("bun run uninstall")}`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
