/**
 * Go Telegram Bot - Uninstall Services (Cross-Platform)
 *
 * macOS: Unloads and removes all com.go.* plist files
 * Windows/Linux: Stops PM2 processes and removes scheduled tasks
 *
 * Does NOT delete project files or .env.
 *
 * Usage: bun run setup/uninstall.ts
 */

import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const PASS = green("\u2713");
const FAIL = red("\u2717");

async function runCommand(
  cmd: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, {
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

// ---------------------------------------------------------------------------
// macOS: Uninstall launchd services
// ---------------------------------------------------------------------------

async function uninstallLaunchd() {
  const homeDir = process.env.HOME!;
  const LAUNCH_AGENTS_DIR = join(homeDir, "Library", "LaunchAgents");

  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    console.log(`\n  ${dim("No LaunchAgents directory found. Nothing to uninstall.")}`);
    return;
  }

  const allFiles = readdirSync(LAUNCH_AGENTS_DIR);
  const goPlists = allFiles.filter(
    (f) => f.startsWith("com.go.") && f.endsWith(".plist")
  );

  if (goPlists.length === 0) {
    console.log(`\n  ${dim("No com.go.* services found in ~/Library/LaunchAgents/.")}`);
    console.log(`  ${dim("Nothing to uninstall.")}`);
    return;
  }

  console.log(`\n  Found ${goPlists.length} service${goPlists.length !== 1 ? "s" : ""}:\n`);

  let unloadedCount = 0;
  let removedCount = 0;
  let errorCount = 0;

  for (const plist of goPlists) {
    const fullPath = join(LAUNCH_AGENTS_DIR, plist);
    const label = plist.replace(".plist", "");

    console.log(`  ${bold(label)}`);

    const unloadResult = await runCommand(["launchctl", "unload", fullPath]);
    if (unloadResult.ok) {
      console.log(`    ${PASS} Unloaded`);
      unloadedCount++;
    } else if (unloadResult.stderr.includes("Could not find specified service")) {
      console.log(`    ${dim("-")} Was not loaded`);
    } else {
      console.log(`    ${yellow("!")} Unload: ${unloadResult.stderr}`);
    }

    try {
      unlinkSync(fullPath);
      console.log(`    ${PASS} Deleted: ${dim(fullPath)}`);
      removedCount++;
    } catch (err: any) {
      console.log(`    ${FAIL} Delete failed: ${err.message}`);
      errorCount++;
    }
  }

  console.log(`\n${bold("  Summary:")}`);
  console.log(`  ${PASS} ${unloadedCount} service${unloadedCount !== 1 ? "s" : ""} unloaded`);
  console.log(`  ${PASS} ${removedCount} plist file${removedCount !== 1 ? "s" : ""} removed`);
  if (errorCount > 0) {
    console.log(`  ${FAIL} ${errorCount} error${errorCount !== 1 ? "s" : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Windows/Linux: Uninstall PM2 + scheduled tasks
// ---------------------------------------------------------------------------

async function uninstallPM2() {
  const services = ["go-telegram-relay", "go-smart-checkin", "go-morning-briefing", "go-watchdog"];

  // Stop PM2 processes
  const pm2Check = await runCommand(["npx", "pm2", "jlist"]);
  if (pm2Check.ok) {
    let stoppedCount = 0;
    for (const name of services) {
      const result = await runCommand(["npx", "pm2", "delete", name]);
      if (result.ok) {
        console.log(`  ${PASS} Stopped and removed: ${name}`);
        stoppedCount++;
      } else if (result.stderr.includes("not found")) {
        console.log(`  ${dim("-")} ${name}: not running`);
      } else {
        console.log(`  ${yellow("!")} ${name}: ${result.stderr}`);
      }
    }
    if (stoppedCount > 0) {
      await runCommand(["npx", "pm2", "save"]);
    }
  } else {
    console.log(`  ${dim("PM2 not installed. Skipping.")}`);
  }

  // Remove Windows scheduled tasks
  if (process.platform === "win32") {
    console.log(`\n  Removing scheduled tasks...`);
    for (const name of services) {
      const taskName = `Go-${name.replace("go-", "")}`;
      const result = await runCommand(["schtasks", "/Delete", "/TN", taskName, "/F"]);
      if (result.ok) {
        console.log(`  ${PASS} Removed scheduled task: ${taskName}`);
      } else if (result.stderr.includes("does not exist")) {
        console.log(`  ${dim("-")} ${taskName}: not found`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - Uninstall Services"));
  console.log(dim("  ====================================="));

  if (process.platform === "darwin") {
    await uninstallLaunchd();
  } else {
    await uninstallPM2();
  }

  console.log(`\n  ${dim("Project files and .env were NOT removed.")}`);
  if (process.platform === "darwin") {
    console.log(`  ${dim("To reinstall services: bun run setup:launchd -- --service all")}`);
  } else {
    console.log(`  ${dim("To reinstall services: bun run setup:services -- --service all")}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
