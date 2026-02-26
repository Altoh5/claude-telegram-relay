/**
 * Extracted helpers from relay.ts for testability.
 */
import type { Context } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

/**
 * Extract a session ID from Claude CLI output if present.
 */
export function extractSessionId(output: string): string | null {
  const match = output.match(/Session ID: ([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

/**
 * Save a message to Supabase. No-op if supabase is null.
 */
export async function saveMessage(
  supabase: SupabaseClient | null,
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

/**
 * Check if a user is authorized. Denies by default if allowedUserId is not set.
 */
export function isAuthorizedUser(
  userId: string | undefined,
  allowedUserId: string
): boolean {
  if (!allowedUserId) return false;
  return userId === allowedUserId;
}

export function buildPrompt(
  userMessage: string,
  options: {
    userName?: string;
    timeStr: string;
    profileContext?: string;
    memoryContext?: string;
    relevantContext?: string;
  }
): string {
  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational. You have web access — use WebSearch and WebFetch tools to look up current information when needed.",
  ];

  if (options.userName) parts.push(`You are speaking with ${options.userName}.`);
  parts.push(`Current time: ${options.timeStr}`);
  if (options.profileContext) parts.push(`\nProfile:\n${options.profileContext}`);
  if (options.memoryContext) parts.push(`\n${options.memoryContext}`);
  if (options.relevantContext) parts.push(`\n${options.relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

export async function sendResponse(ctx: Context, response: string): Promise<void> {
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  const chunks: string[] = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}
