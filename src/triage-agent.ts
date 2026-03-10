/**
 * Triage Agent
 *
 * Reads a meeting summary, cross-references contacts, and extracts structured
 * action items via Claude API. Writes tasks to Convex triageTasks table.
 *
 * Called from twinmind-monitor.ts after infographic generation.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

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

export async function triageMeeting(meeting: MeetingSummary): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("  [triage] ANTHROPIC_API_KEY not set — skipping triage");
    return 0;
  }

  const cx = getConvex();
  if (!cx) {
    console.log("  [triage] CONVEX_URL not set — skipping triage");
    return 0;
  }

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

  // Build system prompt
  const systemPrompt = `You are a task triage assistant for Alvin Toh, founder of Straits Interactive.
Extract action items from the meeting summary below and classify them by project.

PROJECTS (choose the best fit, use "General" if unclear):
${KNOWN_PROJECTS.join(", ")}

${contactsContext ? `CONTACTS (use for relevant_contact matching):\n${contactsContext}\n` : ""}

For each action item, output a JSON object with these fields:
- project: string (from the PROJECTS list above)
- description: string (the specific action item, clear and actionable)
- suggestion: string (your recommended next step, specific and concrete)
- relevant_contact: string | undefined (name of relevant contact, if any)
- relevant_contact_email: string | undefined (email of relevant contact, if known from CONTACTS list)
- date: number | undefined (Unix milliseconds timestamp if a specific date is mentioned, otherwise omit)
- confidence_score: number (0-100, how certain this is a real action item requiring follow-up)

Only include tasks with confidence_score >= 40.
Return ONLY a valid JSON array. No markdown fences, no explanations.`;

  const userMessage = `MEETING: ${meeting.meeting_title}
DATE: ${meeting.start_time}

SUMMARY:
${meeting.summary}

${meeting.action_items ? `ACTION ITEMS:\n${meeting.action_items}` : "No explicit action items listed."}`;

  const anthropic = new Anthropic({ apiKey });

  let tasks: ExtractedTask[] = [];
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: userMessage }],
      system: systemPrompt,
    });

    const content = response.content[0];
    if (content.type !== "text") {
      console.error("  [triage] Unexpected response type from Claude");
      return 0;
    }

    // Strip markdown fences if present
    let jsonText = content.text.trim();
    jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

    tasks = JSON.parse(jsonText) as ExtractedTask[];
    if (!Array.isArray(tasks)) {
      console.error("  [triage] Claude did not return an array");
      return 0;
    }
  } catch (err) {
    console.error(`  [triage] Claude API error: ${err}`);
    return 0;
  }

  // Write tasks to Convex
  let written = 0;
  for (const task of tasks) {
    try {
      await cx.mutation(api.triageTasks.create, {
        meeting_id: meeting.meeting_id,
        project: task.project || "General",
        description: task.description,
        suggestion: task.suggestion,
        relevant_contact: task.relevant_contact,
        relevant_contact_email: task.relevant_contact_email,
        date: task.date,
        confidence_score: Math.min(100, Math.max(0, task.confidence_score)),
        status: "backlog",
        source_meeting_title: meeting.meeting_title,
        created_at: Date.now(),
      });
      written++;
    } catch (err) {
      console.error(`  [triage] Failed to write task: ${err}`);
    }
  }

  console.log(
    `  [triage] Extracted ${tasks.length} tasks, wrote ${written} to Convex`
  );
  return written;
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
  const dashboardUrl =
    process.env.TRIAGE_DASHBOARD_URL ?? "http://localhost:3002";

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: `📋 *Triaged ${taskCount} task${taskCount !== 1 ? "s" : ""}* from _${meetingTitle}_\n\nView and manage on the dashboard:`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📋 View Tasks",
            web_app: { url: dashboardUrl },
          },
        ],
      ],
    },
  };

  if (messageThreadId) {
    body.message_thread_id = messageThreadId;
  }

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`  [triage] Failed to send Telegram summary: ${err}`);
    } else {
      console.log(
        `  [triage] Sent Telegram triage summary (${taskCount} tasks)`
      );
    }
  } catch (err) {
    console.error(`  [triage] Telegram send error: ${err}`);
  }
}
