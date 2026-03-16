/**
 * Triage Agent
 *
 * Reads a meeting summary, cross-references contacts and goals, and extracts
 * structured action items via Claude Code subprocess (uses subscription, not API key).
 * Writes tasks to Convex triageTasks table.
 *
 * Called from twinmind-monitor.ts after infographic generation.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { runClaudeWithTimeout } from "./lib/claude";
import { addGoal } from "./lib/memory";

// ============================================================
// TYPES
// ============================================================

export interface MeetingSummary {
  meeting_id: string;
  meeting_title: string;
  summary: string;
  action_items?: string;
  start_time: string | number;
  end_time?: string | number;
  metadata?: Record<string, unknown>;
}

interface ExtractedTask {
  project: string;
  description: string;
  suggestion: string;
  relevant_contact?: string;
  relevant_contact_email?: string;
  date?: number; // Unix ms
  confidence_score: number; // 0-100
}

interface ExtractedGoal {
  text: string;          // Goal statement, concise
  deadline?: number;     // Unix ms if a date was mentioned
  is_new_project: boolean; // true if it's a new project kicking off
}

// ============================================================
// CONVEX CLIENT
// ============================================================

function getConvex(): ConvexHttpClient | null {
  const url = process.env.CONVEX_URL;
  if (!url) return null;
  return new ConvexHttpClient(url);
}

// ============================================================
// PROJECTS LIST (from CLAUDE.md — cross-ref context)
// ============================================================

const KNOWN_PROJECTS = [
  "Malaysia Prompt Challenge",
  "WMI Workshop",
  "SIT Enterprise",
  "Philippines Ops",
  "MSG Grant Pipeline",
  "Axiata In-House",
  "GGU Partnership",
  "CIPM/AIGP Certs",
  "Malaysia Marketing",
  "Capabara",
  "DPEX Network",
  "General",
];

// ============================================================
// TRIAGE MEETING
// ============================================================

interface BotContext {
  botToken: string;
  chatId: string;
  threadId?: number;
}

export async function triageMeeting(meeting: MeetingSummary, bot?: BotContext): Promise<number> {
  const cx = getConvex();
  if (!cx) {
    console.log("  [triage] CONVEX_URL not set — skipping triage");
    return 0;
  }

  // Skip if already triaged
  try {
    const existing = await cx.query(api.triageTasks.listByMeeting, { meeting_id: meeting.meeting_id });
    if ((existing as any[]).length > 0) {
      console.log(`  [triage] Already triaged (${(existing as any[]).length} tasks) — skipping`);
      return (existing as any[]).length;
    }
  } catch {}

  console.log(`  [triage] Starting triage for: ${meeting.meeting_title}`);

  // Fetch contacts for context
  let contactsContext = "";
  try {
    const contacts = await cx.query(api.contacts.listAll, {});
    if (contacts.length > 0) {
      contactsContext = contacts
        .slice(0, 100) // Limit to 100 contacts for prompt size
        .map(
          (c: any) =>
            `- ${c.name}${c.email ? ` <${c.email}>` : ""}${c.organization ? ` (${c.organization})` : ""}`
        )
        .join("\n");
    }
  } catch (err) {
    console.log(`  [triage] Could not fetch contacts: ${err}`);
  }

  // Fetch active goals from Convex memory
  let goalsContext = "";
  try {
    const memory = await cx.query(api.memory.getByType, { type: "goal" });
    if ((memory as any[]).length > 0) {
      goalsContext = (memory as any[])
        .map((g: any) => `- ${g.content}${g.deadline ? ` (by ${new Date(g.deadline).toLocaleDateString("en-SG")})` : ""}`)
        .join("\n");
    }
  } catch (err) {
    console.log(`  [triage] Could not fetch goals: ${err}`);
  }

  // Build prompt for claude -p (subscription mode)
  const prompt = `You are a task triage assistant for Alvin Toh, founder of Straits Interactive.
Extract action items from the meeting summary below and classify them by project.

PROJECTS (choose the best fit, use "General" if unclear):
${KNOWN_PROJECTS.join(", ")}

${goalsContext ? `ACTIVE GOALS (flag tasks that advance or relate to these goals in the suggestion field):\n${goalsContext}\n` : ""}${contactsContext ? `CONTACTS (use for relevant_contact matching):\n${contactsContext}\n` : ""}
Analyze the meeting and produce a JSON object with two arrays:

"tasks" — action items to complete. Each item:
- project: string (from the PROJECTS list above)
- description: string (specific, actionable)
- suggestion: string (recommended next step — note if it advances an active goal)
- relevant_contact: string (name of relevant contact — omit if none)
- relevant_contact_email: string (email from CONTACTS list if matched — omit if none)
- date: number (Unix milliseconds if a specific date is mentioned — omit if none)
- confidence_score: number (0-100)

Include only tasks with confidence_score >= 40.

"goals" — new ongoing goals or projects that emerged from this meeting (things to pursue over weeks/months, not one-off tasks). Each item:
- text: string (concise goal statement, e.g. "Close Techno China training deal by April")
- deadline: number (Unix milliseconds if a date was mentioned — omit if none)
- is_new_project: boolean (true if this is a new project kicking off, false if it's a personal/business goal)

Only include goals that are genuinely new — skip anything already in ACTIVE GOALS above. Omit the "goals" array entirely if there are none.

Format your entire response as a JSON object with no surrounding text or markdown fences.

---

MEETING: ${meeting.meeting_title}
DATE: ${meeting.start_time}

SUMMARY:
${meeting.summary}

${meeting.action_items ? `ACTION ITEMS:\n${meeting.action_items}` : "No explicit action items listed."}`;

  let tasks: ExtractedTask[] = [];
  let goals: ExtractedGoal[] = [];
  try {
    const raw = await runClaudeWithTimeout(prompt, 90_000);
    let jsonText = raw.trim();
    // Strip markdown fences if present
    jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(jsonText);
    // Support both { tasks: [...], goals: [...] } and legacy bare array
    if (Array.isArray(parsed)) {
      tasks = parsed as ExtractedTask[];
    } else {
      tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      goals = Array.isArray(parsed.goals) ? parsed.goals : [];
    }
  } catch (err) {
    console.error(`  [triage] Claude subprocess error: ${err}`);
    return 0;
  }

  // Write new goals to Convex memory
  let goalsWritten = 0;
  for (const goal of goals) {
    try {
      const deadline = goal.deadline ? new Date(goal.deadline).toISOString() : undefined;
      await addGoal(goal.text, deadline);
      console.log(`  [triage] New ${goal.is_new_project ? "project" : "goal"}: ${goal.text}`);
      goalsWritten++;
    } catch (err) {
      console.error(`  [triage] Failed to write goal: ${err}`);
    }
  }
  if (goalsWritten > 0) {
    console.log(`  [triage] Added ${goalsWritten} new goal(s)/project(s) to memory`);
  }

  // Write tasks to Convex
  // For tasks with a contact name, check for ambiguous matches before assigning.
  let written = 0;
  const pendingConfirmations: Array<{
    taskId: string;
    description: string;
    contactName: string;
    candidates: Array<{ name: string; email?: string; organization?: string }>;
  }> = [];

  for (const task of tasks) {
    try {
      let assignedContact: string | undefined = undefined;
      let assignedEmail: string | undefined = undefined;

      if (task.relevant_contact) {
        // Look up all fuzzy matches
        let candidates: any[] = [];
        try {
          candidates = await cx.query(api.contacts.searchAllByName, { name: task.relevant_contact });
        } catch {}

        if (candidates.length === 1) {
          // Unambiguous — auto-assign
          assignedContact = candidates[0].name;
          assignedEmail = candidates[0].email;
        } else if (candidates.length > 1) {
          // Ambiguous — save without contact, queue for confirmation
          console.log(`  [triage] Ambiguous contact "${task.relevant_contact}" — ${candidates.length} matches, queuing confirmation`);
        }
        // 0 matches → leave unassigned (unknown contact)
      }

      const taskId = await cx.mutation(api.triageTasks.create, {
        meeting_id: meeting.meeting_id,
        project: task.project || "General",
        description: task.description,
        suggestion: task.suggestion,
        relevant_contact: assignedContact,
        relevant_contact_email: assignedEmail,
        date: task.date,
        confidence_score: Math.min(100, Math.max(0, task.confidence_score)),
        status: "backlog",
        source_meeting_title: meeting.meeting_title,
        created_at: Date.now(),
      });
      written++;

      // If ambiguous, queue confirmation after task is saved
      if (task.relevant_contact) {
        let candidates: any[] = [];
        try {
          candidates = await cx.query(api.contacts.searchAllByName, { name: task.relevant_contact });
        } catch {}
        if (candidates.length > 1) {
          pendingConfirmations.push({
            taskId: taskId as string,
            description: task.description,
            contactName: task.relevant_contact,
            candidates: candidates.map((c: any) => ({
              name: c.name,
              email: c.email,
              organization: c.organization,
            })),
          });
        }
      }
    } catch (err) {
      console.error(`  [triage] Failed to write task: ${err}`);
    }
  }

  console.log(`  [triage] Extracted ${tasks.length} tasks (${written} written), ${goalsWritten} new goals`);

  // Send contact confirmation requests via Telegram
  if (pendingConfirmations.length > 0 && bot?.botToken && bot?.chatId) {
    console.log(`  [triage] Sending ${pendingConfirmations.length} contact confirmation(s) to Telegram`);
    for (const conf of pendingConfirmations) {
      await sendContactConfirmation(bot, conf);
    }
  }

  return written;
}

async function sendContactConfirmation(
  bot: { botToken: string; chatId: string; threadId?: number },
  conf: {
    taskId: string;
    description: string;
    contactName: string;
    candidates: Array<{ name: string; email?: string; organization?: string }>;
  }
): Promise<void> {
  const desc = conf.description.slice(0, 80) + (conf.description.length > 80 ? "…" : "");
  const text = `👤 *Who is "${conf.contactName}"?*\n_Task: ${desc}_`;

  // Build buttons — one per candidate + None. Data: cc:<taskId>:<idx> or cc:<taskId>:x
  // Telegram callback_data limit: 64 bytes
  const buttons = [
    ...conf.candidates.map((c, i) => {
      const label = c.organization ? `${c.name} (${c.organization})` : c.name;
      return [{ text: label.slice(0, 40), callback_data: `cc:${conf.taskId}:${i}` }];
    }),
    [{ text: "None / Unknown", callback_data: `cc:${conf.taskId}:x` }],
  ];

  const body: Record<string, unknown> = {
    chat_id: bot.chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  };
  if (bot.threadId) body.message_thread_id = bot.threadId;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error(`  [triage] Failed to send contact confirmation: ${await resp.text()}`);
    }
  } catch (err) {
    console.error(`  [triage] Contact confirmation send error: ${err}`);
  }
}

// ============================================================
// SEND TRIAGE SUMMARY TO TELEGRAM
// ============================================================

export async function sendTriageSummary(
  botToken: string,
  chatId: string,
  meetingTitle: string,
  taskCount: number,
  messageThreadId?: number
): Promise<void> {
  const boardId = process.env.STARTINFINITY_BOARD_ID ?? "";
  const workspaceId = process.env.STARTINFINITY_WORKSPACE_ID ?? "";
  const dashboardUrl = boardId && workspaceId
    ? `https://app.startinfinity.com/board/${boardId}`
    : (process.env.TRIAGE_DASHBOARD_URL ?? "https://app.startinfinity.com");

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: `📋 *Triaged ${taskCount} task${taskCount !== 1 ? "s" : ""}* from _${meetingTitle}_\n\nView and manage on the dashboard:`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "📋 View Tasks", url: dashboardUrl }]],
    },
  };

  if (messageThreadId) body.message_thread_id = messageThreadId;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error(`  [triage] Failed to send Telegram summary: ${await resp.text()}`);
    } else {
      console.log(`  [triage] Sent Telegram triage summary (${taskCount} tasks)`);
    }
  } catch (err) {
    console.error(`  [triage] Telegram send error: ${err}`);
  }
}
