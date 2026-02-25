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
import { sendTelegramMessage, sendTelegramPhoto, sendTelegramDocument } from "./lib/telegram";
import { runClaudeWithTimeout } from "./lib/claude";
import { createClient } from "@supabase/supabase-js";
import { syncFromTwinmindDirect } from "./lib/twinmind-direct-sync";

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
  metadata?: Record<string, unknown>;
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
    .select("meeting_id, meeting_title, summary, action_items, start_time, end_time, metadata")
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

async function updateMetadata(meetingId: string, updates: Record<string, unknown>): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  // Merge with existing metadata
  const { data } = await sb
    .from("twinmind_meetings")
    .select("metadata")
    .eq("meeting_id", meetingId)
    .single();

  const existing = (data?.metadata || {}) as Record<string, unknown>;
  const merged = { ...existing, ...updates };

  await sb
    .from("twinmind_meetings")
    .update({ metadata: merged })
    .eq("meeting_id", meetingId);
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

async function createSlideDeck(
  notebookId: string,
  sourceId: string,
  style: "standard" | "sketchnote",
  outputPath: string
): Promise<boolean> {
  console.log(`  Creating slide deck (fallback for ${style})...`);

  const args = [
    "slides", "create", notebookId,
    "--source-ids", sourceId,
    "-y",
  ];

  if (style === "sketchnote") {
    args.push("--focus", "sketchnote style visual summary");
  }

  const createResult = await runNlm(args);
  if (!createResult.ok) {
    console.error(`  nlm slides create failed: ${createResult.stderr}`);
    return false;
  }

  // Extract artifact ID
  const artifactMatch = createResult.stdout.match(/Artifact ID:\s*([0-9a-f-]{36})/i);
  const artifactId = artifactMatch?.[1];
  if (artifactId) {
    console.log(`  Slide Artifact ID: ${artifactId}`);
  }

  // Poll until complete (max 5 min)
  const maxPolls = 20;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 15_000));
    const status = await runNlm(["studio", "status", notebookId]);

    let artifactStatus = "unknown";
    try {
      const artifacts = JSON.parse(status.stdout) as Array<{ id: string; status: string }>;
      if (artifactId) {
        const target = artifacts.find(a => a.id === artifactId);
        artifactStatus = target?.status || "not_found";
      } else {
        artifactStatus = artifacts[0]?.status || "unknown";
      }
    } catch {
      if (status.stdout.toLowerCase().includes('"status":"completed"') ||
          status.stdout.toLowerCase().includes('"status": "completed"')) {
        artifactStatus = "completed";
      }
    }

    console.log(`  Poll ${i + 1}/${maxPolls}: slide ${artifactId?.slice(0, 8) || "?"} → ${artifactStatus}`);

    if (artifactStatus === "completed") break;
    if (artifactStatus === "failed") {
      console.error(`  Slide deck generation failed for artifact ${artifactId}`);
      return false;
    }
  }

  // Download as PDF
  const dlResult = await runNlm(["download", "slide-deck", notebookId, "-o", outputPath]);
  if (!dlResult.ok) {
    console.error(`  nlm download slide-deck failed: ${dlResult.stderr}`);
    return false;
  }

  console.log(`  Downloaded slide deck -> ${outputPath}`);
  return true;
}

// ============================================================
// CONTEXT ANALYSIS — enrich summaries with memory + intent
// ============================================================

async function fetchRelatedMemory(meetingTitle: string, meetingSummary: string): Promise<string[]> {
  const sb = getSupabase();
  if (!sb) return [];

  // Extract keywords from meeting title (2+ chars, skip common words)
  const stopWords = new Set(["the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out", "with", "from", "that", "this", "about", "their", "have", "will", "been", "were", "they", "what", "when", "where", "which", "there", "would", "could", "should", "being", "after", "before", "between", "through", "during", "into", "over", "under", "then", "than", "also", "more", "some", "very", "just", "only", "each", "other", "such", "like", "meeting", "session", "discussion", "new", "demo", "at"]);
  const keywords = meetingTitle
    .split(/[\s,\-:&()]+/)
    .filter(w => w.length >= 2)
    .map(w => w.toLowerCase())
    .filter(w => !stopWords.has(w));

  if (keywords.length === 0) return [];

  // Search memory for related facts/goals using PostgREST ILIKE
  const conditions = keywords.map(k => `content.ilike.%${k}%`).join(",");
  const { data: memories, error } = await sb
    .from("memory")
    .select("type, content, created_at")
    .or(conditions)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error(`  Memory search error: ${error.message}`);
    return [];
  }

  return (memories || []).map(m => `[${m.type}] ${m.content}`);
}

