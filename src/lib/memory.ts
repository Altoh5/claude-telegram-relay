/**
 * Memory Module
 *
 * Thin wrapper that delegates to convex-client.ts (Convex as primary store)
 * with a local JSON file as fallback. Provides facts, goals, and intent
 * parsing from Claude responses.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import {
  addFact as convexAddFact,
  addGoal as convexAddGoal,
  completeGoal as convexCompleteGoal,
  cancelGoal as convexCancelGoal,
  deleteFact as convexDeleteFact,
  getFacts,
  getActiveGoals,
  getMemoryContext as convexGetMemoryContext,
  getConvex,
  formatGoalsList,
  formatFactsList,
} from "./convex-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Goal {
  text: string;
  deadline?: string;
  createdAt: string;
}

interface CompletedGoal {
  text: string;
  completedAt: string;
}

interface Memory {
  facts: string[];
  goals: Goal[];
  completedGoals: CompletedGoal[];
}

// ---------------------------------------------------------------------------
// Local File Fallback
// ---------------------------------------------------------------------------

const MEMORY_PATH =
  process.env.MEMORY_FILE_PATH ||
  join(process.env.GO_PROJECT_ROOT || process.cwd(), "memory.json");

const DEFAULT_MEMORY: Memory = {
  facts: [],
  goals: [],
  completedGoals: [],
};

async function readLocalMemory(): Promise<Memory> {
  try {
    const raw = await readFile(MEMORY_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      completedGoals: Array.isArray(parsed.completedGoals)
        ? parsed.completedGoals
        : [],
    };
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

async function writeLocalMemory(memory: Memory): Promise<void> {
  try {
    await mkdir(dirname(MEMORY_PATH), { recursive: true });
    await writeFile(MEMORY_PATH, JSON.stringify(memory, null, 2), "utf-8");
  } catch {
    // Silent failure for file write issues
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a fact. Uses Convex if available, otherwise local file.
 */
export async function addFact(content: string): Promise<boolean> {
  if (getConvex()) {
    return convexAddFact(content);
  }

  const memory = await readLocalMemory();
  if (memory.facts.includes(content)) return true;
  memory.facts.push(content);
  await writeLocalMemory(memory);
  return true;
}

/**
 * Add a goal with an optional deadline. Uses Convex if available, otherwise local file.
 */
export async function addGoal(
  text: string,
  deadline?: string
): Promise<boolean> {
  if (getConvex()) {
    return convexAddGoal(text, deadline);
  }

  const memory = await readLocalMemory();
  memory.goals.push({
    text,
    deadline,
    createdAt: new Date().toISOString(),
  });
  await writeLocalMemory(memory);
  return true;
}

/**
 * Mark a goal as completed by partial text match.
 */
export async function completeGoal(searchText: string): Promise<boolean> {
  if (getConvex()) {
    return convexCompleteGoal(searchText);
  }

  const memory = await readLocalMemory();
  const lower = searchText.toLowerCase();
  const index = memory.goals.findIndex((g) =>
    g.text.toLowerCase().includes(lower)
  );

  if (index === -1) return false;

  const [removed] = memory.goals.splice(index, 1);
  memory.completedGoals.push({
    text: removed.text,
    completedAt: new Date().toISOString(),
  });
  await writeLocalMemory(memory);
  return true;
}

/**
 * Delete a fact by partial text match.
 */
export async function deleteFact(searchText: string): Promise<boolean> {
  if (getConvex()) {
    return convexDeleteFact(searchText);
  }

  const memory = await readLocalMemory();
  const lower = searchText.toLowerCase();
  const index = memory.facts.findIndex((f) =>
    f.toLowerCase().includes(lower)
  );

  if (index === -1) return false;

  memory.facts.splice(index, 1);
  await writeLocalMemory(memory);
  return true;
}

/**
 * Cancel (delete) a goal by partial text match.
 */
export async function cancelGoal(searchText: string): Promise<boolean> {
  if (getConvex()) {
    return convexCancelGoal(searchText);
  }

  const memory = await readLocalMemory();
  const lower = searchText.toLowerCase();
  const index = memory.goals.findIndex((g) =>
    g.text.toLowerCase().includes(lower)
  );

  if (index === -1) return false;

  memory.goals.splice(index, 1);
  await writeLocalMemory(memory);
  return true;
}

/**
 * List all active goals. Returns formatted string.
 */
