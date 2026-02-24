/**
 * TwinMind Meeting Monitor
 *
 * Checks Supabase for unprocessed meeting summaries (synced from
 * interactive Claude Code sessions via twinmind-sync.ts).
 * Creates standard + sketchnote infographics via NotebookLM.
 * Sends summary text + both infographics to Telegram.
 *
 * Run manually: bun run src/twinmind-monitor.ts [--force]
 * Scheduled: launchd every 30 min (8am-10pm)
 */

import { unlink } from "fs/promises";
import { existsSync } from "fs";
import { loadEnv } from "./lib/env";
import { sendTelegramMessage, sendTelegramPhoto } from "./lib/telegram";
import { createClient } from "@supabase/supabase-js";

// Load environment
await loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_USER_ID || "";
const GENERAL_TOPIC_ID = 1;
const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
const NLM_NOTEBOOK_ID = process.env.TWINMIND_NLM_NOTEBOOK_ID || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

const THREAD_ID = process.env.TELEGRAM_GROUP_CHAT_ID ? GENERAL_TOPIC_ID : undefined;

// ============================================================
// SUPABASE CLIENT
// ============================================================

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ============================================================
// TYPES
// ============================================================

interface MeetingSummary {
  meeting_id: string;
  meeting_title: string;
  summary: string;
  action_items?: string;
  start_time: string;
  end_time?: string;
}

// ============================================================
// FETCH UNPROCESSED MEETINGS FROM SUPABASE
// ============================================================

async function fetchUnprocessedMeetings(): Promise<MeetingSummary[]> {
  const sb = getSupabase();
  if (!sb) {
    console.error("Supabase not configured (missing SUPABASE_URL or key)");
    return [];
  }

  const { data, error } = await sb
    .from("twinmind_meetings")
    .select("meeting_id, meeting_title, summary, action_items, start_time, end_time")
    .eq("processed", false)
    .order("start_time", { ascending: true });

  if (error) {
    console.error(`Supabase query failed: ${error.message}`);
    return [];
  }

  return (data || []) as MeetingSummary[];
}

async function markProcessed(meetingId: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const { error } = await sb
    .from("twinmind_meetings")
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq("meeting_id", meetingId);

  if (error) {
    console.error(`Failed to mark ${meetingId} as processed: ${error.message}`);
  }
}

// ============================================================
// NOTEBOOKLM — infographic creation via nlm CLI
// ============================================================

async function runNlm(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["nlm", ...args], {
    cwd: PROJECT_ROOT,
    timeout: 300_000, // 5 min
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function addSourceAndGetId(notebookId: string, title: string, text: string): Promise<string | null> {
  const result = await runNlm([
    "source", "add", notebookId,
    "--text", `# ${title}\n\n${text}`,
  ]);

  if (!result.ok) {
    console.error(`nlm source add failed: ${result.stderr}`);
    return null;
  }

  // Method 1: Parse source ID from "nlm source add" stdout
  // Output format: "✓ Added source: <title>\nSource ID: <uuid>"
  const idMatch = result.stdout.match(/Source ID:\s*([0-9a-f-]{36})/i);
  if (idMatch) {
    console.log(`  Source ID from add output: ${idMatch[1]}`);
    return idMatch[1];
  }

  // Method 2: Fall back to listing sources and parsing JSON
  const listResult = await runNlm(["source", "list", notebookId]);
  if (!listResult.ok) return null;

  try {
    const sources = JSON.parse(listResult.stdout) as Array<{ id: string; title: string }>;
    if (sources.length > 0) {
      // Return the last source (most recently added)
      const lastSource = sources[sources.length - 1];
      console.log(`  Source ID from list (last): ${lastSource.id}`);
      return lastSource.id;
    }
  } catch {
    console.error("  Failed to parse nlm source list JSON");
  }

  return null;
}

async function createInfographic(
  notebookId: string,
  sourceId: string,
  style: "standard" | "sketchnote",
  outputPath: string
): Promise<boolean> {
  console.log(`  Creating ${style} infographic...`);

  const args = [
    "infographic", "create", notebookId,
    "--source-ids", sourceId,
    "-y",
  ];

  if (style === "sketchnote") {
    args.push("--focus", "sketchnote style");
  }

  const createResult = await runNlm(args);
  if (!createResult.ok) {
    console.error(`  nlm infographic create (${style}) failed: ${createResult.stderr}`);
    return false;
  }

  // Extract artifact ID from create output (format: "Artifact ID: <uuid>")
  const artifactMatch = createResult.stdout.match(/Artifact ID:\s*([0-9a-f-]{36})/i);
  const artifactId = artifactMatch?.[1];
  if (artifactId) {
    console.log(`  Artifact ID: ${artifactId}`);
  }

  // Poll studio status until THIS artifact completes (max 5 min, poll every 15s)
  const maxPolls = 20;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 15_000));
    const status = await runNlm(["studio", "status", notebookId]);

    // Parse JSON and find our specific artifact
    let artifactStatus = "unknown";
    try {
      const artifacts = JSON.parse(status.stdout) as Array<{ id: string; status: string }>;
      if (artifactId) {
        const target = artifacts.find(a => a.id === artifactId);
        artifactStatus = target?.status || "not_found";
      } else {
        // No artifact ID — check the first (newest) artifact
        artifactStatus = artifacts[0]?.status || "unknown";
      }
    } catch {
      // If JSON parsing fails, use simple string matching on full output
      // but only for positive signals (complete/ready)
      if (status.stdout.toLowerCase().includes('"status": "completed"') ||
          status.stdout.toLowerCase().includes('"status":"completed"')) {
        artifactStatus = "completed";
      }
    }

    console.log(`  Poll ${i + 1}/${maxPolls}: artifact ${artifactId?.slice(0, 8) || "?"} → ${artifactStatus}`);

    if (artifactStatus === "completed") {
      break;
    }
    if (artifactStatus === "failed") {
      console.error(`  Infographic generation failed for artifact ${artifactId}`);
      return false;
    }
  }

  // Download
  const dlResult = await runNlm(["download", "infographic", notebookId, "-o", outputPath]);
  if (!dlResult.ok) {
    console.error(`  nlm download failed: ${dlResult.stderr}`);
    return false;
  }

  console.log(`  Downloaded ${style} infographic -> ${outputPath}`);
  return true;
}

