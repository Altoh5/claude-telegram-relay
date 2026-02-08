/**
 * Go - Smart Check-in
 *
 * Runs periodically via launchd. Claude decides IF, HOW (text or call),
 * and WHAT to say based on full context: conversations, goals, memory.
 *
 * Run manually: bun run src/smart-checkin.ts
 * Scheduled: launchd at configurable intervals
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { loadEnv } from "./lib/env";
import { sendTelegramMessage } from "./lib/telegram";
import { runClaudeWithTimeout, extractJSON } from "./lib/claude";
import {
  getValidAccessToken,
  isGoogleAuthAvailable,
  KEYCHAIN_GMAIL,
  KEYCHAIN_CALENDAR,
} from "./lib/google-auth";

// Load environment
await loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
const USER_TIMEZONE = process.env.USER_TIMEZONE || "UTC";

const STATE_FILE = join(PROJECT_ROOT, "checkin-state.json");
const MEMORY_FILE = join(PROJECT_ROOT, "memory.json");
const HISTORY_DIR = join(PROJECT_ROOT, "logs");

// Run health tracker
const runHealth: { step: string; status: "ok" | "fail"; detail: string }[] = [];

// ============================================================
// INTERFACES
// ============================================================

interface CheckinState {
  lastMessageTime: string;
  lastCheckinTime: string;
  lastCallTime: string;
  pendingItems: string[];
  context: string;
}

interface Memory {
  facts: string[];
  goals: { text: string; deadline?: string; createdAt: string }[];
  completedGoals: { text: string; completedAt: string }[];
}

interface EmailSummary {
  totalUnread: number;
  importantCount: number;
}

interface CalendarContext {
  todayEvents: { title: string; time: string }[];
  upcomingEvents: { title: string; date: string; time: string }[];
}

// ============================================================
// STATE MANAGEMENT
// ============================================================

async function loadState(): Promise<CheckinState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastMessageTime: new Date().toISOString(),
      lastCheckinTime: "",
      lastCallTime: "",
      pendingItems: [],
      context: "",
    };
  }
}

async function saveState(state: CheckinState) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadMemory(): Promise<Memory> {
  try {
    const content = await readFile(MEMORY_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { facts: [], goals: [], completedGoals: [] };
  }
}

// ============================================================
// CONTEXT GATHERING
// ============================================================

async function getRecentConversations(): Promise<string> {
  let allContent = "";
  try {
    const files = await readdir(HISTORY_DIR);
    const logFiles = files
      .filter((f) => f.endsWith(".md") || f.endsWith(".log"))
      .sort()
      .slice(-3);

    for (const file of logFiles) {
      const content = await readFile(join(HISTORY_DIR, file), "utf-8").catch(
        () => ""
      );
      allContent += `\n--- ${file} ---\n${content.slice(-3000)}\n`;
    }
  } catch {
    return "No conversation history found.";
  }

  return allContent.slice(-8000) || "No conversations.";
}

// ============================================================
// DATA GATHERING (Direct Google APIs — no Claude subprocess)
// ============================================================
// WHY: Claude subprocesses take 60-180s to start from launchd because
// they initialize all MCP servers. Direct API calls are instant (<1s).
// See docs/architecture.md "Direct API vs Claude Subprocess" for details.

async function checkEmails(): Promise<EmailSummary> {
  const hasGmail = await isGoogleAuthAvailable(KEYCHAIN_GMAIL);
  if (!hasGmail) return { totalUnread: 0, importantCount: 0 };

  try {
    const accessToken = await getValidAccessToken(KEYCHAIN_GMAIL);
    const headers = { Authorization: `Bearer ${accessToken}` };

    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent("is:unread newer_than:1d")}&maxResults=10`,
      { headers }
    );
    if (!res.ok) throw new Error(`Gmail API: ${res.status}`);
    const data = (await res.json()) as {
      messages?: { id: string }[];
      resultSizeEstimate?: number;
    };
    return {
      totalUnread: data.resultSizeEstimate || (data.messages?.length ?? 0),
      importantCount: data.messages?.length ?? 0,
    };
  } catch (error) {
    console.error(`Email check error: ${error}`);
    throw error;
  }
}

async function getCalendarEvents(): Promise<CalendarContext> {
  const hasCalendar = await isGoogleAuthAvailable(KEYCHAIN_CALENDAR);
  if (!hasCalendar)
    return { todayEvents: [], upcomingEvents: [] };

  try {
    const today = new Date().toISOString().split("T")[0];
    const threeDaysOut = new Date(Date.now() + 3 * 86400000)
      .toISOString()
      .split("T")[0];

    const accessToken = await getValidAccessToken(KEYCHAIN_CALENDAR);
    const params = new URLSearchParams({
      timeMin: `${today}T00:00:00Z`,
      timeMax: `${threeDaysOut}T23:59:59Z`,
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

    const todayEvents: CalendarContext["todayEvents"] = [];
    const upcomingEvents: CalendarContext["upcomingEvents"] = [];

    for (const event of data.items || []) {
      const title = event.summary || "Untitled";
      const start = event.start?.dateTime || event.start?.date || "";
      const date = start.split("T")[0] || "";
      const time = start.includes("T")
        ? start.split("T")[1]?.substring(0, 5) || ""
        : "all-day";
      if (date === today) todayEvents.push({ title, time });
      else upcomingEvents.push({ title, date, time });
    }
    return { todayEvents, upcomingEvents };
  } catch (error) {
    console.error(`Calendar check error: ${error}`);
    throw error;
  }
}

// ============================================================
// DECISION ENGINE
// ============================================================

async function shouldCheckIn(
  state: CheckinState,
  memory: Memory,
  recentConvo: string,
  emailSummary: EmailSummary,
  calendarContext: CalendarContext
): Promise<{ action: "none" | "text" | "call"; message: string; reason: string }> {
  const now = new Date();
  const hour = parseInt(
    now.toLocaleString("en-US", { timeZone: USER_TIMEZONE, hour: "numeric", hour12: false })
  );
  const dayOfWeek = now.toLocaleDateString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
  });

  const timeSinceLastMessage = state.lastMessageTime
    ? Math.round(
        (now.getTime() - new Date(state.lastMessageTime).getTime()) /
          (1000 * 60)
      )
    : 999;

  const timeSinceLastCheckin = state.lastCheckinTime
    ? Math.round(
        (now.getTime() - new Date(state.lastCheckinTime).getTime()) /
          (1000 * 60)
      )
    : 999;

  const goalsText =
    memory.goals.length > 0
      ? memory.goals
          .map(
            (g) =>
              `- ${g.text}${g.deadline ? ` (by ${g.deadline})` : ""}`
          )
          .join("\n")
      : "None";

  const factsText =
    memory.facts.length > 0
      ? memory.facts.map((f) => `- ${f}`).join("\n")
      : "None";

  // Load user profile for context
  let userProfile = "";
  try {
    userProfile = await readFile(
      join(PROJECT_ROOT, "config", "profile.md"),
      "utf-8"
    );
  } catch {}

  const prompt = `You are a proactive AI assistant. Analyze the context and decide:
1. Should you reach out RIGHT NOW?
2. If yes, should you TEXT or CALL?

CURRENT TIME & CONTEXT:
- Time: ${now.toLocaleTimeString("en-US", { timeZone: USER_TIMEZONE })} on ${dayOfWeek}
- Hour: ${hour}

${userProfile ? `USER PROFILE:\n${userProfile}\n` : ""}

TIMING:
- Minutes since last user message: ${timeSinceLastMessage}
- Minutes since last check-in: ${timeSinceLastCheckin}

ACTIVE GOALS:
${goalsText}

THINGS TO REMEMBER:
${factsText}

PENDING ITEMS:
${state.pendingItems.length > 0 ? state.pendingItems.join("\n") : "None"}

RECENT CONVERSATIONS:
${recentConvo.substring(0, 4000)}

EMAILS:
${emailSummary.totalUnread > 0 ? `${emailSummary.totalUnread} unread emails` : "No unread emails"}

CALENDAR:
${(() => {
  const events = [
    ...calendarContext.todayEvents.map(e => `TODAY ${e.time}: ${e.title}`),
    ...calendarContext.upcomingEvents.map(e => `${e.date} ${e.time}: ${e.title}`),
  ];
  return events.length > 0 ? events.join("\n") : "No upcoming events";
})()}

DECISION RULES:

PROACTIVE PRESENCE:
- YES, TEXT if it's been 3+ hours since last check-in during working hours
- A simple "How's it going?" or "Anything I can help with?" is fine
- If last MESSAGE was 12+ hours ago, definitely reach out

HARD LIMITS:
- NO contact if checked in less than 90 minutes ago (unless urgent)
- NO contact before 9am or after 9pm user's time
- CALL only for urgent items or deadline-day goals

RESPOND IN THIS EXACT FORMAT:
ACTION: NONE, TEXT, or CALL
MESSAGE: [If TEXT: the message. If CALL: context. If NONE: "none"]
REASON: [Why you made this decision]`;

  try {
    const output = await runClaudeWithTimeout(prompt, 60000);

    const actionMatch = output.match(/ACTION:\s*(NONE|TEXT|CALL)/i);
    const messageMatch = output.match(/MESSAGE:\s*(.+?)(?=REASON:|$)/is);
    const reasonMatch = output.match(/REASON:\s*(.+)/is);

    return {
      action: ((actionMatch?.[1]?.toUpperCase() || "NONE").toLowerCase()) as
        | "none"
        | "text"
        | "call",
      message: messageMatch?.[1]?.trim() || "",
      reason: reasonMatch?.[1]?.trim() || "",
    };
  } catch (error) {
    console.error("Claude error:", error);
    return { action: "none", message: "", reason: "Error" };
  }
}

// ============================================================
// MAIN
// ============================================================

console.log(
  `\n🔄 Smart check-in running at ${new Date().toLocaleTimeString()}...`
);

const state = await loadState();
const memory = await loadMemory();
const recentConvo = await getRecentConversations();

// Gather email and calendar data via direct APIs (instant, <1s)
let emailSummary: EmailSummary = { totalUnread: 0, importantCount: 0 };
try {
  emailSummary = await checkEmails();
  console.log(`📧 Emails: ${emailSummary.totalUnread} unread`);
  runHealth.push({ step: "Email check", status: "ok", detail: `${emailSummary.totalUnread} unread` });
} catch (e) {
  console.error(`❌ Email check failed: ${e}`);
  runHealth.push({ step: "Email check", status: "fail", detail: String(e) });
}

let calendarContext: CalendarContext = { todayEvents: [], upcomingEvents: [] };
try {
  calendarContext = await getCalendarEvents();
  console.log(`📅 Calendar: ${calendarContext.todayEvents.length} today, ${calendarContext.upcomingEvents.length} upcoming`);
  runHealth.push({ step: "Calendar", status: "ok", detail: `${calendarContext.todayEvents.length} today, ${calendarContext.upcomingEvents.length} upcoming` });
} catch (e) {
  console.error(`❌ Calendar check failed: ${e}`);
  runHealth.push({ step: "Calendar", status: "fail", detail: String(e) });
}

const { action, message, reason } = await shouldCheckIn(
  state,
  memory,
  recentConvo,
  emailSummary,
  calendarContext
);

console.log(`🤔 Decision: ${action.toUpperCase()}`);
console.log(`💭 Reason: ${reason}`);

if (action === "text" && message && message.toLowerCase() !== "none") {
  console.log(`📤 Sending: ${message.substring(0, 80)}...`);

  const buttons = [
    [
      { text: "😴 Snooze 30m", callback_data: "snooze" },
      { text: "✓ Got it", callback_data: "dismiss" },
    ],
  ];

  await sendTelegramMessage(BOT_TOKEN, CHAT_ID, message, {
    parseMode: "Markdown",
    buttons,
  });

  state.lastCheckinTime = new Date().toISOString();
  await saveState(state);
  console.log("✅ Text sent!");
} else if (action === "call" && message) {
  console.log(`📞 Want to call about: ${message}`);
  const askMessage = `📞 I'd like to call you about:\n\n${message.substring(0, 150)}`;

  const callButtons = [
    [
      { text: "✅ Yes, call me", callback_data: "call_yes" },
      { text: "❌ Not now", callback_data: "call_no" },
    ],
  ];

  await sendTelegramMessage(BOT_TOKEN, CHAT_ID, askMessage, { buttons: callButtons });

  state.pendingItems = [`PENDING_CALL: ${message}`];
  state.lastCheckinTime = new Date().toISOString();
  await saveState(state);
  console.log("✅ Asked permission to call");
} else {
  console.log("💤 No check-in needed right now.");
}

// Run health summary
const failures = runHealth.filter((r) => r.status === "fail");
if (runHealth.length > 0) {
  console.log("\n--- RUN HEALTH ---");
  for (const r of runHealth) {
    console.log(`  ${r.status === "ok" ? "✅" : "❌"} ${r.step}: ${r.detail}`);
  }
  if (failures.length > 0) {
    console.log(`\n⚠️ ${failures.length}/${runHealth.length} steps failed`);
  }
}