export async function listGoals(): Promise<string> {
  if (getConvex()) {
    const goals = await getActiveGoals();
    if (goals.length === 0) return "No active goals.";
    return formatGoalsList(goals);
  }

  const memory = await readLocalMemory();
  if (memory.goals.length === 0) return "No active goals.";

  return memory.goals
    .map((g, i) => {
      const deadline = g.deadline
        ? ` (due: ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      return `${i + 1}. ${g.text}${deadline}`;
    })
    .join("\n");
}

/**
 * List all stored facts. Returns formatted string.
 */
export async function listFacts(): Promise<string> {
  if (getConvex()) {
    const facts = await getFacts();
    if (facts.length === 0) return "No stored facts.";
    return formatFactsList(facts);
  }

  const memory = await readLocalMemory();
  if (memory.facts.length === 0) return "No stored facts.";
  return memory.facts.map((f) => `- ${f}`).join("\n");
}

/**
 * Build combined memory context (facts + goals) for prompt injection.
 */
export async function getMemoryContext(): Promise<string> {
  if (getConvex()) {
    return convexGetMemoryContext();
  }

  const memory = await readLocalMemory();
  const sections: string[] = [];

  if (memory.facts.length > 0) {
    sections.push(
      `**Known Facts:**\n${memory.facts.map((f) => `- ${f}`).join("\n")}`
    );
  }

  if (memory.goals.length > 0) {
    const goalLines = memory.goals
      .map((g, i) => {
        const deadline = g.deadline
          ? ` (due: ${new Date(g.deadline).toLocaleDateString()})`
          : "";
        return `${i + 1}. ${g.text}${deadline}`;
      })
      .join("\n");
    sections.push(`**Active Goals:**\n${goalLines}`);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Intent Processing
// ---------------------------------------------------------------------------

interface ProcessedIntents {
  goalsAdded: string[];
  goalsCompleted: string[];
  goalsCancelled: string[];
  factsAdded: string[];
  factsRemoved: string[];
}

/**
 * Parse and process structured intent tags from Claude responses.
 *
 * Recognized tags:
 *   [GOAL: description | DEADLINE: deadline]   - Add a new goal
 *   [GOAL: description]                        - Add a goal without deadline
 *   [DONE: partial match text]                 - Complete an existing goal
 *   [CANCEL: partial match text]               - Cancel/delete a goal
 *   [REMEMBER: fact text]                      - Store a fact
 *   [FORGET: partial match text]               - Delete a stored fact
 *
 * Returns a summary of what was processed.
 */
export async function processIntents(
  text: string,
  _chatId?: string
): Promise<ProcessedIntents> {
  const result: ProcessedIntents = {
    goalsAdded: [],
    goalsCompleted: [],
    goalsCancelled: [],
    factsAdded: [],
    factsRemoved: [],
  };

  // [GOAL: description | DEADLINE: deadline]
  const goalWithDeadline =
    /\[GOAL:\s*([^|\]]+?)\s*\|\s*DEADLINE:\s*([^\]]+?)\s*\]/gi;
  let match: RegExpExecArray | null;

  while ((match = goalWithDeadline.exec(text)) !== null) {
    const goalText = match[1].trim();
    const deadline = match[2].trim();
    const success = await addGoal(goalText, deadline);
    if (success) result.goalsAdded.push(goalText);
  }

  // [GOAL: description] (without deadline, avoid re-matching the above)
  const goalSimple = /\[GOAL:\s*([^\]|]+?)\s*\]/gi;
  while ((match = goalSimple.exec(text)) !== null) {
    const goalText = match[1].trim();
    if (result.goalsAdded.includes(goalText)) continue;
    const success = await addGoal(goalText);
    if (success) result.goalsAdded.push(goalText);
  }

  // [DONE: text] — require minimum 5 chars to prevent vague matches
  const donePattern = /\[DONE:\s*([^\]]+?)\s*\]/gi;
  while ((match = donePattern.exec(text)) !== null) {
    const doneText = match[1].trim();
    if (doneText.length < 5) {
      console.warn(`[INTENT] Skipping vague DONE tag: "${doneText}"`);
      continue;
    }
    console.log(`[INTENT] Processing DONE: "${doneText}"`);
    const success = await completeGoal(doneText);
    if (success) result.goalsCompleted.push(doneText);
  }

  // [REMEMBER: text]
  const rememberPattern = /\[REMEMBER:\s*([^\]]+?)\s*\]/gi;
  while ((match = rememberPattern.exec(text)) !== null) {
    const factText = match[1].trim();
    const success = await addFact(factText);
    if (success) result.factsAdded.push(factText);
  }

  // [FORGET: text]
  const forgetPattern = /\[FORGET:\s*([^\]]+?)\s*\]/gi;
  while ((match = forgetPattern.exec(text)) !== null) {
    const forgetText = match[1].trim();
    const success = await deleteFact(forgetText);
    if (success) result.factsRemoved.push(forgetText);
  }

  // [CANCEL: text] — require minimum 5 chars to prevent vague matches
  const cancelPattern = /\[CANCEL:\s*([^\]]+?)\s*\]/gi;
  while ((match = cancelPattern.exec(text)) !== null) {
    const cancelText = match[1].trim();
    if (cancelText.length < 5) {
      console.warn(`[INTENT] Skipping vague CANCEL tag: "${cancelText}"`);
      continue;
    }
    console.log(`[INTENT] Processing CANCEL: "${cancelText}"`);
    const success = await cancelGoal(cancelText);
    if (success) result.goalsCancelled.push(cancelText);
  }

  return result;
}
