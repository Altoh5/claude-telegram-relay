/**
 * Morning Briefing
 *
 * Sends a daily summary via Telegram:
 * - Active goals from memory (Supabase or local)
 * - Whatever context Claude Code can gather via your MCP servers
 *   (Calendar, Gmail, etc. — depends on what you've configured)
 *
 * Claude Code has access to all your MCP servers, so it can pull
 * calendar events, unread emails, etc. automatically.
 *
 * Run manually: bun run src/morning-briefing.ts
 * Scheduled: launchd at your preferred morning time
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { loadEnv } from "./lib/env";
import { sendTelegramMessage, sanitizeForTelegram } from "./lib/telegram";
import { runClaudeWithTimeout } from "./lib/claude";

// Load environment
await loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
const USER_TIMEZONE = process.env.USER_TIMEZONE || "UTC";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// ============================================================
// DATA GATHERING
// ============================================================

async function getActiveGoals(): Promise<{
  count: number;
  goals: string[];
}> {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/memory?type=eq.goal&select=content,metadata&order=created_at.desc&limit=5`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        const goals = data.map((g: any) => {
          const deadline = g.metadata?.deadline ? ` (${g.metadata.deadline})` : "";
          return `• ${g.content}${deadline}`;
        });
        return { count: data.length, goals };
      }
    } catch {}
  }

  // Local fallback
  try {
    const content = await readFile(
      join(PROJECT_ROOT, "memory.json"),
      "utf-8"
    );
    const memory = JSON.parse(content);
    const goals = memory.goals?.map(
      (g: any) =>
        `• ${g.text}${g.deadline ? ` (${g.deadline})` : ""}`
    ) || [];
    return { count: goals.length, goals };
  } catch {
    return { count: 0, goals: ["No goals tracked yet"] };
  }
}

async function getClaudeBriefingContext(): Promise<string> {
  // Ask Claude Code to gather today's context using whatever MCP servers
  // are configured (Calendar, Gmail, Notion, etc.)
  const prompt = `Generate a brief morning context summary. Check:
1. Today's calendar events (if you have calendar access)
2. Important unread emails (if you have email access)
3. Any urgent tasks or deadlines

Keep it very concise — bullet points only.
If you don't have access to a service, skip it silently.
Format: just the raw data, no greetings or fluff.`;

  try {
    const output = await runClaudeWithTimeout(prompt, 90000);
    return output.trim();
  } catch (err) {
    console.error("Claude briefing context failed:", err);
    return "";
  }
}

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

  // Gather data in parallel
  const [goals, claudeContext] = await Promise.all([
    getActiveGoals(),
    getClaudeBriefingContext(),
  ]);

  // Build main briefing
  let briefing = `☀️ **GOOD MORNING ${userName.toUpperCase()}**\n_${dateStr}_\n\n`;

  // Add Claude's context (calendar, emails, etc.) if available
  if (claudeContext) {
    briefing += `📋 **TODAY'S CONTEXT**\n${claudeContext}\n\n`;
  }

  briefing += `🎯 **GOALS** (${goals.count} active)\n`;
  briefing += goals.goals.length > 0 ? goals.goals.join("\n") : "No active goals";
  briefing += "\n\n---\n_Reply to chat with me_";

  // Send briefing
  console.log("📤 Sending morning briefing...");
  const sent = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, briefing, {
    parseMode: "Markdown",
  });
  if (sent) console.log("✅ Briefing sent!");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  // Stagger startup to avoid thundering herd after sleep/wake
  const startupDelay = Math.floor(Math.random() * 30000);
  console.log(`⏳ Staggering startup by ${Math.round(startupDelay / 1000)}s...`);
  await new Promise(r => setTimeout(r, startupDelay));

  console.log("🌅 Morning Briefing starting...");
  console.log(`📱 Chat: ${CHAT_ID}`);
  await buildAndSendBriefing();
}

main().catch(console.error);
