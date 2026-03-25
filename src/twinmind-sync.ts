/**
 * TwinMind → Convex Sync Utility
 *
 * Accepts meeting JSON via stdin and upserts to Convex twinmindMeetings table.
 * Designed to be called from interactive Claude Code sessions where TwinMind MCP is available.
 *
 * Usage:
 *   echo '[{"meeting_id":"abc","meeting_title":"Test",...}]' | bun run src/twinmind-sync.ts
 *   bun run src/twinmind-sync.ts < meetings.json
 */

import { loadEnv } from "./lib/env";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

await loadEnv();

const CONVEX_URL = process.env.CONVEX_URL || "";
if (!CONVEX_URL) {
  console.error("FATAL: CONVEX_URL required");
  process.exit(1);
}

const convex = new ConvexHttpClient(CONVEX_URL);

interface MeetingInput {
  meeting_id: string;
  meeting_title: string;
  summary: string;
  action_items?: string;
  start_time: string;
  end_time?: string;
}

function toUnixMs(ts: string | number): number {
  if (typeof ts === "number") return ts;
  const parsed = Date.parse(ts);
  return isNaN(parsed) ? Date.now() : parsed;
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

async function syncMeetings(meetings: MeetingInput[]): Promise<{ upserted: number; errors: number }> {
  let upserted = 0;
  let errors = 0;

  for (const m of meetings) {
    if (!m.meeting_id || !m.meeting_title || !m.summary || !m.start_time) {
      console.error(`Skipping invalid meeting (missing required fields): ${JSON.stringify(m).slice(0, 100)}`);
      errors++;
      continue;
    }

    try {
      await convex.mutation(api.twinmindMeetings.upsert, {
        meeting_id: m.meeting_id,
        meeting_title: m.meeting_title,
        summary: m.summary,
        action_items: m.action_items || undefined,
        start_time: toUnixMs(m.start_time),
        end_time: m.end_time ? toUnixMs(m.end_time) : undefined,
      });
      upserted++;
      console.log(`  Upserted: ${m.meeting_title}`);
    } catch (err: any) {
      console.error(`Error upserting ${m.meeting_id}: ${err.message}`);
      errors++;
    }
  }

  return { upserted, errors };
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

  console.log(`\nSync complete: ${result.upserted} upserted, ${result.errors} errors`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
