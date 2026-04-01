/**
 * One-off script to run triage on recent meetings that were skipped.
 * Usage: bun run src/run-triage-backfill.ts
 */
import { loadEnv } from "./lib/env";
import { triageMeeting, sendTriageSummary } from "./triage-agent";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

await loadEnv();

const CONVEX_URL = process.env.CONVEX_URL ?? "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_USER_ID || "";

if (!CONVEX_URL) {
  console.error("CONVEX_URL not set");
  process.exit(1);
}

const cx = new ConvexHttpClient(CONVEX_URL);

// Fetch recent meetings
const meetings = await cx.query(api.twinmindMeetings.getRecent, { limit: 8 });
console.log(`Found ${meetings.length} recent meetings\n`);

let totalTasks = 0;
for (const meeting of meetings) {
  const title = (meeting as any).meeting_title;
  const mid = (meeting as any).meeting_id;

  // Check if already triaged
  try {
    const existing = await cx.query(api.triageTasks.listByMeeting, { meeting_id: mid });
    if ((existing as any[]).length > 0) {
      console.log(`SKIP: ${title} (already has ${(existing as any[]).length} tasks)`);
      continue;
    }
  } catch {}

  console.log(`TRIAGE: ${title}`);
  try {
    const count = await triageMeeting(meeting as any, {
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
    });
    console.log(`  → ${count} tasks created\n`);
    totalTasks += count;

    if (count > 0) {
      await sendTriageSummary(BOT_TOKEN, CHAT_ID, title, count);
    }
  } catch (err) {
    console.error(`  ERROR: ${err}\n`);
  }
}

console.log(`\nDone. Total new tasks: ${totalTasks}`);
