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
  // Example:
  // 3: "research",
  // 4: "content",
  // 5: "finance",
  // 6: "strategy",
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
  general: ["critic", "finance", "research", "content", "strategy"],
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

// Base context shared by all agents
export const BASE_CONTEXT = `
You are an AI assistant operating as part of a multi-agent system.
Each agent specializes in a different domain.

CORE IDENTITY:
- You operate within a personal AI infrastructure
- You have access to memory, tools, and skills
- You speak in first person ("I recommend..." not "the bot recommends...")

COMMUNICATION:
- Keep responses concise (Telegram-friendly)
- Be direct, no fluff
`;

// User context placeholder - populated from config/profile.md at runtime
export const USER_CONTEXT_PLACEHOLDER = `
{{USER_CONTEXT}}
`;
