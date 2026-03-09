/**
 * Database Backend Router
 *
 * Routes all DB calls based on the DB_BACKEND env var:
 *   - "supabase" (default): all calls go to supabase.ts
 *   - "convex": all calls go to convex-client.ts
 *   - "dual": writes go to both (Promise.allSettled), reads come from Convex
 *
 * Consumers import from this file instead of supabase.ts directly.
 * The interface is identical to supabase.ts — drop-in replacement.
 */

import * as supabaseModule from "./supabase";

// Re-export types (always from supabase — canonical definitions)
export type { Message, MemoryItem, LogEntry, AsyncTask } from "./supabase";

// ---------------------------------------------------------------------------
// Backend Selection
// ---------------------------------------------------------------------------

type Backend = "supabase" | "convex" | "dual";

const DB_BACKEND: Backend = (() => {
  const val = (process.env.DB_BACKEND || "supabase").toLowerCase();
  if (val === "convex" || val === "dual") return val;
  return "supabase";
})();

// Lazy-load convex module only when needed (prevents crash if convex isn't installed)
let convexModule: typeof supabaseModule | null = null;

function getConvexModule(): typeof supabaseModule {
  if (!convexModule) {
    try {
      convexModule = require("./convex-client") as typeof supabaseModule;
    } catch (err) {
      throw new Error(
        `DB_BACKEND is "${DB_BACKEND}" but convex-client failed to load: ${err}`
      );
    }
  }
  return convexModule;
}

/**
 * Get the active module for read operations.
 * - supabase mode: supabaseModule
 * - convex / dual mode: convexModule
 */
function readModule(): typeof supabaseModule {
  if (DB_BACKEND === "supabase") return supabaseModule;
  return getConvexModule();
}

/**
 * Dual-write helper: fire the operation on both backends.
 * Uses Promise.allSettled so one failing doesn't block the other.
 * Returns the result from the Convex call (primary in dual mode).
 */
async function dualWrite<T>(
  fn: (mod: typeof supabaseModule) => Promise<T>
): Promise<T> {
  const convex = getConvexModule();
  const [convexResult, _supabaseResult] = await Promise.allSettled([
    fn(convex),
    fn(supabaseModule),
  ]);

  // Return convex result (primary); throw if it failed
  if (convexResult.status === "fulfilled") return convexResult.value;
  throw convexResult.reason;
}

// ---------------------------------------------------------------------------
// Pure Utility Functions (no DB, always from supabase.ts)
// ---------------------------------------------------------------------------

export const getTimeAgo = supabaseModule.getTimeAgo;
export const parseRelativeDate = supabaseModule.parseRelativeDate;
export const formatGoalsList = supabaseModule.formatGoalsList;
export const formatFactsList = supabaseModule.formatFactsList;
export const isSupabaseEnabled = supabaseModule.isSupabaseEnabled;

// ---------------------------------------------------------------------------
// Supabase-only exports (needed by asset-store.ts etc.)
// ---------------------------------------------------------------------------

export const getSupabase = supabaseModule.getSupabase;
export const testConnection = supabaseModule.testConnection;

// ---------------------------------------------------------------------------
// Write Functions (dual-write in "dual" mode)
// ---------------------------------------------------------------------------

export async function saveMessage(
  ...args: Parameters<typeof supabaseModule.saveMessage>
): ReturnType<typeof supabaseModule.saveMessage> {
  if (DB_BACKEND === "supabase") return supabaseModule.saveMessage(...args);
  if (DB_BACKEND === "convex") return getConvexModule().saveMessage(...args);
  return dualWrite((mod) => mod.saveMessage(...args));
}

export async function addFact(
  ...args: Parameters<typeof supabaseModule.addFact>
): ReturnType<typeof supabaseModule.addFact> {
  if (DB_BACKEND === "supabase") return supabaseModule.addFact(...args);
  if (DB_BACKEND === "convex") return getConvexModule().addFact(...args);
  return dualWrite((mod) => mod.addFact(...args));
}

export async function addGoal(
  ...args: Parameters<typeof supabaseModule.addGoal>
): ReturnType<typeof supabaseModule.addGoal> {
  if (DB_BACKEND === "supabase") return supabaseModule.addGoal(...args);
  if (DB_BACKEND === "convex") return getConvexModule().addGoal(...args);
  return dualWrite((mod) => mod.addGoal(...args));
}

export async function completeGoal(
  ...args: Parameters<typeof supabaseModule.completeGoal>
): ReturnType<typeof supabaseModule.completeGoal> {
  if (DB_BACKEND === "supabase") return supabaseModule.completeGoal(...args);
  if (DB_BACKEND === "convex") return getConvexModule().completeGoal(...args);
  return dualWrite((mod) => mod.completeGoal(...args));
}