// ============================================================
// PROCESS MEETING
// ============================================================

async function processMeeting(meeting: MeetingSummary): Promise<boolean> {
  console.log(`\nProcessing: ${meeting.meeting_title}`);
  const chatId = CHAT_ID;

  // 1. Send summary text
  let summaryText = `*New Meeting Summary*\n\n`;
  summaryText += `*${meeting.meeting_title}*\n`;
  if (meeting.start_time) {
    summaryText += `${meeting.start_time}`;
    if (meeting.end_time) summaryText += ` - ${meeting.end_time}`;
    summaryText += "\n";
  }
  summaryText += `\n${meeting.summary}`;
  if (meeting.action_items) {
    summaryText += `\n\n*Action Items:*\n${meeting.action_items}`;
  }

  const textSent = await sendTelegramMessage(BOT_TOKEN, chatId, summaryText, {
    parseMode: "Markdown",
    messageThreadId: THREAD_ID,
  });

  if (!textSent) {
    console.error("Failed to send summary text to Telegram");
    return false;
  }
  console.log("  Summary text sent");

  // 2. Create infographics (if NLM notebook configured)
  if (!NLM_NOTEBOOK_ID) {
    console.log("  TWINMIND_NLM_NOTEBOOK_ID not set — skipping infographics");
    return true;
  }

  const sourceId = await addSourceAndGetId(
    NLM_NOTEBOOK_ID,
    meeting.meeting_title,
    meeting.summary + (meeting.action_items ? `\n\nAction Items:\n${meeting.action_items}` : "")
  );

  if (!sourceId) {
    console.error("  Failed to add source to NotebookLM — skipping infographics");
    return true; // Still return true — summary was sent
  }

  console.log(`  Source added: ${sourceId}`);

  // 3. Standard infographic
  const stdPath = `/tmp/twinmind-${meeting.meeting_id}-standard.png`;
  const stdOk = await createInfographic(NLM_NOTEBOOK_ID, sourceId, "standard", stdPath);
  if (stdOk && existsSync(stdPath)) {
    await sendTelegramPhoto(BOT_TOKEN, chatId, stdPath, {
      caption: `Infographic: ${meeting.meeting_title}`,
      parseMode: "Markdown",
      messageThreadId: THREAD_ID,
    });
    await unlink(stdPath).catch(() => {});
    console.log("  Standard infographic sent");
  }

  // 4. Sketchnote infographic
  const sketchPath = `/tmp/twinmind-${meeting.meeting_id}-sketchnote.png`;
  const sketchOk = await createInfographic(NLM_NOTEBOOK_ID, sourceId, "sketchnote", sketchPath);
  if (sketchOk && existsSync(sketchPath)) {
    await sendTelegramPhoto(BOT_TOKEN, chatId, sketchPath, {
      caption: `Sketchnote: ${meeting.meeting_title}`,
      parseMode: "Markdown",
      messageThreadId: THREAD_ID,
    });
    await unlink(sketchPath).catch(() => {});
    console.log("  Sketchnote infographic sent");
  }

  return true;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const forceRun = process.argv.includes("--force");

  // Stagger startup (skip if forced)
  if (!forceRun) {
    const delay = Math.floor(Math.random() * 5000);
    console.log(`Staggering startup by ${Math.round(delay / 1000)}s...`);
    await new Promise(r => setTimeout(r, delay));
  }

  console.log("TwinMind Monitor starting...");
  console.log(`Chat: ${CHAT_ID}`);
  console.log(`NLM Notebook: ${NLM_NOTEBOOK_ID || "(not configured)"}`);
  console.log(`Supabase: ${SUPABASE_URL ? "configured" : "NOT configured"}`);

  const meetings = await fetchUnprocessedMeetings();
  console.log(`Found ${meetings.length} unprocessed meeting(s)`);

  if (meetings.length === 0) {
    console.log("No unprocessed meetings. Done.");
    return;
  }

  for (const meeting of meetings) {
    const ok = await processMeeting(meeting);
    if (ok) {
      await markProcessed(meeting.meeting_id);
      console.log(`  Marked ${meeting.meeting_id} as processed`);
    }
  }

  console.log(`\nTwinMind Monitor complete. Processed ${meetings.length} meeting(s).`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
