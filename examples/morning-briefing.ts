/**
 * Morning Briefing Example
 *
 * Sends a daily summary via Telegram at a scheduled time.
 * Customize this for your own morning routine.
 *
 * Schedule this with:
 * - macOS: launchd (see daemon/morning-briefing.plist)
 * - Linux: cron or systemd timer
 * - Windows: Task Scheduler
 *
 * Run manually: bun run examples/morning-briefing.ts
 */

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

// ============================================================
// TELEGRAM HELPER
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );

    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// DATA FETCHERS (customize these for your sources)
// ============================================================

async function getUnreadEmails(): Promise<string> {
  return "_Connect Gmail to enable inbox summary_";
}

async function getCalendarEvents(): Promise<string> {
  return "_Connect Google Calendar to enable schedule_";
}

async function getActiveGoals(): Promise<string> {
  const { data: goals } = await supabase.rpc("get_active_goals");
  const { data: facts } = await supabase.rpc("get_facts");

  const lines: string[] = [];

  if (goals && goals.length > 0) {
    lines.push("*Goals:*");
    for (const g of goals.slice(0, 5)) {
      const deadline = g.deadline
        ? ` (due ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      lines.push(`- ${g.content}${deadline}`);
    }
  }

  if (facts && facts.length > 0) {
    lines.push("*Recent facts:*");
    for (const f of facts.slice(0, 3)) {
      lines.push(`- ${f.content}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "No active goals";
}

async function getWeather(): Promise<string> {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=1.3521&longitude=103.8198&current=temperature_2m,relative_humidity_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=Asia/Singapore&forecast_days=1";
  const res = await fetch(url);
  const data = await res.json();

  const current = data.current;
  const daily = data.daily;
  const temp = current.temperature_2m;
  const humidity = current.relative_humidity_2m;
  const high = daily.temperature_2m_max[0];
  const low = daily.temperature_2m_min[0];
  const condition = weatherCodeToText(current.weather_code);

  return `${condition}, ${temp}°C (H: ${high}° L: ${low}°) · Humidity: ${humidity}%`;
}

function weatherCodeToText(code: number): string {
  const map: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Heavy drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    80: "Light showers",
    81: "Showers",
    82: "Heavy showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Heavy thunderstorm with hail",
  };
  return map[code] || "Unknown";
}

async function getAINews(): Promise<string> {
  const topRes = await fetch(
    "https://hacker-news.firebaseio.com/v0/topstories.json"
  );
  const topIds: number[] = await topRes.json();

  const stories = await Promise.all(
    topIds.slice(0, 15).map(async (id) => {
      const res = await fetch(
        `https://hacker-news.firebaseio.com/v0/item/${id}.json`
      );
      return res.json();
    })
  );

  const aiKeywords = /\b(ai|llm|gpt|claude|openai|anthropic|gemini|machine learning|deep learning|neural|transformer|diffusion|copilot)\b/i;
  const relevant = stories
    .filter((s) => s && s.title && aiKeywords.test(s.title))
    .slice(0, 5);

  if (relevant.length === 0) {
    // Fall back to top 5 stories if no AI-specific ones found
    return stories
      .filter((s) => s && s.title)
      .slice(0, 5)
      .map((s) => `- ${s.title} (${s.score}⬆)`)
      .join("\n");
  }

  return relevant.map((s) => `- ${s.title} (${s.score}⬆)`).join("\n");
}

// ============================================================
// BUILD BRIEFING
// ============================================================

async function buildBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const sections: string[] = [];

  // Header
  sections.push(`🌅 **Good Morning!**\n${dateStr}\n`);

  // Weather (optional)
  try {
    const weather = await getWeather();
    sections.push(`☀️ **Weather**\n${weather}\n`);
  } catch (e) {
    console.error("Weather fetch failed:", e);
  }

  // Calendar
  try {
    const calendar = await getCalendarEvents();
    if (calendar) {
      sections.push(`📅 **Today's Schedule**\n${calendar}\n`);
    }
  } catch (e) {
    console.error("Calendar fetch failed:", e);
  }

  // Emails
  try {
    const emails = await getUnreadEmails();
    if (emails) {
      sections.push(`📧 **Inbox**\n${emails}\n`);
    }
  } catch (e) {
    console.error("Email fetch failed:", e);
  }

  // Goals
  try {
    const goals = await getActiveGoals();
    if (goals) {
      sections.push(`🎯 **Active Goals**\n${goals}\n`);
    }
  } catch (e) {
    console.error("Goals fetch failed:", e);
  }

  // AI News (optional)
  try {
    const news = await getAINews();
    if (news) {
      sections.push(`🤖 **AI News**\n${news}\n`);
    }
  } catch (e) {
    console.error("News fetch failed:", e);
  }

  // Footer
  sections.push("---\n_Reply to continue the conversation_");

  return sections.join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building morning briefing...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const briefing = await buildBriefing();

  console.log("Sending briefing...");
  const success = await sendTelegram(briefing);

  if (success) {
    console.log("Briefing sent successfully!");
  } else {
    console.error("Failed to send briefing");
    process.exit(1);
  }
}

main();

// ============================================================
// LAUNCHD PLIST FOR SCHEDULING (macOS)
// ============================================================
/*
Save this as ~/Library/LaunchAgents/com.claude.morning-briefing.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.morning-briefing</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/morning-briefing.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-telegram-relay</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/morning-briefing.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/morning-briefing.error.log</string>
</dict>
</plist>

Load with: launchctl load ~/Library/LaunchAgents/com.claude.morning-briefing.plist
*/

// ============================================================
// CRON FOR SCHEDULING (Linux)
// ============================================================
/*
Add to crontab with: crontab -e

# Run at 9:00 AM every day
0 9 * * * cd /path/to/claude-telegram-relay && /home/USER/.bun/bin/bun run examples/morning-briefing.ts >> /tmp/morning-briefing.log 2>&1
*/
