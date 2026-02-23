/**
 * TwinMind Meeting Monitor
 *
 * Checks TwinMind every 30 minutes for new meeting summaries.
 * Creates standard + sketchnote infographics via NotebookLM.
 * Sends summary text + both infographics to Telegram.
 *
 * Run manually: bun run src/twinmind-monitor.ts [--force]
 * Scheduled: launchd every 30 min (8am-10pm)
 */

import { readFile, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { loadEnv } from "./lib/env";
import { sendTelegramMessage, sendTelegramPhoto } from "./lib/telegram";

// Load environment
await loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_USER_ID || "";
const GENERAL_TOPIC_ID = 1;
const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
const USER_TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const NLM_NOTEBOOK_ID = process.env.TWINMIND_NLM_NOTEBOOK_ID || "";

const STATE_FILE = join(PROJECT_ROOT, "logs", "twinmind-monitor-state.json");
const THREAD_ID = process.env.TELEGRAM_GROUP_CHAT_ID ? GENERAL_TOPIC_ID : undefined;

// ============================================================
// STATE
// ============================================================

interface MonitorState {
  lastCheckedTime: string; // ISO string
  processedMeetingIds: string[]; // dedup by meeting_id
}

async function loadState(): Promise<MonitorState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8"));
  } catch {
    // Default: check last 35 minutes
    return {
      lastCheckedTime: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      processedMeetingIds: [],
    };
  }
}

async function saveState(state: MonitorState): Promise<void> {
  // Keep only last 200 processed IDs to avoid unbounded growth
  state.processedMeetingIds = state.processedMeetingIds.slice(-200);
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ============================================================
// TWINMIND — fetch via claude subprocess
// ============================================================

interface MeetingSummary {
  meeting_id: string;
  meeting_title: string;
  summary: string;
  action_items?: string;
  start_time: string;
  end_time?: string;
}

async function fetchNewMeetings(since: string): Promise<MeetingSummary[]> {
  const sinceLocal = new Date(since).toLocaleString("sv-SE", { timeZone: USER_TIMEZONE }).replace(" ", "T");

  const prompt = `Use the TwinMind summary_search tool with start_time="${sinceLocal}" to find recent meetings. Return ONLY a raw JSON array (no markdown, no code fences) of objects with these exact keys: meeting_id, meeting_title, summary, action_items, start_time, end_time. If no meetings found, return exactly: []`;

  console.log(`🔍 Querying TwinMind for meetings since ${sinceLocal}...`);

  const proc = Bun.spawn(["claude", "-p", prompt, "--output-format", "json"], {
    cwd: PROJECT_ROOT,
    timeout: 120_000, // 2 min max
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`❌ Claude subprocess failed (exit ${exitCode}): ${stderr}`);
    return [];
  }

  try {
    // Parse claude --output-format json response
    const response = JSON.parse(stdout);
    const text = typeof response === "string" ? response : response.result || response.text || JSON.stringify(response);

    // Extract JSON array from response (may be wrapped in text)
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      console.log("📭 No meetings array found in response");
      return [];
    }

    const meetings: MeetingSummary[] = JSON.parse(arrayMatch[0]);
    return meetings;
  } catch (err) {
    console.error(`❌ Failed to parse TwinMind response: ${err}`);
    console.error(`   Raw stdout: ${stdout.slice(0, 500)}`);
    return [];
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
  // Add meeting summary as text source
  const result = await runNlm([
    "source", "add", notebookId,
    "--text", `# ${title}\n\n${text}`,
  ]);

  if (!result.ok) {
    console.error(`❌ nlm source add failed: ${result.stderr}`);
    return null;
  }

  // Get the source ID — list sources and find the newest one
  const listResult = await runNlm(["source", "list", notebookId]);
  if (!listResult.ok) return null;

  // Parse source list output to find latest source ID
  // nlm source list outputs lines like: "abc123  Title  2024-01-15"
  const lines = listResult.stdout.split("\n").filter(l => l.trim());
  // The most recently added source should contain our title
  for (const line of lines.reverse()) {
    if (line.includes(title.slice(0, 30))) {
      const sourceId = line.trim().split(/\s+/)[0];
      if (sourceId) return sourceId;
    }
  }

  // Fallback: return the first ID from the last line
  const lastLine = lines[0]?.trim();
  const fallbackId = lastLine?.split(/\s+/)[0];
  return fallbackId || null;
}

async function createInfographic(
  notebookId: string,
  sourceId: string,
  style: "standard" | "sketchnote",
  outputPath: string
): Promise<boolean> {
  console.log(`  🎨 Creating ${style} infographic...`);

  const args = [
    "infographic", "create", notebookId,
    "--source-ids", sourceId,
    "-y", // skip confirmation
  ];

  if (style === "sketchnote") {
    args.push("--focus", "sketchnote style");
  }

  const createResult = await runNlm(args);
  if (!createResult.ok) {
    console.error(`  ❌ nlm infographic create (${style}) failed: ${createResult.stderr}`);
    return false;
  }

  // Poll studio status until complete (max 5 min, poll every 15s)
  const maxPolls = 20;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 15_000));
    const status = await runNlm(["studio", "status", notebookId]);
    console.log(`  ⏳ Poll ${i + 1}/${maxPolls}: ${status.stdout.slice(0, 100)}`);

    if (status.stdout.toLowerCase().includes("complete") || status.stdout.toLowerCase().includes("ready")) {
      break;
    }
    if (status.stdout.toLowerCase().includes("fail") || status.stdout.toLowerCase().includes("error")) {
      console.error(`  ❌ Infographic generation failed: ${status.stdout}`);
      return false;
    }
  }

  // Download
  const dlResult = await runNlm(["download", "infographic", notebookId, "-o", outputPath]);
  if (!dlResult.ok) {
    console.error(`  ❌ nlm download failed: ${dlResult.stderr}`);
    return false;
  }

  console.log(`  ✅ Downloaded ${style} infographic → ${outputPath}`);
  return true;
}

