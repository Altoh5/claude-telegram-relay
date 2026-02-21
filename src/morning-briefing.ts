/**
 * Morning Briefing
 *
 * Sends a daily summary via Telegram using pluggable data sources.
 * Each source auto-detects availability from env vars.
 * No Claude subprocess needed — direct REST API calls only (~3s vs ~90s).
 *
 * Built-in sources:
 *   - Goals (Supabase/local) — always available
 *   - AI News (xAI Grok API) — requires XAI_API_KEY
 *   - Gmail unread — requires Google OAuth env vars
 *   - Calendar events — requires Google OAuth env vars
 *   - Notion tasks — requires NOTION_TOKEN + NOTION_DATABASE_ID
 *
 * Add your own: copy src/lib/data-sources/sources/custom.example.ts
 *
 * Run manually: bun run src/morning-briefing.ts
 * Scheduled: launchd at your preferred morning time
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { loadEnv } from "./lib/env";
import { sendTelegramMessage } from "./lib/telegram";
import { fetchAll, getAvailableSources } from "./lib/data-sources";

// Load environment
await loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || "";
const DM_CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const GENERAL_TOPIC_ID = 1; // Telegram forum "General" topic is always thread ID 1
const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
const USER_TIMEZONE = process.env.USER_TIMEZONE || "UTC";

// ============================================================
// BUILD & SEND BRIEFING
// ============================================================

async function buildAndSendBriefing(): Promise<void> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Load user profile for greeting
  let userName = "there";
  try {
    const profile = await readFile(
      join(PROJECT_ROOT, "config", "profile.md"),
      "utf-8"
    );
    const nameMatch = profile.match(/^#\s*(.+)/m);
    if (nameMatch) userName = nameMatch[1].trim();
  } catch {}

  // Log available sources
  const available = getAvailableSources();
  console.log(
    `📊 Data sources: ${available.map((s) => s.name).join(", ") || "none"}`
  );

  // Fetch all data in parallel (~3s total)
  const { results, errors, durationMs } = await fetchAll();
  console.log(
    `⚡ Fetched ${results.size} sources in ${durationMs}ms (${errors.size} failed)`
  );

  // Log errors (but don't break the briefing)
  for (const [id, { error }] of errors) {
    console.error(`  ❌ ${id}: ${error.message}`);
  }

  // Build greeting
  let briefing = `☀️ **GOOD MORNING ${userName.toUpperCase()}**\n_${dateStr}_\n\n`;

  // Add each source's section in a stable order
  const sourceOrder = ["calendar", "gmail", "notion-tasks", "grok-news", "goals"];

  for (const id of sourceOrder) {
    const entry = results.get(id);
    if (!entry) continue;

    const { source, result } = entry;
    if (result.lines.length === 0) continue;

    const count =
      result.meta?.count !== undefined ? ` (${result.meta.count})` : "";
    briefing += `${source.emoji} **${source.name.toUpperCase()}**${count}\n`;
    briefing += result.lines.join("\n");
    briefing += "\n\n";
  }

  // Add any sources not in the predefined order (custom sources)
  for (const [id, { source, result }] of results) {
    if (sourceOrder.includes(id)) continue;
    if (result.lines.length === 0) continue;

    const count =
      result.meta?.count !== undefined ? ` (${result.meta.count})` : "";
    briefing += `${source.emoji} **${source.name.toUpperCase()}**${count}\n`;
    briefing += result.lines.join("\n");
    briefing += "\n\n";
  }

  briefing += "---\n_Reply to chat with me_";

  // Send briefing to group General topic, fall back to DM
  const chatId = GROUP_CHAT_ID || DM_CHAT_ID;
  const threadId = GROUP_CHAT_ID ? GENERAL_TOPIC_ID : undefined;
  console.log(`📤 Sending morning briefing to ${GROUP_CHAT_ID ? "group General topic" : "DM"}...`);
  const sent = await sendTelegramMessage(BOT_TOKEN, chatId, briefing, {
    parseMode: "Markdown",
    messageThreadId: threadId,
  });
  if (sent) console.log("✅ Briefing sent!");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const forceRun = process.argv.includes("--force");

  // Dedup: skip if briefing was already sent today (unless --force)
  const stateFile = join(PROJECT_ROOT, "checkin-state.json");
  if (!forceRun) {
    try {
      const { readFile: rf } = await import("fs/promises");
      const state = JSON.parse(await rf(stateFile, "utf-8"));
      const today = new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
      if (state.lastBriefingDate === today) {
        console.log(`⏭️ Briefing already sent today (${today}), skipping. Use --force to override.`);
        return;
      }
    } catch {
      // No state file or parse error — continue
    }
  } else {
    console.log("🔓 --force flag: skipping dedup check");
  }

  // Stagger startup to avoid thundering herd after sleep/wake (skip if forced)
  const startupDelay = forceRun ? 0 : Math.floor(Math.random() * 5000);
  console.log(
    `⏳ Staggering startup by ${Math.round(startupDelay / 1000)}s...`
  );
  await new Promise((r) => setTimeout(r, startupDelay));

  console.log("🌅 Morning Briefing starting...");
  console.log(`📱 Chat: ${GROUP_CHAT_ID || DM_CHAT_ID}`);
  await buildAndSendBriefing();

  // Record that briefing was sent today
  try {
    const { readFile: rf, writeFile: wf } = await import("fs/promises");
    let state: Record<string, any> = {};
    try {
      state = JSON.parse(await rf(stateFile, "utf-8"));
    } catch {}
    state.lastBriefingDate = new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
    await wf(stateFile, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save briefing state:", err);
  }
}

main().catch(console.error);
