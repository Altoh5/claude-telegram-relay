# Module 4: Multi-Agent System

> This module explains how the bot uses multiple specialized AI agents,
> each with distinct reasoning frameworks, routed via Telegram forum topics.

---

## Architecture: Topic-Based Routing

The multi-agent system maps Telegram forum topics to specialized agents.
When you send a message in a topic, the bot looks up which agent handles
that topic and uses its configuration:

```
Telegram Forum Topic  -->  Agent Lookup  -->  Specialized Prompt + Tools
```

In `src/bot.ts` (line 413):

```typescript
const agentName = topicId ? getAgentByTopicId(topicId) || "general" : "general";
```

If no topic is detected (DM or non-forum group), the General agent handles it.

---

## Key Files

| File | Purpose |
|------|---------|
| `src/agents/base.ts` | Agent interface, topic mapping, cross-agent utilities |
| `src/agents/index.ts` | Agent registry and exports |
| `src/agents/general.ts` | Orchestrator agent -- default handler |
| `src/agents/research.ts` | Research agent -- ReAct reasoning |
| `src/agents/content.ts` | Content agent (CMO) -- RoT reasoning |
| `src/agents/finance.ts` | Finance agent (CFO) -- CoT reasoning |
| `src/agents/strategy.ts` | Strategy agent (CEO) -- ToT reasoning |
| `src/agents/critic.ts` | Critic agent -- Devil's Advocate |
| `src/agents/custom-agent.example.ts` | Template for creating your own agent |

---

## Agent Configuration Interface

Every agent implements the `AgentConfig` interface defined in `src/agents/base.ts`:

```typescript
export interface AgentConfig {
  name: string;          // Display name (e.g., "Research Agent")
  topicId?: number;      // Telegram forum topic ID
  systemPrompt: string;  // Full system prompt with instructions
  allowedTools: string[]; // Claude Code tools this agent can use
  model: string;         // Model to use (e.g., "claude-opus-4-5-20251101")
  reasoning?: string;    // Reasoning framework name
  personality?: string;  // Communication style description
}
```

The `systemPrompt` is the most important field -- it defines the agent's
expertise, reasoning process, output format, and constraints.

The `allowedTools` field restricts which Claude Code tools the agent can use.
For example, the Research agent gets `WebSearch` and `WebFetch` but not `Bash`,
while the General agent gets all tools including `Bash` and `Write`.

---

## The Six Agents

### General Agent (Orchestrator)

**File:** `src/agents/general.ts`
**Reasoning:** Adaptive
**Tools:** Read, Write, Glob, Grep, WebSearch, WebFetch, Bash

The default agent and the one with the most power. Handles:
- General conversations
- Cross-agent coordination
- Board meetings (synthesis of all agents)
- Routing suggestions ("This sounds like a Research question...")

### Research Agent

**File:** `src/agents/research.ts`
**Reasoning:** ReAct (Reason + Act)
**Tools:** WebSearch, WebFetch, Read, Glob, Grep

Specializes in gathering and analyzing information. Uses a cyclical
reasoning process:

```
1. REASON: What information do I need? What sources should I check?
2. ACT: Search web, fetch data, analyze content
3. OBSERVE: What did I find? What gaps remain?
4. REPEAT: Until comprehensive picture emerges
5. SYNTHESIZE: Combine findings into actionable intelligence
```

Always outputs: Summary, Key Findings, Sources, Confidence Level, Gaps.

### Content Agent (CMO)

**File:** `src/agents/content.ts`
**Reasoning:** RoT (Recursion of Thought)
**Tools:** Read, WebSearch, WebFetch

Focuses on content strategy, video packaging, and audience growth.
Uses iterative refinement:

```
1. DRAFT: Generate initial idea/strategy
2. CRITIQUE: What would the audience think? What's missing?
3. REFINE: Improve based on critique
4. REPEAT: Until quality threshold met
5. PRESENT: Final version with key insights
```

For video packaging, outputs: Titles (ranked), Hooks, Thumbnail Concepts, Angle Analysis.

### Finance Agent (CFO)

**File:** `src/agents/finance.ts`
**Reasoning:** CoT (Chain of Thought)
**Tools:** Read, WebSearch

Handles financial analysis with step-by-step calculations:

```
1. STATE ASSUMPTIONS: List all assumptions clearly
2. SHOW WORK: Step-by-step calculations
3. SENSITIVITY ANALYSIS: What if assumptions are wrong?
4. RISK ASSESSMENT: What could go wrong?
5. RECOMMENDATION: Based on risk-adjusted returns
```

Always includes: Summary Number, Assumptions, Calculation, Sensitivity, Risk Factors, Recommendation.

### Strategy Agent (CEO)

**File:** `src/agents/strategy.ts`
**Reasoning:** ToT (Tree of Thought)
**Tools:** Read, WebSearch, WebFetch

Thinks about long-term decisions by exploring multiple futures:

