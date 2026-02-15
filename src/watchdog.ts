#!/usr/bin/env bun
/**
 * Watchdog
 *
 * Monitors if smart-checkin has run recently and alerts via Telegram if not.
 * Run via launchd every hour.
 */

import { existsSync, statSync, readFileSync } from "fs";
import { join } from "path";

// Load .env
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const envPath = join(PROJECT_ROOT, ".env");
if (existsSync(envPath)) {
  readFileSync(envPath, "utf-8")
    .split("\n")
    .forEach((line) => {
      const [key, ...valueParts] = line.split("=");
      if (key && valueParts.length > 0 && !key.trim().startsWith("#")) {
        process.env[key.trim()] = valueParts.join("=").trim();
      }
    });
}

const LOG_FILE = join(PROJECT_ROOT, "logs", "smart-checkin.log");
const WATCHDOG_LOG = join(PROJECT_ROOT, "logs", "watchdog.log");
const MAX_AGE_MINUTES = 90;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_USER_ID;

function log(message: string) {
  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: process.env.USER_TIMEZONE || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const line = `[${timestamp}] ${message}\n`;
  console.log(line.trim());
  try {
    Bun.write(WATCHDOG_LOG, line, { append: true } as any);
  } catch {}
}

async function sendAlert(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("Missing Telegram credentials");
    return;
  }

  try {
    let response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );

    if (response.status === 400) {
      const plainMessage = message.replace(/[*_`\[\]()~>#+\-=|{}.!]/g, "");
      response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: plainMessage }),
        }
      );
    }

    if (response.ok) {
      log("✅ Alert sent");
    } else {
      log(`❌ Alert failed: ${response.status}`);
    }
  } catch (error) {
    log(`❌ Alert error: ${error}`);
  }
}

async function check() {
  log("🔍 Watchdog checking smart-checkin health...");

  if (!existsSync(LOG_FILE)) {
    log("❌ Log file doesn't exist!");
    await sendAlert(
      "🚨 *Smart Check-in Alert*\n\nLog file doesn't exist! Service may have never run.\n\nRun: `bun run setup:launchd -- --service smart-checkin`"
    );
    return;
  }

  const stats = statSync(LOG_FILE);
  const ageMinutes =
    (Date.now() - stats.mtime.getTime()) / 1000 / 60;

  log(
    `📊 Log last modified: ${stats.mtime.toLocaleString()} (${Math.round(ageMinutes)} min ago)`
  );

  if (ageMinutes > MAX_AGE_MINUTES) {
    log(`❌ Smart-checkin hasn't run in ${Math.round(ageMinutes)} minutes!`);
    await sendAlert(
      `🚨 *Smart Check-in Alert*\n\nService hasn't run in *${Math.round(ageMinutes)} minutes*!\n\nLast activity: ${stats.mtime.toLocaleString()}\n\nCheck logs in: ${LOG_FILE}`
    );
  } else {
    log(
      `✅ Healthy (last run ${Math.round(ageMinutes)} min ago)`
    );
  }
}

check().catch((error) => log(`❌ Watchdog error: ${error}`));
