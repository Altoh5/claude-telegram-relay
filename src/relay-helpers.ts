/**
 * Extracted helpers from relay.ts for testability.
 */
import type { Context } from "grammy";

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
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
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