// ============================================================
// PROCESS MEETING
// ============================================================

async function processMeeting(meeting: MeetingSummary): Promise<boolean> {
  console.log(`\n📋 Processing: ${meeting.meeting_title}`);
  const chatId = CHAT_ID;

  // 1. Send summary text
  let summaryText = `📋 *New Meeting Summary*\n\n`;
  summaryText += `*${meeting.meeting_title}*\n`;
  if (meeting.start_time) {
    summaryText += `🕐 ${meeting.start_time}`;
    if (meeting.end_time) summaryText += ` — ${meeting.end_time}`;
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
    console.error("❌ Failed to send summary text to Telegram");
    return false;
  }
  console.log("  ✅ Summary text sent");

  // 2. Create infographics (if NLM notebook configured)
  if (!NLM_NOTEBOOK_ID) {
    console.log("  ⚠️ TWINMIND_NLM_NOTEBOOK_ID not set — skipping infographics");
    return true;
  }

  const sourceId = await addSourceAndGetId(
    NLM_NOTEBOOK_ID,
    meeting.meeting_title,
    meeting.summary + (meeting.action_items ? `\n\nAction Items:\n${meeting.action_items}` : "")
  );

  if (!sourceId) {
    console.error("  ❌ Failed to add source to NotebookLM — skipping infographics");
    return true; // Still return true — summary was sent
  }

  console.log(`  📎 Source added: ${sourceId}`);

  // 3. Standard infographic
  const stdPath = `/tmp/twinmind-${meeting.meeting_id}-standard.png`;
  const stdOk = await createInfographic(NLM_NOTEBOOK_ID, sourceId, "standard", stdPath);
  if (stdOk && existsSync(stdPath)) {
    await sendTelegramPhoto(BOT_TOKEN, chatId, stdPath, {
      caption: `📊 Infographic: ${meeting.meeting_title}`,
      parseMode: "Markdown",
      messageThreadId: THREAD_ID,
    });
    await unlink(stdPath).catch(() => {});
    console.log("  ✅ Standard infographic sent");
  }

  // 4. Sketchnote infographic
  const sketchPath = `/tmp/twinmind-${meeting.meeting_id}-sketchnote.png`;
  const sketchOk = await createInfographic(NLM_NOTEBOOK_ID, sourceId, "sketchnote", sketchPath);
  if (sketchOk && existsSync(sketchPath)) {
    await sendTelegramPhoto(BOT_TOKEN, chatId, sketchPath, {
      caption: `✏️ Sketchnote: ${meeting.meeting_title}`,
      parseMode: "Markdown",
      messageThreadId: THREAD_ID,
    });
    await unlink(sketchPath).catch(() => {});
    console.log("  ✅ Sketchnote infographic sent");
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
    console.log(`⏳ Staggering startup by ${Math.round(delay / 1000)}s...`);
    await new Promise(r => setTimeout(r, delay));
  }

  console.log("🔎 TwinMind Monitor starting...");
  console.log(`📱 Chat: ${CHAT_ID}`);
  console.log(`📓 NLM Notebook: ${NLM_NOTEBOOK_ID || "(not configured)"}`);

  const state = await loadState();
  console.log(`⏰ Checking for meetings since: ${state.lastCheckedTime}`);

  const meetings = await fetchNewMeetings(state.lastCheckedTime);
  console.log(`📬 Found ${meetings.length} meeting(s)`);

  if (meetings.length === 0) {
    console.log("✅ No new meetings. Done.");
    // Still update timestamp so we don't re-query the same window
    state.lastCheckedTime = new Date().toISOString();
    await saveState(state);
    return;
  }

  // Filter out already-processed meetings
  const newMeetings = meetings.filter(
    m => !state.processedMeetingIds.includes(m.meeting_id)
  );
  console.log(`🆕 ${newMeetings.length} unprocessed meeting(s)`);

  let allOk = true;
  for (const meeting of newMeetings) {
    const ok = await processMeeting(meeting);
    if (ok) {
      state.processedMeetingIds.push(meeting.meeting_id);
    } else {
      allOk = false;
    }
  }

  // Update timestamp only if all succeeded
  if (allOk) {
    state.lastCheckedTime = new Date().toISOString();
  }
  await saveState(state);

  console.log(`\n✅ TwinMind Monitor complete. Processed ${newMeetings.length} meeting(s).`);
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