export async function deleteFact(
  ...args: Parameters<typeof supabaseModule.deleteFact>
): ReturnType<typeof supabaseModule.deleteFact> {
  if (DB_BACKEND === "supabase") return supabaseModule.deleteFact(...args);
  if (DB_BACKEND === "convex") return getConvexModule().deleteFact(...args);
  return dualWrite((mod) => mod.deleteFact(...args));
}

export async function cancelGoal(
  ...args: Parameters<typeof supabaseModule.cancelGoal>
): ReturnType<typeof supabaseModule.cancelGoal> {
  if (DB_BACKEND === "supabase") return supabaseModule.cancelGoal(...args);
  if (DB_BACKEND === "convex") return getConvexModule().cancelGoal(...args);
  return dualWrite((mod) => mod.cancelGoal(...args));
}

export async function log(
  ...args: Parameters<typeof supabaseModule.log>
): ReturnType<typeof supabaseModule.log> {
  if (DB_BACKEND === "supabase") return supabaseModule.log(...args);
  if (DB_BACKEND === "convex") return getConvexModule().log(...args);
  // Dual: fire-and-forget to both, don't block on result
  const convex = getConvexModule();
  Promise.allSettled([convex.log(...args), supabaseModule.log(...args)]);
}

export async function createTask(
  ...args: Parameters<typeof supabaseModule.createTask>
): ReturnType<typeof supabaseModule.createTask> {
  if (DB_BACKEND === "supabase") return supabaseModule.createTask(...args);
  if (DB_BACKEND === "convex") return getConvexModule().createTask(...args);
  return dualWrite((mod) => mod.createTask(...args));
}

export async function updateTask(
  ...args: Parameters<typeof supabaseModule.updateTask>
): ReturnType<typeof supabaseModule.updateTask> {
  if (DB_BACKEND === "supabase") return supabaseModule.updateTask(...args);
  if (DB_BACKEND === "convex") return getConvexModule().updateTask(...args);
  return dualWrite((mod) => mod.updateTask(...args));
}

export async function upsertHeartbeat(
  ...args: Parameters<typeof supabaseModule.upsertHeartbeat>
): ReturnType<typeof supabaseModule.upsertHeartbeat> {
  if (DB_BACKEND === "supabase") return supabaseModule.upsertHeartbeat(...args);
  if (DB_BACKEND === "convex") return getConvexModule().upsertHeartbeat(...args);
  return dualWrite((mod) => mod.upsertHeartbeat(...args));
}

// ---------------------------------------------------------------------------
// Read Functions (read from active backend — Convex in dual mode)
// ---------------------------------------------------------------------------

export async function getRecentMessages(
  ...args: Parameters<typeof supabaseModule.getRecentMessages>
): ReturnType<typeof supabaseModule.getRecentMessages> {
  return readModule().getRecentMessages(...args);
}

export async function getConversationContext(
  ...args: Parameters<typeof supabaseModule.getConversationContext>
): ReturnType<typeof supabaseModule.getConversationContext> {
  return readModule().getConversationContext(...args);
}

export async function searchMessages(
  ...args: Parameters<typeof supabaseModule.searchMessages>
): ReturnType<typeof supabaseModule.searchMessages> {
  return readModule().searchMessages(...args);
}

export async function getFacts(
  ...args: Parameters<typeof supabaseModule.getFacts>
): ReturnType<typeof supabaseModule.getFacts> {
  return readModule().getFacts(...args);
}

export async function getActiveGoals(
  ...args: Parameters<typeof supabaseModule.getActiveGoals>
): ReturnType<typeof supabaseModule.getActiveGoals> {
  return readModule().getActiveGoals(...args);
}

export async function getMemoryContext(
  ...args: Parameters<typeof supabaseModule.getMemoryContext>
): ReturnType<typeof supabaseModule.getMemoryContext> {
  return readModule().getMemoryContext(...args);
}

export async function getTaskById(
  ...args: Parameters<typeof supabaseModule.getTaskById>
): ReturnType<typeof supabaseModule.getTaskById> {
  return readModule().getTaskById(...args);
}

export async function getPendingTasks(
  ...args: Parameters<typeof supabaseModule.getPendingTasks>
): ReturnType<typeof supabaseModule.getPendingTasks> {
  return readModule().getPendingTasks(...args);
}

export async function getRunningTasks(
  ...args: Parameters<typeof supabaseModule.getRunningTasks>
): ReturnType<typeof supabaseModule.getRunningTasks> {
  return readModule().getRunningTasks(...args);
}

export async function getStaleTasks(
  ...args: Parameters<typeof supabaseModule.getStaleTasks>
): ReturnType<typeof supabaseModule.getStaleTasks> {
  return readModule().getStaleTasks(...args);
}

export async function getNodeStatus(
  ...args: Parameters<typeof supabaseModule.getNodeStatus>
): ReturnType<typeof supabaseModule.getNodeStatus> {
  return readModule().getNodeStatus(...args);
}