```
1. GENERATE PATHS: 3-5 distinct strategic options
2. PROJECT FUTURES: Outcomes at 3 months, 1 year, 3 years
3. IDENTIFY RISKS: Hidden risks that aren't obvious
4. EVALUATE OPTIONALITY: Which path keeps the most doors open?
5. RECOMMEND: Clear recommendation with reasoning
```

Uses frameworks: Leverage Test, Regret Minimization, Optionality Check, Energy Audit.

### Critic Agent

**File:** `src/agents/critic.ts`
**Reasoning:** Devil's Advocate + Pre-mortem
**Tools:** Read, WebSearch

Not tied to a topic -- invoked by other agents or via the `/critic` command.
Challenges ideas before they become costly mistakes:

```
1. ASSUME IT FAILED: "It's 6 months from now and this failed. Why?"
2. LIST FAILURE MODES: Technical, market, personal, timing risks
3. HIDDEN ASSUMPTIONS: What must be true for this to work?
4. OPPORTUNITY COST: What are we NOT doing by pursuing this?
5. REVERSIBILITY: If this fails, what's the recovery cost?
```

Outputs a structured risk assessment with likelihood/impact ratings.

---

## Cross-Agent Invocation

Agents can consult each other. The permission map is defined in
`src/agents/base.ts` (line 60):

```typescript
export const AGENT_INVOCATION_MAP: Record<string, string[]> = {
  research: ["critic"],
  content: ["critic", "research"],
  finance: ["critic"],
  strategy: ["critic", "finance", "research"],
  general: ["critic", "finance", "research", "content", "strategy"],
  critic: [], // Prevents loops
};
```

Key design decisions:
- The **General agent** can invoke any other agent
- The **Critic** cannot invoke others (prevents infinite loops)
- **Strategy** can pull in Finance and Research for informed decisions

The `formatCrossAgentContext()` function creates a structured prompt:

```typescript
export function formatCrossAgentContext(
  sourceAgent: string,
  targetAgent: string,
  context: string,
  question: string
): string {
  return `## CROSS-AGENT CONSULTATION
  You are being consulted by the **${sourceAgent}** agent.
  **CONTEXT FROM ${sourceAgent.toUpperCase()}:** ${context}
  **QUESTION/REQUEST:** ${question}`;
}
```

Invocation depth is limited to prevent runaway chains:

```typescript
export function canContinueInvocation(
  ctx: InvocationContext,
  targetAgent: string
): boolean {
  if (ctx.chain.includes(targetAgent)) return false; // No circles
  if (ctx.chain.length >= ctx.maxDepth) return false; // Depth limit
  return true;
}
```

---

## Board Meetings

The General agent supports "board meetings" -- a synthesis of all agents.
Triggered by `/board` or "board meeting" in Telegram:

```typescript
if (lowerText === "/board" || lowerText === "board meeting") {
  const boardPrompt = "Board meeting requested. Review all recent activity...";
  await callClaudeAndReply(ctx, chatId, boardPrompt, "general", topicId);
}
```

The General agent's system prompt defines a 4-phase board meeting process:
1. **Gather** -- review recent conversations from all topics
2. **Synthesize** -- summarize each agent's key discussions
3. **Connect** -- find patterns, conflicts, cross-functional opportunities
4. **Recommend** -- propose coordinated actions with ownership

---

## Creating Custom Agents

Use `src/agents/custom-agent.example.ts` as a template:

### Step 1: Copy the Template

```bash
cp src/agents/custom-agent.example.ts src/agents/my-agent.ts
```

### Step 2: Configure the Agent

Edit `my-agent.ts` and customize:
- `name`: display name
- `reasoning`: one of ReAct, CoT, ToT, RoT, devils-advocate, adaptive
- `allowedTools`: which Claude tools it can use
- `systemPrompt`: detailed instructions for behavior

### Step 3: Register the Agent

Add a case to the switch statement in `src/agents/base.ts`:

```typescript
case "my-agent":
  return require("./my-agent").default;
```

### Step 4: Map to a Topic

Add the topic ID mapping in `src/agents/base.ts`:

```typescript
export const topicAgentMap: Record<number, string> = {
  // ... existing mappings
  7: "my-agent",  // Your new topic ID
};
```

### Step 5: Update Cross-Agent Permissions

Add your agent to `AGENT_INVOCATION_MAP` if it should be able to
consult other agents (or be consulted by them).

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/agents/base.ts` | AgentConfig interface, topic mapping, cross-agent logic |
| `src/agents/index.ts` | Registry, exports, quick reference |
| `src/agents/general.ts` | Orchestrator with board meeting capability |
| `src/agents/research.ts` | ReAct reasoning for research tasks |
| `src/agents/content.ts` | RoT reasoning for content strategy |
| `src/agents/finance.ts` | CoT reasoning for financial analysis |
| `src/agents/strategy.ts` | ToT reasoning for strategic decisions |
| `src/agents/critic.ts` | Devil's advocate for stress-testing ideas |
| `src/agents/custom-agent.example.ts` | Template for new agents |

---

**Next module:** [05 - Smart Check-ins](./05-smart-checkins.md)
