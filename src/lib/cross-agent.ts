/**
 * Cross-Agent Invocation — Visible Agent-to-Agent Communication
 *
 * Parses [INVOKE:agent|question] tags from Claude responses,
 * executes them as visible messages from the target agent's bot.
 */

import type { BotRegistry } from "./bot-registry";
import { canInvokeAgent, formatCrossAgentContext } from "../agents/base";

export interface Invocation {
  targetAgent: string;
  question: string;
}

/** Extract all [INVOKE:agent|question] tags from text. */
export function parseInvocationTags(text: string): Invocation[] {
  const pattern = /\[INVOKE:(\w+)\|([^\]]+)\]/g;
  const invocations: Invocation[] = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    invocations.push({
      targetAgent: match[1].toLowerCase(),
      question: match[2].trim(),
    });
  }

  return invocations;
}

/** Return text with all [INVOKE:...] tags removed. */
export function stripInvocationTags(text: string): string {
  return text.replace(/\[INVOKE:\w+\|[^\]]+\]/g, "").trim();
}

/**
 * Execute a visible cross-agent invocation.
 *
 * 1. Validates permission via canInvokeAgent()
 * 2. Sends typing indicator from target agent's bot
 * 3. Calls Claude with target agent's config + cross-agent context
 * 4. Posts response via target agent's bot in the same thread
 * 5. Returns response text for source agent to reference
 */
export async function executeVisibleInvocation(
  registry: BotRegistry,
  sourceAgent: string,
  invocation: Invocation,
  chatId: string | number,
  threadId: number | undefined,
  callClaudeFn: (
    userMessage: string,
    chatId: string,
    agentName: string,
    topicId?: number
  ) => Promise<string>
): Promise<string | null> {
  const { targetAgent, question } = invocation;

  // Check permissions
  if (!canInvokeAgent(sourceAgent, targetAgent)) {
    console.log(
      `[CrossAgent] ${sourceAgent} cannot invoke ${targetAgent} — skipping`
    );
    return null;
  }

  console.log(
    `[CrossAgent] ${sourceAgent} → ${targetAgent}: "${question.substring(0, 60)}..."`
  );

  // Show typing from target agent's bot
  await registry.sendTypingAsAgent(targetAgent, chatId, threadId);

  // Build the cross-agent prompt
  const crossPrompt = formatCrossAgentContext(
    sourceAgent,
    targetAgent,
    question,
    question
  );

  // Call Claude as the target agent
  const response = await callClaudeFn(
    crossPrompt,
    String(chatId),
    targetAgent,
    threadId
  );

  // Strip any nested invocation tags (prevent infinite chains)
  const cleanResponse = stripInvocationTags(response);

  // Post response from target agent's bot
  await registry.sendAsAgent(targetAgent, chatId, cleanResponse, { threadId });

  return cleanResponse;
}
