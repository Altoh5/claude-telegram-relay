/**
 * TwinMind → Supabase Sync Utility
 *
 * Accepts meeting JSON via stdin and upserts to the twinmind_meetings
 * Supabase table. Designed to be called from interactive Claude Code
 * sessions where TwinMind MCP is available.
 *
 * Usage:
 *   echo '[{"meeting_id":"abc","meeting_title":"Test",...}]' | bun run src/twinmind-sync.ts
 *   bun run src/twinmind-sync.ts < meetings.json
 */

import { loadEnv } from "./lib/env";
import { createClient } from "@supabase/supabase-js";

await loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_ANON_KEY (or SERVICE_ROLE_KEY) required");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

interface MeetingInput {
  meeting_id: string;
  meeting_title: string;
  summary: string;
  action_items?: string;
  start_time: string;
  end_time?: string;
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }

  return chunks.join("");
}

async function syncMeetings(meetings: MeetingInput[]): Promise<{ inserted: number; updated: number; errors: number }> {
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (const m of meetings) {
    if (!m.meeting_id || !m.meeting_title || !m.summary || !m.start_time) {
      console.error(`Skipping invalid meeting (missing required fields): ${JSON.stringify(m).slice(0, 100)}`);
      errors++;
      continue;
    }

    // Check if already exists
    const { data: existing } = await supabase
      .from("twinmind_meetings")
      .select("id, meeting_id")
      .eq("meeting_id", m.meeting_id)
      .maybeSingle();

    if (existing) {
      // Update existing
      const { error } = await supabase
        .from("twinmind_meetings")
        .update({
          meeting_title: m.meeting_title,
          summary: m.summary,
          action_items: m.action_items || null,
          start_time: m.start_time,
          end_time: m.end_time || null,
          synced_at: new Date().toISOString(),
        })
        .eq("meeting_id", m.meeting_id);

      if (error) {
        console.error(`Error updating ${m.meeting_id}: ${error.message}`);
        errors++;
      } else {
        updated++;
        console.log(`  Updated: ${m.meeting_title}`);
      }
    } else {
      // Insert new
      const { error } = await supabase
        .from("twinmind_meetings")
        .insert({
          meeting_id: m.meeting_id,
          meeting_title: m.meeting_title,
          summary: m.summary,
          action_items: m.action_items || null,
          start_time: m.start_time,
          end_time: m.end_time || null,
        });

      if (error) {
        console.error(`Error inserting ${m.meeting_id}: ${error.message}`);
        errors++;
      } else {
        inserted++;
        console.log(`  Inserted: ${m.meeting_title}`);
      }
    }
  }

  return { inserted, updated, errors };
}

// Main
async function main() {
  console.log("TwinMind Sync: reading meetings from stdin...");

  const raw = await readStdin();
  if (!raw.trim()) {
    console.error("No input received on stdin. Pipe meeting JSON array.");
    process.exit(1);
  }

  let meetings: MeetingInput[];
  try {
    // Handle potential markdown fencing
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    meetings = JSON.parse(cleaned);
    if (!Array.isArray(meetings)) {
      meetings = [meetings]; // Single meeting object → wrap in array
    }
  } catch (err) {
    console.error(`Failed to parse JSON: ${err}`);
    console.error(`Raw input (first 500 chars): ${raw.slice(0, 500)}`);
    process.exit(1);
  }

  console.log(`Found ${meetings.length} meeting(s) to sync.`);

  const result = await syncMeetings(meetings);

  console.log(`\nSync complete: ${result.inserted} inserted, ${result.updated} updated, ${result.errors} errors`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
