/**
 * Go - Morning Briefing
 *
 * Sends a daily summary via Telegram:
 * - Active goals from memory
 * - Calendar events (if configured via Claude MCP)
 * - AI News from Grok/xAI (optional)
 *
 * Run manually: bun run src/morning-briefing.ts
 * Scheduled: launchd at your preferred morning time
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { loadEnv } from "./lib/env";
import { sendTelegramMessage, sanitizeForTelegram } from "./lib/telegram";
import {
  getValidAccessToken,
  isGoogleAuthAvailable,
  KEYCHAIN_CALENDAR,
} from "./lib/google-auth";

// Load environment
await loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
const USER_TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const XAI_API_KEY = process.env.XAI_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// ============================================================
// DATA GATHERING
// ============================================================

async function getActiveGoals(): Promise<{
  count: number;
  goals: string[];
}> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // Try local memory file
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

    if (!response.ok) {
      return { count: 0, goals: ["Could not fetch goals"] };
    }

    const data = await response.json();
    const goals = data.map((g: any) => {
      const deadline = g.metadata?.deadline ? ` (${g.metadata.deadline})` : "";
      return `• ${g.content}${deadline}`;
    });

    return { count: data.length, goals };
  } catch {
    return { count: 0, goals: ["Error fetching goals"] };
  }
}

async function getCalendarToday(): Promise<string> {
  // Direct Google Calendar REST API — no Claude subprocess needed.
  // This is instant (<1s) vs 45-180s via Claude subprocess.
  // See docs/architecture.md "Direct API vs Claude Subprocess" for why.
  const hasCalendar = await isGoogleAuthAvailable(KEYCHAIN_CALENDAR);
  if (!hasCalendar) {
    return "📅 **TODAY**: Calendar not configured";
  }

  try {
    const today = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000)
      .toISOString()
      .split("T")[0];

    const accessToken = await getValidAccessToken(KEYCHAIN_CALENDAR);
    const params = new URLSearchParams({
      timeMin: `${today}T00:00:00Z`,
      timeMax: `${tomorrow}T23:59:59Z`,
      maxResults: "20",
      singleEvents: "true",
      orderBy: "startTime",
    });

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) throw new Error(`Calendar API: ${res.status}`);
    const data = (await res.json()) as { items?: any[] };
    const events = data.items || [];

    if (events.length === 0) {
      return "📅 **TODAY**: Clear schedule";
    }

    const formatted = events.map((e: any) => {
      const title = e.summary || "Untitled";
      const start = e.start?.dateTime || e.start?.date || "";
      const time = start.includes("T")
        ? start.split("T")[1]?.substring(0, 5) || ""
        : "all-day";
      return `• ${time} - ${title}`;
    });

    return `📅 **TODAY** (${events.length} events)\n${formatted.join("\n")}`;
  } catch {
    return "📅 **TODAY**: Could not fetch calendar";
  }
}

async function getAINews(): Promise<string> {
  if (!XAI_API_KEY) {
    return "";
  }

  const today = new Date().toLocaleDateString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  try {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-3-fast",
        messages: [
          {
            role: "system",
            content:
              "You are an AI news analyst with real-time access to X/Twitter. Provide concise, specific, factual summaries.",
          },
          {
            role: "user",
            content: `Today is ${today}. Search X/Twitter for the most important AI news from the last 24 hours. Max 5 items, each with date, source, and what happened. If nothing notable, say so.`,
          },
        ],
        search: {
          mode: "auto",
          sources: [{ type: "x" }, { type: "web" }],
          recency_filter: "day",
        },
        temperature: 0.7,
        max_tokens: 600,
      }),
    });

    if (!response.ok) return "Could not fetch AI news";

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "No AI news found";
  } catch {
    return "Error fetching AI news";
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
  const [goals, calendar, aiNews] = await Promise.all([
    getActiveGoals(),
    getCalendarToday(),
    getAINews(),
  ]);

  // Build main briefing
  let briefing = `☀️ **GOOD MORNING ${userName.toUpperCase()}**\n_${dateStr}_\n\n`;
  briefing += calendar + "\n\n";
  briefing += `🎯 **GOALS** (${goals.count} active)\n`;
  briefing += goals.goals.length > 0 ? goals.goals.join("\n") : "No active goals";
  briefing += "\n\n---\n_Reply to chat with me_";

  // Send main briefing
  console.log("📤 Sending morning briefing...");
  const sent = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, briefing, {
    parseMode: "Markdown",
  });
  if (sent) console.log("✅ Briefing sent!");

  // Send AI news separately if available
  if (aiNews && !aiNews.includes("not fetch") && !aiNews.includes("Error")) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const newsMessage = `🤖 **AI NEWS** (${dateStr})\n\n${aiNews}`;
    await sendTelegramMessage(BOT_TOKEN, CHAT_ID, newsMessage, {
      parseMode: "Markdown",
    });
    console.log("✅ AI news sent!");
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  // Stagger startup to avoid thundering herd after sleep/wake
  const startupDelay = Math.floor(Math.random() * 30000);
  console.log(`⏳ Staggering startup by ${Math.round(startupDelay / 1000)}s...`);
  await new Promise(r => setTimeout(r, startupDelay));

  console.log("🌅 Go Morning Briefing starting...");
  console.log(`📱 Chat: ${CHAT_ID}`);
  console.log(`🔑 Grok API: ${XAI_API_KEY ? "configured" : "not set"}`);
  await buildAndSendBriefing();
}

main().catch(console.error);
