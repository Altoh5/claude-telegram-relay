/**
 * Board Meeting v2 — Parallel Multi-Agent Strategy Sessions
 *
 * Runs 5 specialized agents in parallel against a named project,
 * then synthesizes with the general orchestrator and surfaces
 * decisions as Telegram inline button options.
 */

import type { Context } from "grammy";
import type { Project } from "./projects";
import { updateBoardSession } from "./projects";

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export const BOARD_AGENTS = [
  {
    name: "finance",
    label: "Finance",
    emoji: "💰",
    question: "Financial dynamics, pricing, ROI, deal risks?",
  },
  {
    name: "strategy",
    label: "Strategy",
    emoji: "📈",
    question: "Strategic position, key leverage, recommended path?",
  },
  {
    name: "research",
    label: "Research",
    emoji: "🔍",
    question: "Market, client, and competitive context?",
  },
  {
    name: "content",
    label: "Content",
    emoji: "📣",
    question: "Positioning, framing, and communication?",
  },
  {
    name: "coo",
    label: "Operations",
    emoji: "⚙️",
    question: "Execution risks, blockers, next concrete steps?",
  },
] as const;

export type BoardAgentName = (typeof BOARD_AGENTS)[number]["name"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BoardMeetingOptions {
  chatId: string;
  sessionId: string;
  project: Project;
  projectContext: string;
  focus?: string; // Optional additional focus from user
  ctx: Context;
}

export interface AgentResult {
  name: string;
  label: string;
  emoji: string;
  output: string;
  error?: string;
}

export interface BoardMeetingResult {
  sessionId: string;
  agentResults: AgentResult[];
  synthesis: string;
  decisions: Array<{ label: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Decision parsing
// ---------------------------------------------------------------------------

/**
 * Parse "DECISION_N: label" lines from synthesis text.
 * Returns up to 4 decisions, labels capped at 64 chars.
 */
export function parseDecisionsFromSynthesis(
  synthesis: string
): Array<{ label: string; value: string }> {
  const decisions: Array<{ label: string; value: string }> = [];

  const lines = synthesis.split("\n");
  for (const line of lines) {
    const match = line.match(/^DECISION_\d+:\s*(.+)$/i);
    if (match) {
      const label = match[1].trim().slice(0, 64);
      decisions.push({ label, value: label });
      if (decisions.length >= 4) break;
    }
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

type BuildPromptFn = (
  agentName: string,
  agentQuestion: string,
  projectContext: string,
  focus?: string
) => string;

type CallSubprocessFn = (
  prompt: string,
  agentName: string
) => Promise<string>;

/**
 * Build default per-agent prompt.
 * Consumers can override by passing a custom buildPromptFn.
 */
function defaultBuildPrompt(
  agentName: string,
  agentQuestion: string,
  projectContext: string,
  focus?: string
): string {
  return `You are the ${agentName} advisor in a board meeting.

${projectContext}

## BOARD MEETING FOCUS
${focus ? focus + "\n\n" : ""}Question for you: ${agentQuestion}

Be concise and direct. 2-4 sentences max. Focus on your domain expertise.
No preamble. Start with the most important insight.`;
}

/**
 * Run a full board meeting: parallel agent fan-out → synthesis → decisions.
 */
export async function runBoardMeeting(
  options: BoardMeetingOptions,
  buildPromptFn: BuildPromptFn = defaultBuildPrompt,
  callSubprocessFn: CallSubprocessFn
): Promise<BoardMeetingResult> {
  const { chatId, sessionId, project, projectContext, focus, ctx } = options;

  // Announce
  await ctx.reply(
    `🎯 *Board Meeting: ${project.name}*\n_Running ${BOARD_AGENTS.length} agents in parallel..._`,
    { parse_mode: "Markdown" }
  ).catch(() => {});

  // --- Fan-out: run all agents in parallel ---
  const agentResultPromises = BOARD_AGENTS.map(async (agent) => {
    const prompt = buildPromptFn(agent.label, agent.question, projectContext, focus);
    try {
      const output = await callSubprocessFn(prompt, agent.name);
      return {
        name: agent.name,
        label: agent.label,
        emoji: agent.emoji,
        output: output || `No output from ${agent.label} agent.`,
      } satisfies AgentResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Board agent ${agent.name} failed:`, errMsg);
      return {
        name: agent.name,
        label: agent.label,
        emoji: agent.emoji,
        output: `_(${agent.label} agent unavailable)_`,
        error: errMsg,
      } satisfies AgentResult;
    }
  });

  const agentResults = await Promise.all(agentResultPromises);

  // Save agent outputs to session
  const agentOutputsMap: Record<string, string> = {};
  for (const r of agentResults) {
    agentOutputsMap[r.name] = r.output;
  }
  await updateBoardSession(sessionId, { agent_outputs: agentOutputsMap });

  // Send each agent result with rate-limit buffer
  for (const result of agentResults) {
    const msg = `${result.emoji} *${result.label}*\n\n${result.output}`;
    await ctx
      .reply(msg, { parse_mode: "Markdown" })
      .catch(() => ctx.reply(`${result.emoji} ${result.label}\n\n${result.output}`));

    // 500ms buffer between sends (Telegram rate limit)
    await new Promise((r) => setTimeout(r, 500));
  }

  // --- Synthesis prompt ---
  const agentAnalysesText = agentResults
    .map((r) => `### ${r.emoji} ${r.label}\n${r.output}`)
    .join("\n\n");

  const synthesisPrompt = `## AGENT ANALYSES

${agentAnalysesText}

## BOARD MEETING SYNTHESIS TASK

Project: ${project.name}
${focus ? `Focus: ${focus}\n` : ""}
Synthesize the above agent analyses. Be decisive. Under 300 words.

Format:
1. One sentence per agent summarizing their key point.
2. Single highest-leverage action.
3. Single biggest blocking risk.
4. Output decisions EXACTLY as:
   DECISION_1: [action label max 30 chars]
   DECISION_2: [action label max 30 chars]
   DECISION_3: [action label max 30 chars]`;

  // Call synthesizer
  await ctx.reply(`_Synthesizing board insights..._`, { parse_mode: "Markdown" }).catch(() => {});
  const synthesis = await callSubprocessFn(synthesisPrompt, "general");

  // Parse decisions
  const decisions = parseDecisionsFromSynthesis(synthesis);

  // Save synthesis + decisions to session
  await updateBoardSession(sessionId, {
    synthesis,
    decisions,
    status: "completed",
  });

  return {
    sessionId,
    agentResults,
    synthesis,
    decisions,
  };
}
