/**
 * StartInfinity Sync Service
 *
 * Two-way sync between Convex triageTasks and StartInfinity board.
 *
 * Push loop (every 2 min): new Convex tasks → StartInfinity Backlog
 * Pull loop (every 5 min): folder moves in SI → Convex status updates
 *
 * Run: bun run startinfinity-sync
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadEnv } from "./lib/env";
import { StartInfinityClient } from "./lib/startinfinity";
import type { Id } from "../convex/_generated/dataModel";

await loadEnv();

// ---- Config ----

const SI_API_KEY = process.env.STARTINFINITY_API_KEY ?? "";
const SI_WORKSPACE_ID = process.env.STARTINFINITY_WORKSPACE_ID ?? "";
const SI_BOARD_ID = process.env.STARTINFINITY_BOARD_ID ?? "";
const SI_FOLDER_BACKLOG = process.env.STARTINFINITY_FOLDER_BACKLOG_ID ?? "";
const SI_FOLDER_IN_PROGRESS = process.env.STARTINFINITY_FOLDER_IN_PROGRESS_ID ?? "";
const SI_FOLDER_DONE = process.env.STARTINFINITY_FOLDER_DONE_ID ?? "";
const CONVEX_URL = process.env.CONVEX_URL ?? "";

const PUSH_INTERVAL_MS = 2 * 60 * 1000;  // 2 min
const PULL_INTERVAL_MS = 5 * 60 * 1000;  // 5 min

// ---- Validation ----

const missing: string[] = [];
if (!SI_API_KEY) missing.push("STARTINFINITY_API_KEY");
if (!SI_WORKSPACE_ID) missing.push("STARTINFINITY_WORKSPACE_ID");
if (!SI_BOARD_ID) missing.push("STARTINFINITY_BOARD_ID");
if (!SI_FOLDER_BACKLOG) missing.push("STARTINFINITY_FOLDER_BACKLOG_ID");
if (!SI_FOLDER_IN_PROGRESS) missing.push("STARTINFINITY_FOLDER_IN_PROGRESS_ID");
if (!SI_FOLDER_DONE) missing.push("STARTINFINITY_FOLDER_DONE_ID");
if (!CONVEX_URL) missing.push("CONVEX_URL");

if (missing.length > 0) {
  console.error(`❌ Missing env vars: ${missing.join(", ")}`);
  console.error("Run: bun run setup:startinfinity");
  process.exit(1);
}

// ---- Clients ----

const si = new StartInfinityClient(SI_API_KEY);
const cx = new ConvexHttpClient(CONVEX_URL);

// Map folder ID → status string
const FOLDER_TO_STATUS: Record<string, string> = {
  [SI_FOLDER_BACKLOG]: "backlog",
  [SI_FOLDER_IN_PROGRESS]: "in_progress",
  [SI_FOLDER_DONE]: "done",
};

// ---- Attribute ID cache ----
// Loaded once on startup, used for all item creates

interface AttrMap {
  name?: string;
  confidence?: string;
  contact?: string;
  sourceMeeting?: string;
  project?: string;
  suggestion?: string;
}

async function loadAttributeIds(): Promise<AttrMap> {
  try {
    const attrs = await si.getAttributes(SI_WORKSPACE_ID, SI_BOARD_ID);
    const map: AttrMap = {};
    for (const a of attrs) {
      switch (a.name) {
        case "Name":           map.name = a.id; break;
        case "Confidence":     map.confidence = a.id; break;
        case "Contact":        map.contact = a.id; break;
        case "Source Meeting": map.sourceMeeting = a.id; break;
        case "Project":        map.project = a.id; break;
        case "AI Suggestion":  map.suggestion = a.id; break;
      }
    }
    return map;
  } catch (err) {
    console.error(`Failed to load attribute IDs: ${err}`);
    return {};
  }
}

// ---- Push loop: Convex → StartInfinity ----

async function pushUnsynced(attrMap: AttrMap): Promise<void> {
  let tasks: any[];
  try {
    tasks = await cx.query(api.triageTasks.listUnsynced, {});
  } catch (err) {
    console.error(`[push] Failed to fetch unsynced tasks: ${err}`);
    return;
  }

  if (tasks.length === 0) {
    console.log("[push] No unsynced tasks");
    return;
  }

  console.log(`[push] ${tasks.length} task(s) to push`);

  for (const task of tasks) {
    try {
      const values: Array<{ attribute_id: string; data: string | number }> = [];

      if (attrMap.name !== undefined) {
        values.push({ attribute_id: attrMap.name, data: task.description.slice(0, 200) });
      }
      if (attrMap.confidence !== undefined) {
        values.push({ attribute_id: attrMap.confidence, data: task.confidence_score });
      }
      if (attrMap.contact !== undefined && task.relevant_contact) {
        const contactStr = task.relevant_contact_email
          ? `${task.relevant_contact} <${task.relevant_contact_email}>`
          : task.relevant_contact;
        values.push({ attribute_id: attrMap.contact, data: contactStr });
      }
      if (attrMap.sourceMeeting !== undefined) {
        values.push({ attribute_id: attrMap.sourceMeeting, data: task.source_meeting_title });
      }
      if (attrMap.project !== undefined) {
        values.push({ attribute_id: attrMap.project, data: task.project });
      }
      if (attrMap.suggestion !== undefined) {
        values.push({ attribute_id: attrMap.suggestion, data: task.suggestion });
      }

      const item = await si.createItem(SI_WORKSPACE_ID, SI_BOARD_ID, {
        name: task.description.slice(0, 200),
        folder_id: SI_FOLDER_BACKLOG,
        values,
      });

      await cx.mutation(api.triageTasks.markSynced, {
        id: task._id as Id<"triageTasks">,
        startinfinity_item_id: item.id,
        startinfinity_folder_id: SI_FOLDER_BACKLOG,
      });

      console.log(`[push] ✅ "${task.description.slice(0, 60)}" → item ${item.id}`);
    } catch (err) {
      console.error(`[push] ❌ Failed to push task ${task._id}: ${err}`);
    }
  }
}

// ---- Pull loop: StartInfinity → Convex ----

async function pullStatusChanges(): Promise<void> {
  // Fetch all items from board with folder info
  let items: any[];
  try {
    items = await si.getItems(SI_WORKSPACE_ID, SI_BOARD_ID);
  } catch (err) {
    console.error(`[pull] Failed to fetch SI items: ${err}`);
    return;
  }

  // Fetch all Convex tasks that are synced
  let convexTasks: any[];
  try {
    convexTasks = await cx.query(api.triageTasks.listAll, {});
  } catch (err) {
    console.error(`[pull] Failed to fetch Convex tasks: ${err}`);
    return;
  }

  // Build map: SI item ID → Convex task
  const taskByItemId = new Map<string, any>();
  for (const t of convexTasks) {
    if (t.startinfinity_item_id) {
      taskByItemId.set(t.startinfinity_item_id, t);
    }
  }

  let updated = 0;
  for (const item of items) {
    const task = taskByItemId.get(item.id);
    if (!task) continue;

    const siStatus = FOLDER_TO_STATUS[item.folder_id];
    if (!siStatus) continue; // unknown folder

    if (siStatus !== task.status) {
      try {
        await cx.mutation(api.triageTasks.updateStatus, {
          id: task._id as Id<"triageTasks">,
          status: siStatus,
        });
        console.log(`[pull] ✅ "${item.name.slice(0, 50)}" → ${task.status} → ${siStatus}`);
        updated++;
      } catch (err) {
        console.error(`[pull] ❌ Failed to update task ${task._id}: ${err}`);
      }
    }
  }

  if (updated === 0) {
    console.log("[pull] No status changes");
  } else {
    console.log(`[pull] Updated ${updated} task(s)`);
  }
}

// ---- Main loop ----

console.log("StartInfinity Sync Service starting...");
console.log(`Workspace: ${SI_WORKSPACE_ID}`);
console.log(`Board: ${SI_BOARD_ID}`);
console.log(`Push every ${PUSH_INTERVAL_MS / 1000}s, pull every ${PULL_INTERVAL_MS / 1000}s\n`);

const attrMap = await loadAttributeIds();
console.log("Attribute map:", attrMap);

let lastPull = 0;

async function tick() {
  const now = Date.now();

  // Push always runs on interval
  await pushUnsynced(attrMap);

  // Pull runs on its own (longer) interval
  if (now - lastPull >= PULL_INTERVAL_MS) {
    await pullStatusChanges();
    lastPull = now;
  }
}

// Run immediately on start
await tick();

// Schedule recurring ticks
setInterval(tick, PUSH_INTERVAL_MS);

console.log("\nSync service running. Ctrl+C to stop.");
