/**
 * Go Telegram Bot - Upgrade & Git Connection
 *
 * Detects if the project was downloaded as a ZIP (no git) or cloned,
 * and connects it to the official autonomee/gobot repo so users can
 * pull future updates with `git pull`.
 *
 * Safe: all user config (.env, config/profile.md, schedule.json, tokens)
 * is gitignored, so updates never overwrite personal settings.
 *
 * Usage: bun run setup/upgrade.ts
 */

import { existsSync, readFileSync, readdirSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);
const REPO_URL = "https://github.com/autonomee/gobot.git";
const BRANCH = "master";

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
const WARN = yellow("!");
const INFO = cyan("\u2192");

async function run(
  cmd: string[],
  opts?: { cwd?: string }
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd || PROJECT_ROOT,
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
// User config files that should be preserved (all gitignored)
// ---------------------------------------------------------------------------

const USER_FILES = [
  ".env",
  "config/profile.md",
  "config/schedule.json",
  "config/.google-tokens.json",
  "checkin-state.json",
  "session-state.json",
  "memory.json",
  "news-history.json",
  "last-processed-call.json",
  "meeting-actions-state.json",
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

interface InstallInfo {
  hasGit: boolean;
  remoteUrl: string | null;
  isCorrectRemote: boolean;
  branch: string | null;
  hasUserConfig: boolean;
  userFiles: string[];
  version: string | null;
}

async function detectInstallation(): Promise<InstallInfo> {
  const hasGit = existsSync(join(PROJECT_ROOT, ".git"));

  let remoteUrl: string | null = null;
  let isCorrectRemote = false;
  let branch: string | null = null;

  if (hasGit) {
    const remote = await run(["git", "remote", "get-url", "origin"]);
    if (remote.ok) {
      remoteUrl = remote.stdout;
      isCorrectRemote =
        remoteUrl.includes("autonomee/gobot") ||
        remoteUrl.includes("godagoo/gobot");
    }

    const br = await run(["git", "branch", "--show-current"]);
    if (br.ok) branch = br.stdout;
  }

  // Check which user files exist
  const userFiles: string[] = [];
  for (const f of USER_FILES) {
    if (existsSync(join(PROJECT_ROOT, f))) {
      userFiles.push(f);
    }
  }

  // Get version from package.json
  let version: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"));
    version = pkg.version || null;
  } catch {}

  return {
    hasGit,
    remoteUrl,
    isCorrectRemote,
    branch,
    hasUserConfig: userFiles.length > 0,
    userFiles,
    version,
  };
}

// ---------------------------------------------------------------------------
// Upgrade scenarios
// ---------------------------------------------------------------------------

/**
 * Scenario 1: ZIP download — no .git directory
 * Initialize git, connect to repo, fetch latest
 */
async function upgradeFromZip(info: InstallInfo): Promise<boolean> {
  console.log(`\n${cyan("  Connecting to gobot repository...")}`);

  // Step 1: Init git
  console.log(`  ${INFO} Initializing git...`);
  const init = await run(["git", "init"]);
  if (!init.ok) {
    console.log(`  ${FAIL} git init failed: ${init.stderr}`);
    return false;
  }
  console.log(`  ${PASS} Git initialized`);

  // Step 2: Add remote
  console.log(`  ${INFO} Adding remote origin → ${REPO_URL}`);
  const addRemote = await run(["git", "remote", "add", "origin", REPO_URL]);
  if (!addRemote.ok) {
    console.log(`  ${FAIL} Failed to add remote: ${addRemote.stderr}`);
    return false;
  }
  console.log(`  ${PASS} Remote added`);

  // Step 3: Fetch
  console.log(`  ${INFO} Fetching latest from ${BRANCH}...`);
  const fetch = await run(["git", "fetch", "origin", BRANCH]);
  if (!fetch.ok) {
    console.log(`  ${FAIL} Fetch failed: ${fetch.stderr}`);
    console.log(`  ${dim("    Check your internet connection and try again")}`);
    return false;
  }
  console.log(`  ${PASS} Fetched latest code`);

  // Step 4: Reset to track origin/master
  // This makes your working directory match the repo structure
  // while keeping all untracked files (your .env, config, etc.)
  console.log(`  ${INFO} Aligning with ${BRANCH} branch...`);
  const reset = await run(["git", "reset", "origin/" + BRANCH]);
  if (!reset.ok) {
    console.log(`  ${FAIL} Reset failed: ${reset.stderr}`);
    return false;
  }

  // Step 5: Set upstream tracking
  const checkout = await run(["git", "checkout", "-B", BRANCH, "--track", `origin/${BRANCH}`]);
  if (!checkout.ok) {
    // Fallback: just set the branch
    await run(["git", "branch", "-M", BRANCH]);
    await run(["git", "branch", "--set-upstream-to=origin/" + BRANCH, BRANCH]);
  }
  console.log(`  ${PASS} Now tracking origin/${BRANCH}`);

  // Step 6: Verify — check if git status works
  const status = await run(["git", "status", "--short"]);
  if (status.ok) {
    const modified = status.stdout.split("\n").filter((l) => l.trim()).length;
    if (modified > 0) {
      console.log(`  ${WARN} ${modified} local modifications detected ${dim("(this is normal for user config)")}`);
    } else {
      console.log(`  ${PASS} Clean — fully aligned with latest ${BRANCH}`);
    }
  }

  return true;
}

/**
 * Scenario 2: Has .git but wrong remote (e.g., personal fork)
 * Add the correct remote and set up tracking
 */
async function fixRemote(info: InstallInfo): Promise<boolean> {
  console.log(`\n${cyan("  Fixing remote to track official repository...")}`);

  // Check if 'upstream' already exists
  const remotes = await run(["git", "remote", "-v"]);
  const hasUpstream = remotes.stdout.includes("upstream");

  if (hasUpstream) {
    // Update upstream URL
    await run(["git", "remote", "set-url", "upstream", REPO_URL]);
    console.log(`  ${PASS} Updated upstream → ${REPO_URL}`);
  } else if (info.remoteUrl?.includes("autonomee/gobot") || info.remoteUrl?.includes("godagoo/gobot")) {
    // Origin is already correct
    console.log(`  ${PASS} Origin already points to gobot repo`);
  } else {
    // Add upstream for the official repo, keep origin as their fork
    await run(["git", "remote", "add", "upstream", REPO_URL]);
    console.log(`  ${PASS} Added upstream → ${REPO_URL}`);
    console.log(`  ${dim("    Your fork stays as 'origin', official repo is 'upstream'")}`);
    console.log(`  ${dim("    Pull updates: git pull upstream master")}`);
  }

  // Fetch from the correct remote
  const remoteName = hasUpstream || !info.isCorrectRemote ? "upstream" : "origin";
  console.log(`  ${INFO} Fetching latest from ${remoteName}/${BRANCH}...`);
  const fetch = await run(["git", "fetch", remoteName, BRANCH]);
  if (!fetch.ok) {
    console.log(`  ${FAIL} Fetch failed: ${fetch.stderr}`);
    return false;
  }
  console.log(`  ${PASS} Fetched latest code`);

  return true;
}

/**
 * Scenario 3: Properly cloned — just pull latest
 */
async function pullLatest(): Promise<boolean> {
  console.log(`\n${cyan("  Pulling latest updates...")}`);

  // Check for uncommitted changes first
  const status = await run(["git", "status", "--porcelain"]);
  const hasChanges = status.stdout.trim().length > 0;

  if (hasChanges) {
    // Stash any tracked file changes (won't affect .env etc. since they're gitignored)
    console.log(`  ${INFO} Stashing local changes...`);
    await run(["git", "stash"]);
  }

  const pull = await run(["git", "pull", "origin", BRANCH]);
  if (!pull.ok) {
    console.log(`  ${FAIL} Pull failed: ${pull.stderr}`);

    if (hasChanges) {
      console.log(`  ${INFO} Restoring stashed changes...`);
      await run(["git", "stash", "pop"]);
    }
    return false;
  }

  if (pull.stdout.includes("Already up to date")) {
    console.log(`  ${PASS} Already up to date`);
  } else {
    console.log(`  ${PASS} Updated successfully`);
    console.log(`  ${dim(pull.stdout.split("\n").slice(0, 5).join("\n  "))}`);
  }

  if (hasChanges) {
    console.log(`  ${INFO} Restoring stashed changes...`);
    const pop = await run(["git", "stash", "pop"]);
    if (!pop.ok) {
      console.log(`  ${WARN} Stash pop had conflicts — check manually`);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Post-upgrade: install new dependencies
// ---------------------------------------------------------------------------

async function postUpgrade(oldVersion: string | null): Promise<void> {
  // Re-read version
  let newVersion: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"));
    newVersion = pkg.version || null;
  } catch {}

  if (oldVersion !== newVersion) {
    console.log(`\n${cyan("  Version changed:")} ${dim(oldVersion || "unknown")} → ${green(newVersion || "unknown")}`);
  }

  // Always reinstall dependencies after upgrade
  console.log(`  ${INFO} Installing dependencies...`);
  const install = await run(["bun", "install"]);
  if (install.ok) {
    console.log(`  ${PASS} Dependencies updated`);
  } else {
    console.log(`  ${WARN} bun install had issues: ${install.stderr.substring(0, 200)}`);
  }

  // Run schema (safe — IF NOT EXISTS)
  console.log(`  ${INFO} Checking database schema...`);
  const schemaPath = join(PROJECT_ROOT, "db", "schema.sql");
  if (existsSync(schemaPath)) {
    console.log(`  ${PASS} Schema file ready ${dim("(run in Supabase SQL editor if new tables were added)")}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  GoBot Upgrade"));
  console.log(dim("  ============="));

  // Check git is available
  const gitCheck = await run(["git", "--version"]);
  if (!gitCheck.ok) {
    console.log(`\n  ${FAIL} Git is not installed. Install git first.`);
    process.exit(1);
  }

  // Detect current state
  console.log(`\n${cyan("  [1/3] Detecting installation...")}`);
  const info = await detectInstallation();

  console.log(`  ${info.hasGit ? PASS : FAIL} Git repository: ${info.hasGit ? "yes" : "no (ZIP download)"}`);
  if (info.remoteUrl) {
    console.log(`  ${info.isCorrectRemote ? PASS : WARN} Remote: ${info.remoteUrl}`);
  }
  if (info.branch) {
    console.log(`  ${PASS} Branch: ${info.branch}`);
  }
  console.log(`  ${PASS} Version: ${info.version || "unknown"}`);
  console.log(`  ${PASS} User config: ${info.userFiles.length} files preserved`);
  if (info.userFiles.length > 0) {
    for (const f of info.userFiles) {
      console.log(`      ${dim(f)}`);
    }
  }

  // Choose upgrade path
  console.log(`\n${cyan("  [2/3] Upgrading...")}`);
  let success = false;

  if (!info.hasGit) {
    // ZIP download — connect to repo
    console.log(`  ${INFO} Detected ZIP installation — connecting to official repo`);
    success = await upgradeFromZip(info);
  } else if (!info.isCorrectRemote) {
    // Wrong remote — fix it
    console.log(`  ${INFO} Remote doesn't point to gobot — adding upstream`);
    success = await fixRemote(info);
  } else {
    // Proper clone — just pull
    console.log(`  ${INFO} Proper clone detected — pulling latest`);
    success = await pullLatest();
  }

  if (!success) {
    console.log(`\n  ${red("Upgrade failed. Your config files are safe.")}`);
    console.log(`  ${dim("Try manually: git pull origin master")}`);
    process.exit(1);
  }

  // Post-upgrade
  console.log(`\n${cyan("  [3/3] Post-upgrade...")}`);
  await postUpgrade(info.version);

  // Summary
  console.log(`\n${bold("  Done!")}`);
  console.log(`  ${PASS} Connected to ${REPO_URL}`);
  console.log(`  ${PASS} All user config preserved (${info.userFiles.length} files)`);
  console.log(`\n  ${dim("Future updates:")} ${cyan("bun run upgrade")} ${dim("or")} ${cyan("git pull origin master")}`);

  // Check if services need restart
  if (process.platform === "darwin") {
    const services = await run(["launchctl", "list"]);
    if (services.ok && services.stdout.includes("com.go.")) {
      console.log(`\n  ${WARN} Running services detected — restart them to use the new code:`);
      console.log(`      ${cyan("bun run setup:launchd -- --service all")}`);
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
