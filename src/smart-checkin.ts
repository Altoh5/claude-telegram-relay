/**
 * Smart Check-in
 *
 * Runs periodically via launchd/PM2. Gathers context from Supabase
 * (goals, facts, recent messages) and spawns Claude Code to decide
 * IF, HOW (text or call), and WHAT to say.
 *
 * Claude Code has access to whatever MCP servers you've configured,
 * so it can check your calendar, emails, etc. automatically.
 *
 * Run manually: bun run src/smart-checkin.ts
 * Scheduled: launchd at configurable intervals
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { loadEnv } from "./lib/env";
import { sendTelegramMessage } from "./lib/telegram";
import { runClaudeWithTimeout } from "./lib/claude";

// Load environment
await loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
const USER_TIMEZONE = process.env.USER_TIMEZONE || "UTC";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

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
  // Try Supabase first, fall back to local file
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      const headers = {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      };

      const [factsRes, goalsRes] = await Promise.all([
        fetch(
          `${SUPABASE_URL}/rest/v1/memory?type=eq.fact&select=content&order=created_at.desc&limit=10`,
          { headers }
        ),
        fetch(
          `${SUPABASE_URL}/rest/v1/memory?type=eq.goal&select=content,metadata&order=created_at.desc&limit=10`,
          { headers }
        ),
      ]);

      const facts = factsRes.ok
        ? (await factsRes.json()).map((f: any) => f.content)
        : [];
      const goals = goalsRes.ok
        ? (await goalsRes.json()).map((g: any) => ({
            text: g.content,
            deadline: g.metadata?.deadline,
            createdAt: g.metadata?.createdAt || "",
          }))
        : [];

      return { facts, goals, completedGoals: [] };
    } catch (err) {
      console.error("Supabase memory fetch failed, trying local:", err);
    }
  }

  // Local fallback
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
  // Try Supabase first
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/messages?select=role,content,created_at&order=created_at.desc&limit=15`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
        }
      );
      if (res.ok) {
        const messages = await res.json();
        if (messages.length > 0) {
          return messages
            .reverse()
            .map(
              (m: any) =>
                `[${m.created_at}] ${m.role}: ${m.content?.substring(0, 500)}`
            )
            .join("\n");
        }
      }
    } catch {}
  }

  // Local fallback: read log files
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
// DECISION ENGINE
// ============================================================

async function shouldCheckIn(
  state: CheckinState,
  memory: Memory,
  recentConvo: string
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

// Stagger startup to avoid thundering herd after sleep/wake
const startupDelay = Math.floor(Math.random() * 30000);
console.log(`⏳ Staggering startup by ${Math.round(startupDelay / 1000)}s...`);
await new Promise(r => setTimeout(r, startupDelay));

console.log(
  `\n🔄 Smart check-in running at ${new Date().toLocaleTimeString()}...`
);

const state = await loadState();
const memory = await loadMemory();
const recentConvo = await getRecentConversations();

runHealth.push({ step: "State loaded", status: "ok", detail: `Goals: ${memory.goals.length}, Facts: ${memory.facts.length}` });

const { action, message, reason } = await shouldCheckIn(
  state,
  memory,
  recentConvo
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
  const askMessage = `📞 I'd like to call you about:\n\n${message.substring(0, 500)}`;

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
