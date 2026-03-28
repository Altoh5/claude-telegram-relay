/**
 * Go - Multi-Agent Base Configuration
 *
 * Base interface and utilities for agent configurations.
 * Each agent has specialized instructions, tools, and reasoning style.
 */

import { readFile } from "fs/promises";
import { join } from "path";

export interface AgentConfig {
  name: string;
  topicId?: number;
  systemPrompt: string;
  allowedTools?: string[]; // Optional: restrict tools per agent. If omitted, Claude gets full access to all tools, MCP servers, and skills.
  model: string;
  reasoning?: string;
  personality?: string;
}

// Default topic-to-agent mapping. Update these with your Telegram forum topic IDs.
// Find topic IDs by sending a message in each topic and checking the bot logs.
export const topicAgentMap: Record<number, string> = {
  1: "general",
  3: "research",
  4: "content",
  5: "finance",
  6: "strategy",
  34: "critic",
  580: "cto",
  579: "coo",
};

export function getAgentByTopicId(topicId: number): string | undefined {
  return topicAgentMap[topicId];
}

export function getAgentConfig(agentName: string): AgentConfig | undefined {
  switch (agentName.toLowerCase()) {
    case "research":
    case "researcher":
      return require("./research").default;
    case "content":
    case "cmo":
      return require("./content").default;
    case "finance":
    case "cfo":
      return require("./finance").default;
    case "strategy":
    case "ceo":
      return require("./strategy").default;
    case "critic":
    case "devils-advocate":
      return require("./critic").default;
    case "ceo":
      return require("./ceo").default;
    case "cto":
      return require("./cto").default;
    case "coo":
      return require("./coo").default;
    case "general":
    case "orchestrator":
    default:
      return require("./general").default;
  }
}

// Cross-agent invocation permissions
export const AGENT_INVOCATION_MAP: Record<string, string[]> = {
  research: ["critic"],
  content: ["critic", "research"],
  finance: ["critic"],
  strategy: ["critic", "finance", "research"],
  general: ["critic", "finance", "research", "content", "strategy", "cto", "coo"],
  ceo: ["critic", "finance", "research", "content", "strategy", "cto", "coo"],
  cto: ["critic", "research"],
  coo: ["critic", "finance", "research", "strategy"],
  critic: [], // Critic doesn't invoke others (prevents loops)
};

export function canInvokeAgent(
  sourceAgent: string,
  targetAgent: string
): boolean {
  const allowed = AGENT_INVOCATION_MAP[sourceAgent.toLowerCase()] || [];
  return allowed.includes(targetAgent.toLowerCase());
}

export function formatCrossAgentContext(
  sourceAgent: string,
  targetAgent: string,
  context: string,
  question: string
): string {
  return `
## CROSS-AGENT CONSULTATION

You are being consulted by the **${sourceAgent}** agent.

**CONTEXT FROM ${sourceAgent.toUpperCase()}:**
${context}

**QUESTION/REQUEST:**
${question}

---

Provide your analysis from your specialized perspective. Be concise since your response will be incorporated into the ${sourceAgent}'s reply.
`;
}

export interface InvocationContext {
  chain: string[];
  maxDepth: number;
}

export function canContinueInvocation(
  ctx: InvocationContext,
  targetAgent: string
): boolean {
  if (ctx.chain.includes(targetAgent)) return false;
  if (ctx.chain.length >= ctx.maxDepth) return false;
  return true;
}

/**
 * Load user profile from config/profile.md for agent context.
 * Returns empty string if no profile exists.
 */
async function loadUserProfile(): Promise<string> {
  try {
    const profilePath = join(process.cwd(), "config", "profile.md");
    return await readFile(profilePath, "utf-8");
  } catch {
    return "";
  }
}

// Cached profile (loaded once)
let _userProfile: string | null = null;

export async function getUserProfile(): Promise<string> {
  if (_userProfile === null) {
    _userProfile = await loadUserProfile();
  }
  return _userProfile;
}

// Built-in Claude Code tools only — excludes MCP servers for faster startup and lower context usage.
// CLI wrappers (called via Bash) replace Google Workspace, NotebookLM, etc.
// To re-enable specific MCP tools, add them to a specific agent's allowedTools list.
export const DEFAULT_ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "WebSearch", "WebFetch", "Agent", "Task",
  "TodoRead", "TodoWrite", "Skill",
];

// Base context shared by all agents
export const BASE_CONTEXT = `
You are an AI assistant operating as part of a multi-agent system.
Each agent specializes in a different domain.

CORE IDENTITY:
- You operate as part of an AI Second Brain system
- You have access to memory, tools, and skills
- You speak in first person ("I recommend..." not "the bot recommends...")

COMMUNICATION:
- Keep responses concise (Telegram-friendly)
- Be direct, no fluff

CONTEXT RULES:
- The RECENT CONVERSATION section contains actual prior messages from all agents
- If another agent's response appears there, you can read and reference it directly
- Never claim information is unavailable if it appears in RECENT CONVERSATION

## QUICK TOOLS (via Bash — no MCP needed)

Calendar:  bun src/cli/gcal.ts    list [date] | create "title" "start" "end" | get <id>
Gmail:     bun src/cli/gmail.ts   unread | search "query" | get <id> | send "to" "subj" "body"
Docs:      bun src/cli/gdocs.ts   find "query" | read <id> | create "title" | append <id> "text" | replace <id> "old" "new"
Sheets:    bun src/cli/gsheets.ts find "query" | read <id> | range <id> "A1:B10"
Drive:     bun src/cli/gdrive.ts  search "query" | download <id> <path>
NLM:       nlm query notebook <id> "question" | nlm list notebooks

All return JSON. Dates use ISO 8601. Use these instead of MCP tools.
`;

// User context placeholder - populated from config/profile.md at runtime
export const USER_CONTEXT_PLACEHOLDER = `
{{USER_CONTEXT}}
`;
