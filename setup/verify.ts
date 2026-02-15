/**
 * Go Telegram Bot - Full Health Check
 *
 * Verifies environment variables, API connectivity,
 * launchd services, and optional integrations.
 *
 * Usage: bun run setup/verify.ts
 */

import { join, dirname } from "path";
import { loadEnv } from "../src/lib/env";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(import.meta.dir);

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
const WARN = yellow("~");
const SKIP = dim("-");

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  message: string;
}

const results: CheckResult[] = [];

function record(name: string, status: CheckResult["status"], message: string) {
  results.push({ name, status, message });
  const icon =
    status === "pass" ? PASS : status === "fail" ? FAIL : status === "warn" ? WARN : SKIP;
  console.log(`  ${icon} ${name}: ${message}`);
}

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

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkRequiredEnv() {
  console.log(`\n${cyan("  [1/5] Required Environment Variables")}`);

  const required: [string, string][] = [
    ["TELEGRAM_BOT_TOKEN", "Telegram bot token"],
    ["TELEGRAM_USER_ID", "Telegram user ID"],
    ["SUPABASE_URL", "Supabase project URL"],
    ["SUPABASE_ANON_KEY", "Supabase anon key"],
  ];

  for (const [key, label] of required) {
    const value = process.env[key];
    if (!value || value.includes("your_") || value.includes("_here")) {
      record(label, "fail", `${key} is not set or still has placeholder value`);
    } else {
      // Mask sensitive values
      const masked = value.length > 8 ? value.slice(0, 4) + "..." + value.slice(-4) : "***";
      record(label, "pass", `${key} = ${masked}`);
    }
  }
}

async function checkTelegram() {
  console.log(`\n${cyan("  [2/5] Telegram Connectivity")}`);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.includes("your_")) {
    record("Telegram API", "skip", "No valid token configured");
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await response.json()) as { ok: boolean; result?: { username: string; id: number } };

    if (data.ok && data.result) {
      record(
        "Telegram API",
        "pass",
        `Bot: @${data.result.username} (ID: ${data.result.id})`
      );
    } else {
      record("Telegram API", "fail", "getMe returned ok=false - check token");
    }
  } catch (err: any) {
    record("Telegram API", "fail", `Connection error: ${err.message}`);
  }
}

async function checkSupabase() {
  console.log(`\n${cyan("  [3/5] Supabase Connectivity")}`);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key || url.includes("your_") || key.includes("your_")) {
    record("Supabase connection", "skip", "No valid credentials configured");
    return;
  }

  // Test messages table
  try {
    const response = await fetch(`${url}/rest/v1/messages?select=id&limit=1`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });

    if (response.ok) {
      record("Supabase messages table", "pass", "Connected and accessible");
    } else if (response.status === 404) {
      record("Supabase messages table", "fail", "Table not found - run migrations");
    } else {
      const body = await response.text();
      record("Supabase messages table", "fail", `HTTP ${response.status}: ${body.slice(0, 100)}`);
    }
  } catch (err: any) {
    record("Supabase messages table", "fail", `Connection error: ${err.message}`);
  }

  // Test memory table
  try {
    const response = await fetch(`${url}/rest/v1/memory?select=id&limit=1`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });

    if (response.ok) {
      record("Supabase memory table", "pass", "Connected and accessible");
    } else if (response.status === 404) {
      record("Supabase memory table", "warn", "Table not found - memory features unavailable");
    } else {
      record("Supabase memory table", "warn", `HTTP ${response.status}`);
    }
  } catch (err: any) {
    record("Supabase memory table", "fail", `Connection error: ${err.message}`);
  }
}

async function checkServices() {
  const services = ["telegram-relay", "smart-checkin", "morning-briefing", "watchdog"];

  if (process.platform === "darwin") {
    console.log(`\n${cyan("  [4/5] launchd Services")}`);

    const result = await runCommand(["launchctl", "list"]);
    if (!result.ok) {
      record("launchctl", "fail", "Could not query launchctl");
      return;
    }

    for (const service of services) {
      const label = `com.go.${service}`;
      const line = result.stdout.split("\n").find((l) => l.includes(label));

      if (line) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[0];
        const exitCode = parts[1];

        if (pid !== "-") {
          record(service, "pass", `Running (PID: ${pid})`);
        } else if (exitCode === "0") {
          record(service, "pass", `Loaded, last exit: 0 ${dim("(waiting for schedule)")}`);
        } else {
          record(service, "warn", `Loaded but last exit code: ${exitCode}`);
        }
      } else {
        record(service, "skip", "Not installed");
      }
    }
  } else {
    console.log(`\n${cyan("  [4/5] Background Services")}`);

    // Check PM2 for daemon services
    const pm2Result = await runCommand(["npx", "pm2", "jlist"]);
    if (pm2Result.ok) {
      try {
        const pm2List = JSON.parse(pm2Result.stdout) as Array<{ name: string; pm2_env?: { status?: string }; pid?: number }>;
        for (const service of services) {
          const pm2Name = `go-${service}`;
          const proc = pm2List.find((p) => p.name === pm2Name);
          if (proc) {
            const status = proc.pm2_env?.status || "unknown";
            if (status === "online") {
              record(service, "pass", `Running via PM2 (PID: ${proc.pid})`);
            } else {
              record(service, "warn", `PM2 status: ${status}`);
            }
          } else {
            record(service, "skip", "Not registered in PM2");
          }
        }
      } catch {
        record("PM2", "warn", "Could not parse PM2 output");
      }
    } else {
      record("PM2", "skip", "PM2 not installed (npm install -g pm2)");
      for (const service of services) {
        record(service, "skip", "No service manager detected");
      }
    }
  }
}

function checkOptionalIntegrations() {
  console.log(`\n${cyan("  [5/5] Optional Integrations")}`);

  const optional: [string, string][] = [
    ["ELEVENLABS_API_KEY", "ElevenLabs (voice)"],
    ["GEMINI_API_KEY", "Gemini (transcription)"],
    ["OPENROUTER_API_KEY", "OpenRouter (fallback LLM)"],
  ];

  for (const [key, label] of optional) {
    const value = process.env[key];
    if (value && !value.includes("your_")) {
      record(label, "pass", "Configured");
    } else {
      record(label, "skip", "Not configured");
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - Health Check"));
  console.log(dim("  =============================="));

  // Load environment
  await loadEnv(join(PROJECT_ROOT, ".env"));

  // Run all checks
  checkRequiredEnv();
  await checkTelegram();
  await checkSupabase();
  await checkServices();
  checkOptionalIntegrations();

  // Summary
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  console.log(`\n${bold("  Results:")}`);
  console.log(`  ${PASS} ${passed} passed`);
  if (failed > 0) console.log(`  ${FAIL} ${failed} failed`);
  if (warned > 0) console.log(`  ${WARN} ${warned} warnings`);
  if (skipped > 0) console.log(`  ${SKIP} ${skipped} skipped`);

  if (failed > 0) {
    console.log(`\n  ${red("Some checks failed. Review the errors above and fix before running the bot.")}`);
    process.exit(1);
  } else if (warned > 0) {
    console.log(`\n  ${yellow("All critical checks passed, but some warnings to review.")}`);
  } else {
    console.log(`\n  ${green("All checks passed! Ready to run.")}`);
  }

  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