async function fetchRelatedMessages(meetingTitle: string): Promise<string[]> {
  const sb = getSupabase();
  if (!sb) return [];

  // Extract top keywords (2+ chars, skip common words)
  const stopWords = new Set(["the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out", "with", "from", "that", "this", "about", "their", "have", "will", "been", "were", "meeting", "session", "training", "discussion", "new", "demo", "at"]);
  const keywords = meetingTitle
    .split(/[\s,\-:&()]+/)
    .filter(w => w.length >= 2)
    .map(w => w.toLowerCase())
    .filter(w => !stopWords.has(w))
    .slice(0, 5); // Top 5 keywords

  if (keywords.length === 0) return [];

  // Search recent messages (last 30 days) for related conversations
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const conditions = keywords.map(k => `content.ilike.%${k}%`).join(",");

  const { data: msgs } = await sb
    .from("messages")
    .select("role, content, created_at")
    .or(conditions)
    .gte("created_at", thirtyDaysAgo)
    .order("created_at", { ascending: false })
    .limit(15);

  return (msgs || []).map(m => `[${m.role} ${new Date(m.created_at).toLocaleDateString()}] ${(m.content || "").slice(0, 200)}`);
}

async function generateMeetingAnalysis(
  meeting: MeetingSummary,
  relatedMemory: string[],
  relatedMessages: string[]
): Promise<string | null> {
  if (relatedMemory.length === 0 && relatedMessages.length === 0) {
    return null; // No context to analyze against
  }

  const contextBlock = [
    relatedMemory.length > 0 ? `RELATED MEMORY/GOALS:\n${relatedMemory.join("\n")}` : "",
    relatedMessages.length > 0 ? `RECENT RELATED CONVERSATIONS:\n${relatedMessages.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = `You are analyzing a meeting summary against the user's prior context (goals, facts, conversations).

MEETING: ${meeting.meeting_title}
DATE: ${meeting.start_time || "Unknown"}

SUMMARY:
${meeting.summary}

${meeting.action_items ? `ACTION ITEMS:\n${meeting.action_items}` : ""}

PRIOR CONTEXT:
${contextBlock}

Provide a brief analysis (3-5 bullet points max) covering:
1. How this meeting connects to known goals/priorities
2. Any notable progress or gaps relative to intent
3. Key follow-ups that align with existing commitments

Keep it concise and actionable. Use plain text, no markdown headers. Start with a one-line verdict like "✅ Strong alignment with X goal" or "⚠️ Gap identified: Y".`;

  try {
    const analysis = await runClaudeWithTimeout(prompt, 60_000, {
      cwd: PROJECT_ROOT,
    });
    const trimmed = analysis.trim();
    return trimmed || null;
  } catch (err) {
    console.error(`  Claude analysis failed: ${err}`);
    return null;
  }
}

// ============================================================
// PROCESS MEETING
// ============================================================

async function processMeeting(meeting: MeetingSummary): Promise<"complete" | "partial" | "failed"> {
  console.log(`\nProcessing: ${meeting.meeting_title}`);
  const chatId = CHAT_ID;
  const meta = (meeting.metadata || {}) as Record<string, unknown>;

  // 1. Send summary text (skip if already sent on a previous attempt)
  if (meta.summary_sent) {
    console.log("  Summary already sent (previous run) — skipping");
  } else {
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
      return "failed";
    }
    console.log("  Summary text sent");
    await updateMetadata(meeting.meeting_id, { summary_sent: true });
  }

  // 1b. Context analysis — search memory for related intent, send as follow-up
  if (meta.analysis_sent) {
    console.log("  Context analysis already sent — skipping");
  } else {
    console.log("  Searching memory for related context...");
    const [relatedMemory, relatedMessages] = await Promise.all([
      fetchRelatedMemory(meeting.meeting_title, meeting.summary),
      fetchRelatedMessages(meeting.meeting_title),
    ]);
    console.log(`  Found ${relatedMemory.length} memory entries, ${relatedMessages.length} related messages`);

    if (relatedMemory.length > 0 || relatedMessages.length > 0) {
      console.log("  Generating meeting analysis via Claude...");
      const analysis = await generateMeetingAnalysis(meeting, relatedMemory, relatedMessages);
      if (analysis) {
        const analysisText = `*Context Analysis*\n_${meeting.meeting_title}_\n\n${analysis}`;
        await sendTelegramMessage(BOT_TOKEN, chatId, analysisText, {
          parseMode: "Markdown",
          messageThreadId: THREAD_ID,
        });
        console.log("  Context analysis sent");
        await updateMetadata(meeting.meeting_id, { analysis_sent: true });
      } else {
        console.log("  No analysis generated — skipping");
        await updateMetadata(meeting.meeting_id, { analysis_sent: true }); // Don't retry
      }
    } else {
      console.log("  No related context found — skipping analysis");
      await updateMetadata(meeting.meeting_id, { analysis_sent: true });
    }
  }

  // 2. Create infographics (if NLM notebook configured)
  if (!NLM_NOTEBOOK_ID) {
    console.log("  TWINMIND_NLM_NOTEBOOK_ID not set — skipping infographics");
    return "complete";
  }

  // Reuse source ID from previous attempt if available
  let sourceId = meta.nlm_source_id as string | null;
  if (sourceId) {
    console.log(`  Reusing NLM source: ${sourceId} (from previous run)`);
  } else {
    sourceId = await addSourceAndGetId(
      NLM_NOTEBOOK_ID,
      meeting.meeting_title,
      meeting.summary + (meeting.action_items ? `\n\nAction Items:\n${meeting.action_items}` : "")
    );

    if (!sourceId) {
      console.error("  Failed to add source to NotebookLM — skipping infographics");
      return "complete"; // Summary sent, infographics optional
    }

    console.log(`  Source added: ${sourceId}`);
    await updateMetadata(meeting.meeting_id, { nlm_source_id: sourceId });
  }

  // 3. Standard visual (infographic → slide deck fallback)
  let stdOk = !!meta.standard_sent;
  if (stdOk) {
    console.log("  Standard visual already sent — skipping");
  } else {
    const stdImgPath = `/tmp/twinmind-${meeting.meeting_id}-standard.png`;
    const stdOkInfographic = await createInfographic(NLM_NOTEBOOK_ID, sourceId, "standard", stdImgPath);
    if (stdOkInfographic && existsSync(stdImgPath)) {
      await sendTelegramPhoto(BOT_TOKEN, chatId, stdImgPath, {
        caption: `Infographic: ${meeting.meeting_title}`,
        parseMode: "Markdown",
        messageThreadId: THREAD_ID,
      });
      await unlink(stdImgPath).catch(() => {});
      console.log("  Standard infographic sent");
      stdOk = true;
      await updateMetadata(meeting.meeting_id, { standard_sent: true, standard_type: "infographic" });
    } else {
      // Fallback: create slide deck instead
      console.log("  Infographic rate-limited — falling back to slide deck");
      const stdSlidePath = `/tmp/twinmind-${meeting.meeting_id}-standard.pdf`;
      const stdOkSlides = await createSlideDeck(NLM_NOTEBOOK_ID, sourceId, "standard", stdSlidePath);
      if (stdOkSlides && existsSync(stdSlidePath)) {
        await sendTelegramDocument(BOT_TOKEN, chatId, stdSlidePath, {
          caption: `Slides: ${meeting.meeting_title}`,
          parseMode: "Markdown",
          messageThreadId: THREAD_ID,
          filename: `${meeting.meeting_title.slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "")}.pdf`,
        });
        await unlink(stdSlidePath).catch(() => {});
        console.log("  Standard slide deck sent (fallback)");
        stdOk = true;
        await updateMetadata(meeting.meeting_id, { standard_sent: true, standard_type: "slides" });
      }
    }
  }

  // 4. Sketchnote visual (infographic → slide deck fallback)
  let sketchOk = !!meta.sketchnote_sent;
  if (sketchOk) {
    console.log("  Sketchnote visual already sent — skipping");
  } else {
    const sketchImgPath = `/tmp/twinmind-${meeting.meeting_id}-sketchnote.png`;
    const sketchOkInfographic = await createInfographic(NLM_NOTEBOOK_ID, sourceId, "sketchnote", sketchImgPath);
    if (sketchOkInfographic && existsSync(sketchImgPath)) {
      await sendTelegramPhoto(BOT_TOKEN, chatId, sketchImgPath, {
        caption: `Sketchnote: ${meeting.meeting_title}`,
        parseMode: "Markdown",
        messageThreadId: THREAD_ID,
      });
      await unlink(sketchImgPath).catch(() => {});
      console.log("  Sketchnote infographic sent");
      sketchOk = true;
      await updateMetadata(meeting.meeting_id, { sketchnote_sent: true, sketchnote_type: "infographic" });
    } else {
      // Fallback: create slide deck with sketchnote focus
      console.log("  Sketchnote rate-limited — falling back to slide deck");
      const sketchSlidePath = `/tmp/twinmind-${meeting.meeting_id}-sketchnote.pdf`;
      const sketchOkSlides = await createSlideDeck(NLM_NOTEBOOK_ID, sourceId, "sketchnote", sketchSlidePath);
      if (sketchOkSlides && existsSync(sketchSlidePath)) {
        await sendTelegramDocument(BOT_TOKEN, chatId, sketchSlidePath, {
          caption: `Sketchnote Slides: ${meeting.meeting_title}`,
          parseMode: "Markdown",
          messageThreadId: THREAD_ID,
          filename: `${meeting.meeting_title.slice(0, 50).replace(/[^a-zA-Z0-9 ]/g, "")} Sketchnote.pdf`,
        });
        await unlink(sketchSlidePath).catch(() => {});
        console.log("  Sketchnote slide deck sent (fallback)");
        sketchOk = true;
        await updateMetadata(meeting.meeting_id, { sketchnote_sent: true, sketchnote_type: "slides" });
      }
    }
  }

  // Mark complete if both visuals succeeded (either infographic or slide fallback)
  if (stdOk && sketchOk) {
    return "complete";
  }
  console.log("  Visual(s) failed — will retry next run");
  return "partial";
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

  // Sync latest meetings from TwinMind API directly (no Claude Code needed)
  console.log("Step 1/3: Syncing from TwinMind API...");
  const synced = await syncFromTwinmindDirect(getSupabase()!);
  if (synced > 0) {
    console.log(`  ↳ Synced ${synced} new meeting(s) from TwinMind`);
  } else {
    console.log("  ↳ No new meetings synced (token issue or already up to date)");
  }

  console.log("Step 2/3: Fetching unprocessed meetings from Supabase...");
  const meetings = await fetchUnprocessedMeetings();
  console.log(`Found ${meetings.length} unprocessed meeting(s)`);

  if (meetings.length === 0) {
    console.log("No unprocessed meetings. Done.");
    return;
  }

  let completed = 0;
  let partial = 0;
  let failed = 0;

  for (const meeting of meetings) {
    const result = await processMeeting(meeting);
    switch (result) {
      case "complete":
        await markProcessed(meeting.meeting_id);
        console.log(`  ✅ Marked ${meeting.meeting_id} as processed`);
        completed++;
        break;
      case "partial":
        console.log(`  ⏳ ${meeting.meeting_id} partially done — will retry infographics next run`);
        partial++;
        break;
      case "failed":
        console.log(`  ❌ ${meeting.meeting_id} failed — will retry next run`);
        failed++;
        break;
    }
  }

  console.log(`\nTwinMind Monitor complete.`);
  console.log(`  ${completed} fully processed, ${partial} partial (will retry), ${failed} failed`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
