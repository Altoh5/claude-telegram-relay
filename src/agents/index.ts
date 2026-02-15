/**
 * Multi-Agent System
 *
 * Agent configuration exports and utilities.
 *
 * Architecture:
 * - Each Telegram forum topic maps to a specialized agent
 * - Agents have distinct system prompts, reasoning styles, and tool access
 * - General topic (no thread_id) uses the default Orchestrator agent
 *
 * Usage:
 * 1. Create a Telegram group with forum topics enabled
 * 2. Add your bot as admin
 * 3. Map topic IDs to agent names in topicAgentMap (src/agents/base.ts)
 * 4. Messages in each topic will use that agent's configuration
 */

export type { AgentConfig, InvocationContext } from "./base";
export {
  BASE_CONTEXT,
  getAgentConfig,
  getAgentByTopicId,
  topicAgentMap,
  AGENT_INVOCATION_MAP,
  canInvokeAgent,
  formatCrossAgentContext,
  canContinueInvocation,
  getUserProfile,
} from "./base";

// Agent configurations
export { default as researchAgent } from "./research";
export { default as contentAgent } from "./content";
export { default as financeAgent } from "./finance";
export { default as strategyAgent } from "./strategy";
export { default as generalAgent } from "./general";
export { default as criticAgent } from "./critic";
export { default as marketingAgent } from "./marketing";

// Quick reference
export const AGENTS = {
  research:
    "Research Agent - Market intel, competitor analysis (ReAct reasoning)",
  content:
    "Content Agent (CMO) - Video packaging, audience growth (RoT reasoning)",
  finance:
    "Finance Agent (CFO) - ROI analysis, unit economics (CoT reasoning)",
  strategy:
    "Strategy Agent (CEO) - Major decisions, long-term vision (ToT reasoning)",
  general: "General Agent - Default assistant, cross-agent orchestration",
  marketing:
    "Marketing Agent (Copywriter) - Direct response copy, landing pages, emails, headlines (RoT reasoning)",
  critic:
    "Critic Agent - Devil's advocate, stress-testing (internal, not topic-bound)",
};
