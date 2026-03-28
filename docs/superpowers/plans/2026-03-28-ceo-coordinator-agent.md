# CEO Coordinator Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CEO coordinator agent that autonomously breaks project goals into tasks, delegates to specialist agents, and only escalates to the user (board member) for approval gates.

**Architecture:** The CEO agent is a new agent type that coordinates the existing specialist agents (Finance, Research, Content, Strategy, CTO, COO). It reads project goals, generates an execution plan (list of tasks with agent assignments and dependencies), presents the plan for user approval via HITL buttons, then dispatches agents sequentially. Results are synthesized and reported back. The user stays in "board member" mode — setting goals and approving plans, never micromanaging individual tasks.

**Tech Stack:** TypeScript, Grammy (Telegram), Convex (persistence), Claude Code subprocess (execution)

---

### Task 1: Create CEO Agent Config

**Files:**
- Create: `src/agents/ceo.ts`
- Modify: `src/agents/base.ts:38-64` (add CEO to getAgentConfig)
- Modify: `src/agents/base.ts:67-76` (add CEO to invocation map)

- [ ] **Step 1: Create `src/agents/ceo.ts`**

```typescript
/**
 * CEO Agent — Autonomous Coordinator
 *
 * Sits between the user (board member) and specialist agents.
 * Breaks goals into tasks, delegates, synthesizes, escalates only for approvals.
 *
 * Reasoning: Goal Decomposition — break high-level objectives into delegatable tasks
 */

import type { AgentConfig } from "./base";
import { BASE_CONTEXT, DEFAULT_ALLOWED_TOOLS } from "./base";

const config: AgentConfig = {
  name: "CEO Agent",
  model: "claude-opus-4-5-20251101",
  reasoning: "goal-decomposition",
  personality: "decisive, autonomous, delegation-first",
  allowedTools: DEFAULT_ALLOWED_TOOLS,
  systemPrompt: `${BASE_CONTEXT}

## CEO AGENT ROLE

You are the CEO Agent — the autonomous coordinator for Alvin's business operations.
You sit between Alvin (the board member) and the specialist agents. Your job is to
turn high-level goals into executed results, only escalating for approval gates.

## YOUR OPERATING MODEL

Alvin is the BOARD MEMBER. He sets goals and approves plans. He does NOT manage tasks.
You are the CEO. You decompose goals, delegate to agents, synthesize results, and report back.

## SPECIALIST AGENTS (your direct reports)

| Agent | Domain | Use For |
|-------|--------|---------|
| Finance | Numbers, pricing, ROI, deals | Financial analysis, pricing models, deal evaluation |
| Research | Market intel, competitors, data | Background research, competitor analysis, benchmarks |
| Content | Writing, messaging, presentations | Drafts, proposals, pitch decks, email copy |
| Strategy | Long-term planning, positioning | Strategic recommendations, market positioning |
| CTO | Technical systems, architecture | Technical feasibility, implementation plans |
| COO | Execution, accountability, ops | Timelines, accountability tracking, process design |
| Critic | Stress-testing, devil's advocate | Pre-mortem, risk identification |

## PLAN GENERATION FORMAT

When asked to create an execution plan, output EXACTLY this format:

PLAN_TITLE: [one-line description]
PLAN_TASK_1: [agent_name] | [task description, max 80 chars]
PLAN_TASK_2: [agent_name] | [task description, max 80 chars]
PLAN_TASK_3: [agent_name] | [task description, max 80 chars]
...up to PLAN_TASK_8

Rules:
- agent_name must be one of: finance, research, content, strategy, cto, coo, critic
- Tasks should be ordered by execution sequence (dependencies first)
- Each task must be concrete and completable by the assigned agent in one pass
- 3-8 tasks per plan. More than 8 means the goal is too broad — break it down first

## SYNTHESIS FORMAT

After all agents report back, synthesize with:
1. What was accomplished (2-3 bullets)
2. Key findings or artifacts produced
3. Recommended next steps
4. Anything that needs Alvin's approval before proceeding

## ESCALATION RULES — ONLY escalate to Alvin for:
- Spending money (deals, purchases, subscriptions)
- External communications (emails to clients/partners)
- Strategic pivots (changing direction on a project)
- Hiring or personnel decisions
- Anything with legal/compliance implications

Everything else — research, drafts, analysis, internal planning — just do it.

## BUSINESS CONTEXT
- Straits Interactive: AI & data protection training/certification across ASEAN
- Key markets: Singapore, Malaysia, Philippines
- Core offerings: AIGP, CIPM, DPO certifications + AI workshops + consulting
- Partners: DRB/TDI (Malaysia), SMU Academy, GGU, ITE
`,
};

export default config;
```

- [ ] **Step 2: Register CEO in `src/agents/base.ts` — getAgentConfig**

Add `ceo` case to the switch statement in `getAgentConfig()`:

```typescript
    case "ceo":
      return require("./ceo").default;
    case "coo":
```

- [ ] **Step 3: Register CEO in `src/agents/base.ts` — invocation map**

Update `AGENT_INVOCATION_MAP` to add CEO permissions:

```typescript
export const AGENT_INVOCATION_MAP: Record<string, string[]> = {
  research: ["critic"],
  content: ["critic", "research"],
  finance: ["critic"],
  strategy: ["critic", "finance", "research"],
  general: ["critic", "finance", "research", "content", "strategy", "cto", "coo"],
  ceo: ["critic", "finance", "research", "content", "strategy", "cto", "coo"],
  cto: ["critic", "research"],
  coo: ["critic", "finance", "research", "strategy"],
  critic: [],
};
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit 2>&1 | grep -E "ceo|agents/base"`
Expected: no new errors

- [ ] **Step 5: Commit**

```bash
git add src/agents/ceo.ts src/agents/base.ts
git commit -m "feat: add CEO coordinator agent config"
```

---

### Task 2: Build CEO Coordinator Core — Plan Generation & Parsing

**Files:**
- Create: `src/lib/ceo-coordinator.ts`

This is the core logic file. It handles plan generation (asking the CEO agent to decompose a goal), plan parsing (extracting structured tasks from CEO output), and plan execution (dispatching agents sequentially).

- [ ] **Step 1: Create `src/lib/ceo-coordinator.ts` with types and plan parser**

```typescript
/**
 * CEO Coordinator — Goal-Driven Agent Orchestration
 *
 * Turns project goals into executed results by:
 * 1. Asking the CEO agent to decompose goals into agent tasks
 * 2. Presenting the plan for user approval (HITL)
 * 3. Dispatching agents sequentially
 * 4. Synthesizing results and reporting back
 */

import type { Context } from "grammy";
import type { Project } from "./projects";
import { formatProjectContext, updateProject, appendProjectContext } from "./projects";
import { getMemoryContext } from "./memory";
import { getUserProfile } from "../agents";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CEOTask {
  index: number;
  agentName: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
}

export interface CEOPlan {
  title: string;
  goal: string;
  projectId: string;
  projectName: string;
  tasks: CEOTask[];
  status: "draft" | "approved" | "executing" | "completed" | "failed";
}

// ---------------------------------------------------------------------------
// Plan Parsing
// ---------------------------------------------------------------------------

const VALID_AGENTS = new Set([
  "finance", "research", "content", "strategy", "cto", "coo", "critic",
]);

/**
 * Parse CEO agent output into a structured plan.
 * Expects lines like:
 *   PLAN_TITLE: Build partnership proposal
 *   PLAN_TASK_1: research | Analyze WMI org structure and decision makers
 *   PLAN_TASK_2: finance | Model pricing at $6K/day for 20 pax
 */
export function parseCEOPlan(
  output: string,
  goal: string,
  projectId: string,
  projectName: string
): CEOPlan | null {
  const lines = output.split("\n");

  let title = "";
  const tasks: CEOTask[] = [];

  for (const line of lines) {
    const titleMatch = line.match(/^PLAN_TITLE:\s*(.+)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }

    const taskMatch = line.match(/^PLAN_TASK_(\d+):\s*(\w+)\s*\|\s*(.+)$/i);
    if (taskMatch) {
      const agentName = taskMatch[2].trim().toLowerCase();
      const description = taskMatch[3].trim();

      if (!VALID_AGENTS.has(agentName)) continue;
      if (tasks.length >= 8) break;

      tasks.push({
        index: tasks.length + 1,
        agentName,
        description,
        status: "pending",
      });
    }
  }

  if (tasks.length === 0) return null;

  return {
    title: title || `Execute: ${goal.slice(0, 60)}`,
    goal,
    projectId,
    projectName,
    tasks,
    status: "draft",
  };
}

// ---------------------------------------------------------------------------
// Plan Generation
// ---------------------------------------------------------------------------

/**
 * Build the prompt that asks the CEO agent to decompose a goal into tasks.
 */
export function buildPlanPrompt(
  project: Project,
  goal: string,
  userProfile: string,
  memoryContext: string
): string {
  const projectContext = formatProjectContext(project);

  return `## CEO TASK: CREATE EXECUTION PLAN

${projectContext}

${userProfile ? `## USER PROFILE\n${userProfile}\n` : ""}
${memoryContext ? `## MEMORY CONTEXT\n${memoryContext}\n` : ""}

## GOAL TO EXECUTE
${goal}

Create an execution plan to achieve this goal. Assign each task to the most appropriate specialist agent.

Output your plan in EXACTLY this format — nothing else:

PLAN_TITLE: [one-line plan description]
PLAN_TASK_1: [agent_name] | [concrete task description]
PLAN_TASK_2: [agent_name] | [concrete task description]
...

Rules:
- agent_name must be one of: finance, research, content, strategy, cto, coo, critic
- 3-8 tasks, ordered by execution sequence
- Each task must be completable by the assigned agent in one pass
- Be specific — "Research WMI's training budget and approval process" not "Do research"`;
}

// ---------------------------------------------------------------------------
// Plan Formatting (for Telegram display)
// ---------------------------------------------------------------------------

const AGENT_EMOJI: Record<string, string> = {
  finance: "💰",
  research: "🔍",
  strategy: "📈",
  content: "📣",
  cto: "🛠",
  coo: "⚙️",
  critic: "🎯",
};

export function formatPlanForDisplay(plan: CEOPlan): string {
  const taskLines = plan.tasks.map((t) => {
    const emoji = AGENT_EMOJI[t.agentName] || "▪️";
    const status = t.status === "completed" ? "✅"
      : t.status === "running" ? "⏳"
      : t.status === "failed" ? "❌"
      : "⬜";
    return `${status} ${emoji} *${t.agentName}*: ${t.description}`;
  });

  return `🏢 *CEO Plan: ${plan.title}*\n_Goal: ${plan.goal}_\n\n${taskLines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Plan Execution
// ---------------------------------------------------------------------------

/**
 * Execute an approved plan by dispatching agents sequentially.
 * Each agent gets the goal, project context, its specific task, and prior agent results.
 *
 * @param plan - The approved plan
 * @param callSubprocessFn - Function to call Claude subprocess (injected from bot.ts)
 * @param onTaskStart - Callback when a task starts (for Telegram progress updates)
 * @param onTaskComplete - Callback when a task completes
 */
export async function executePlan(
  plan: CEOPlan,
  callSubprocessFn: (prompt: string, agentName: string) => Promise<string>,
  onTaskStart?: (task: CEOTask) => Promise<void>,
  onTaskComplete?: (task: CEOTask) => Promise<void>
): Promise<CEOPlan> {
  plan.status = "executing";
  const completedResults: Array<{ agent: string; task: string; result: string }> = [];

  for (const task of plan.tasks) {
    task.status = "running";
    if (onTaskStart) await onTaskStart(task);

    try {
      // Build task prompt with accumulated context
      const priorContext = completedResults.length > 0
        ? `\n\n## PRIOR AGENT RESULTS\n${completedResults.map(
            (r) => `### ${r.agent}: ${r.task}\n${r.result}`
          ).join("\n\n")}`
        : "";

      const taskPrompt = `## DELEGATED TASK FROM CEO

**Project:** ${plan.projectName}
**Overall Goal:** ${plan.goal}
**Your Assignment:** ${task.description}
${priorContext}

Execute this task. Be thorough but concise. Output actionable results, not plans.
If you produce an artifact (draft, analysis, model), include it in full.`;

      const result = await callSubprocessFn(taskPrompt, task.agentName);
      task.result = result;
      task.status = "completed";

      completedResults.push({
        agent: task.agentName,
        task: task.description,
        result,
      });
    } catch (err) {
      task.status = "failed";
      task.result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (onTaskComplete) await onTaskComplete(task);
  }

  plan.status = plan.tasks.every((t) => t.status === "completed") ? "completed" : "failed";
  return plan;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/**
 * Build a prompt for the CEO to synthesize all agent results.
 */
export function buildSynthesisPrompt(plan: CEOPlan): string {
  const results = plan.tasks
    .filter((t) => t.result)
    .map((t) => {
      const emoji = AGENT_EMOJI[t.agentName] || "▪️";
      return `### ${emoji} ${t.agentName}: ${t.description}\n${t.result}`;
    })
    .join("\n\n");

  return `## CEO SYNTHESIS TASK

**Project:** ${plan.projectName}
**Goal:** ${plan.goal}

## AGENT REPORTS
${results}

## YOUR TASK
Synthesize the above agent reports into a board-level summary for Alvin.

Format:
1. **What was accomplished** (2-3 bullets)
2. **Key deliverables** (artifacts, drafts, analyses produced)
3. **Recommended next steps** (what should happen next)
4. **Needs approval** (anything requiring Alvin's sign-off before proceeding — or "None")

Be decisive. Under 400 words.`;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit 2>&1 | grep "ceo-coordinator"`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/ceo-coordinator.ts
git commit -m "feat: add CEO coordinator core — plan generation, parsing, execution"
```

---

### Task 3: Wire CEO into Bot — `/ceo` Command & HITL Flow

**Files:**
- Modify: `src/bot.ts` — add `/ceo` command handler, plan approval callback, execution loop

This is the integration task. It connects the CEO coordinator to Telegram via:
1. `/ceo <project>` or `/ceo <project> | <goal>` command
2. HITL "Approve Plan" / "Reject Plan" buttons
3. Plan execution with progress updates per task
4. Final synthesis delivery

- [ ] **Step 1: Add imports to `src/bot.ts`**

After the existing board-meeting import (line 86), add:

```typescript
import {
  parseCEOPlan,
  buildPlanPrompt,
  formatPlanForDisplay,
  executePlan,
  buildSynthesisPrompt,
  type CEOPlan,
} from "./lib/ceo-coordinator";
```

- [ ] **Step 2: Add `/ceo` command handler in `src/bot.ts`**

Add this after the `/board` command handler block (around line 506). The pattern follows the same structure as `/board`:

```typescript
    // --- /ceo — CEO autonomous coordinator ---
    if (lowerText === "/ceo" || lowerText.startsWith("/ceo ")) {
      const args = text.replace(/^\/ceo\s*/i, "").trim();

      if (!args) {
        const projects = await listProjects(chatId);
        const list = projects.length > 0
          ? projects.map((p) => `• ${p.name}`).join("\n")
          : "_(no projects)_";
        await ctx.reply(
          `🏢 *CEO Coordinator*\n\nUsage:\n\`/ceo <project>\` — CEO creates plan from project goals\n\`/ceo <project> | <goal>\` — CEO executes a specific goal\n\nProjects:\n${list}`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // Parse: /ceo ProjectName | optional goal override
      const [projectName, ...goalParts] = args.split("|");
      const goalOverride = goalParts.join("|").trim() || undefined;

      await handleCEOCoordinator(ctx, chatId, projectName.trim(), topicId, goalOverride);
      return;
    }
```

- [ ] **Step 3: Add `handleCEOCoordinator` function to `src/bot.ts`**

Add this function near the `handleBoardMeetingV2` function (around line 919):

```typescript
/**
 * CEO Coordinator — autonomous goal execution via agent delegation.
 * 1. Reads project goals (or uses override)
 * 2. Asks CEO agent to generate execution plan
 * 3. Presents plan for user approval (HITL)
 * 4. On approval: dispatches agents, synthesizes, reports
 */
async function handleCEOCoordinator(
  ctx: Context,
  chatId: string,
  projectName: string,
  topicId?: number,
  goalOverride?: string
): Promise<void> {
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    const project = await getProject(chatId, projectName);
    if (!project) {
      await ctx.reply(`Project "${projectName}" not found. Use \`/project new <name>\` to create one.`, { parse_mode: "Markdown" });
      return;
    }

    const goal = goalOverride || project.goals;
    if (!goal) {
      await ctx.reply(
        `Project "${project.name}" has no goals set.\n\nSet one with:\n\`/ceo ${project.name} | Close the workshop deal by April 15\`\n\nor add goals to the project:\n\`/project goals ${project.name} | Your goal here\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // If goal was provided as override, save it to the project
    if (goalOverride) {
      await updateProject(project.id, { goals: goalOverride });
    }

    await ctx.reply(`🏢 *CEO analyzing goal...*\n_${goal}_`, { parse_mode: "Markdown" }).catch(() => {});

    // Ask CEO agent to generate a plan
    const userProfile = await getUserProfile();
    const memoryCtx = await getMemoryContext();
    const planPrompt = buildPlanPrompt(project, goal, userProfile, memoryCtx);

    const planOutput = await callClaudeSubprocess({
      prompt: planPrompt,
      systemPrompt: getAgentConfig("ceo")?.systemPrompt,
      timeoutMs: 120_000,
    });

    if (!planOutput || isClaudeErrorResponse(planOutput)) {
      await ctx.reply("CEO agent failed to generate a plan. Try again.");
      return;
    }

    const plan = parseCEOPlan(planOutput, goal, project.id, project.name);
    if (!plan) {
      // CEO didn't output structured plan — send raw response
      await sendResponse(ctx, planOutput);
      return;
    }

    // Display plan and create HITL approval task
    const planDisplay = formatPlanForDisplay(plan);
    await ctx.reply(planDisplay, { parse_mode: "Markdown" }).catch(() =>
      ctx.reply(planDisplay.replace(/[*_`]/g, ""))
    );

    // Create task for approval
    const task = await createTask(chatId, `CEO Plan: ${plan.title}`, topicId, "mac");
    if (task) {
      await updateTask(task.id, {
        status: "needs_input",
        pending_question: `Approve this plan?`,
        pending_options: [
          { label: "✅ Approve — execute now", value: "approve" },
          { label: "❌ Reject", value: "reject" },
        ],
        metadata: {
          type: "ceo_plan",
          plan: JSON.parse(JSON.stringify(plan)),
          project_id: project.id,
          project_name: project.name,
        },
      });

      const keyboard = buildTaskKeyboard(task.id, [
        { label: "✅ Approve — execute now", value: "approve" },
        { label: "❌ Reject", value: "reject" },
      ]);

      await ctx.reply("Approve this plan?", { reply_markup: keyboard });
    }
  } catch (err) {
    console.error("CEO coordinator error:", err);
    await ctx.reply("CEO coordinator failed. Please try again.");
  } finally {
    typing.stop();
  }
}
```

- [ ] **Step 4: Add CEO plan approval callback in `src/bot.ts`**

In the callback_query handler, add this block BEFORE the existing board_decision handler (around line 1625). This handles the "Approve" / "Reject" buttons for CEO plans:

```typescript
    // --- CEO plan approval: execute or reject ---
    if (task.metadata?.type === "ceo_plan") {
      if (result.choice === "reject" || result.cancelled) {
        await updateTask(result.taskId, { status: "failed", result: "Plan rejected by user" });
        await ctx.reply("Plan rejected. Modify the goal and try again.");
        return;
      }

      // Approved — execute the plan
      const plan = task.metadata.plan as CEOPlan;
      await updateTask(result.taskId, { status: "running", result: "Executing plan..." });

      await ctx.reply("🏢 *CEO executing plan...*", { parse_mode: "Markdown" }).catch(() => {});

      const executedPlan = await executePlan(
        plan,
        // Subprocess caller — same pattern as board meeting
        async (prompt: string, agentName: string) => {
          const result = await callClaudeSubprocess({
            prompt,
            systemPrompt: getAgentConfig(agentName)?.systemPrompt,
            timeoutMs: 120_000,
          });
          return result || "_(agent unavailable)_";
        },
        // onTaskStart
        async (t) => {
          const emoji = { finance: "💰", research: "🔍", strategy: "📈", content: "📣", cto: "🛠", coo: "⚙️", critic: "🎯" }[t.agentName] || "▪️";
          await ctx.reply(`${emoji} *${t.agentName}* working on: _${t.description}_`, { parse_mode: "Markdown" }).catch(() => {});
        },
        // onTaskComplete
        async (t) => {
          if (t.status === "completed" && t.result) {
            const emoji = { finance: "💰", research: "🔍", strategy: "📈", content: "📣", cto: "🛠", coo: "⚙️", critic: "🎯" }[t.agentName] || "▪️";
            const truncated = t.result.length > 2000 ? t.result.slice(0, 2000) + "..." : t.result;
            await ctx.reply(`${emoji} *${t.agentName}* ✅\n\n${truncated}`, { parse_mode: "Markdown" }).catch(() =>
              ctx.reply(`${t.agentName} done:\n\n${truncated}`)
            );
            await new Promise((r) => setTimeout(r, 500)); // Rate limit buffer
          }
        }
      );

      // Synthesize results
      await ctx.reply("_CEO synthesizing results..._", { parse_mode: "Markdown" }).catch(() => {});
      const synthesisPrompt = buildSynthesisPrompt(executedPlan);
      const synthesis = await callClaudeSubprocess({
        prompt: synthesisPrompt,
        systemPrompt: getAgentConfig("ceo")?.systemPrompt,
        timeoutMs: 120_000,
      });

      if (synthesis) {
        await sendResponse(ctx, `🏢 *CEO Report*\n\n${synthesis}`);
        // Save to conversation history
        await saveMessage({
          chat_id: chatId,
          role: "assistant",
          content: `[CEO Report: ${plan.projectName}]\n${synthesis}`,
          metadata: { type: "ceo_report", project_id: plan.projectId },
        });
        // Append summary to project context
        await appendProjectContext(plan.projectId, `CEO executed: ${plan.title}\n${synthesis.slice(0, 500)}`);
      }

      await updateTask(result.taskId, {
        status: "completed",
        result: synthesis || "Plan executed",
      });
      return;
    }
```

- [ ] **Step 5: Verify `callClaudeSubprocess` signature compatibility**

The `callClaudeSubprocess` function in `src/lib/claude.ts` uses `ClaudeOptions`. Check how it's called from `handleBoardMeetingV2` to match the pattern. The CEO handler should use the same call pattern. In `bot.ts`, the board meeting uses a local wrapper — the CEO plan callback should follow the same pattern.

Look at lines 844-857 of bot.ts (the board meeting subprocess caller) for the exact call pattern. The CEO callback above uses the same shape — `callClaudeSubprocess({ prompt, systemPrompt, timeoutMs })`. Verify this matches the import at line 22:

```typescript
import { callClaude as callClaudeSubprocess, callClaudeStreaming, isClaudeErrorResponse } from "./lib/claude";
```

If `callClaude` accepts `ClaudeOptions` (which has `prompt`, `outputFormat`, `allowedTools`, `resumeSessionId`, `timeoutMs`, `cwd`, `maxTurns`), note that `systemPrompt` is NOT in `ClaudeOptions`. Instead, the board meeting builds a full prompt that includes the system prompt inline. Adjust the CEO code to do the same — prepend the agent system prompt to the task prompt:

```typescript
async (prompt: string, agentName: string) => {
  const agentConfig = getAgentConfig(agentName);
  const fullPrompt = agentConfig
    ? `${agentConfig.systemPrompt}\n\n${prompt}`
    : prompt;
  const result = await callClaudeSubprocess({
    prompt: fullPrompt,
    timeoutMs: 120_000,
  });
  return result || "_(agent unavailable)_";
},
```

Apply the same fix in `handleCEOCoordinator` where the CEO agent is called for plan generation:

```typescript
const ceoConfig = getAgentConfig("ceo");
const fullPlanPrompt = ceoConfig
  ? `${ceoConfig.systemPrompt}\n\n${planPrompt}`
  : planPrompt;
const planOutput = await callClaudeSubprocess({
  prompt: fullPlanPrompt,
  timeoutMs: 120_000,
});
```

- [ ] **Step 6: Verify `callClaudeSubprocess` return type**

`callClaude` returns `Promise<ClaudeResult>` which is `{ text: string; sessionId?: string; isError: boolean }`. The code above treats the return as a string. Fix to use `.text`:

In `handleCEOCoordinator`:
```typescript
const planResult = await callClaudeSubprocess({ prompt: fullPlanPrompt, timeoutMs: 120_000 });
if (!planResult || planResult.isError) { ... }
const plan = parseCEOPlan(planResult.text, goal, project.id, project.name);
```

In the plan execution callback:
```typescript
async (prompt: string, agentName: string) => {
  const agentConfig = getAgentConfig(agentName);
  const fullPrompt = agentConfig ? `${agentConfig.systemPrompt}\n\n${prompt}` : prompt;
  const r = await callClaudeSubprocess({ prompt: fullPrompt, timeoutMs: 120_000 });
  return r?.text || "_(agent unavailable)_";
},
```

In the synthesis call:
```typescript
const synthesisResult = await callClaudeSubprocess({ prompt: fullSynthesisPrompt, timeoutMs: 120_000 });
const synthesis = synthesisResult?.text;
```

- [ ] **Step 7: Verify types compile**

Run: `npx tsc --noEmit 2>&1 | grep -E "bot\.ts.*ceo|ceo-coordinator"`
Expected: no new errors

- [ ] **Step 8: Commit**

```bash
git add src/bot.ts src/lib/ceo-coordinator.ts
git commit -m "feat: wire CEO coordinator into bot — /ceo command, HITL approval, agent dispatch"
```

---

### Task 4: Manual Integration Test

**Files:** None (testing only)

- [ ] **Step 1: Start the bot**

Run: `bun run start`

- [ ] **Step 2: Test `/ceo` with no args**

Send `/ceo` in Telegram. Should show usage help and project list.

- [ ] **Step 3: Test `/ceo` with a project and goal**

Send `/ceo WMI | Draft a proposal for the AI workshop` (substitute with an actual project name).

Verify:
1. Bot shows "CEO analyzing goal..."
2. Plan appears with agent assignments
3. Approve/Reject buttons appear
4. Tapping "Approve" triggers sequential agent execution
5. Each agent reports back with results
6. Final CEO synthesis is delivered

- [ ] **Step 4: Test plan rejection**

Run `/ceo` again, tap "Reject". Verify it acknowledges and stops.

- [ ] **Step 5: Commit any fixes**

```bash
git add -u
git commit -m "fix: CEO coordinator integration test fixes"
```

---

### Task 5: Add `/goal` Shortcut Command

**Files:**
- Modify: `src/bot.ts` — add `/goal` command that sets a project goal and triggers CEO

This provides the streamlined UX: `/goal WMI "Close workshop deal by April 15"` → CEO takes over.

- [ ] **Step 1: Add `/goal` command handler in `src/bot.ts`**

Add after the `/ceo` command handler:

```typescript
    // --- /goal — Set project goal and trigger CEO ---
    if (lowerText.startsWith("/goal ")) {
      const args = text.replace(/^\/goal\s*/i, "").trim();
      // Parse: /goal ProjectName goal text here
      // or: /goal ProjectName | goal text here
      const pipeMatch = args.match(/^(\S+)\s*\|\s*(.+)$/s);
      const spaceMatch = args.match(/^(\S+)\s+(.+)$/s);
      const match = pipeMatch || spaceMatch;

      if (!match) {
        await ctx.reply(
          `Usage: \`/goal <project> <goal>\`\nExample: \`/goal WMI Close the workshop deal by April 15\``,
          { parse_mode: "Markdown" }
        );
        return;
      }

      const [, projectName, goal] = match;
      await handleCEOCoordinator(ctx, chatId, projectName.trim(), topicId, goal.trim());
      return;
    }
```

- [ ] **Step 2: Test the shortcut**

Send `/goal WMI Draft workshop proposal` in Telegram. Should trigger the full CEO flow.

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat: add /goal shortcut — sets project goal and triggers CEO coordinator"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] CEO agent with coordination-focused system prompt
   - [x] Goal decomposition into agent-assigned tasks
   - [x] Plan approval via HITL (Approve/Reject buttons)
   - [x] Sequential agent dispatch with progress updates
   - [x] Synthesis and board-level reporting
   - [x] `/ceo` and `/goal` commands
   - [x] Results saved to conversation history and project context
   - [x] Escalation rules (only surface approvals for external actions)

2. **Placeholder scan:** No TBD/TODO found. All code blocks are complete.

3. **Type consistency:** `CEOPlan`, `CEOTask` used consistently. `callClaudeSubprocess` returns `ClaudeResult` (addressed in Step 6). Agent names match `VALID_AGENTS` set.

4. **Not in scope (Phase 2):**
   - CEO heartbeat service (scheduled wake-up to check goals proactively)
   - Parallel task execution (tasks with no dependencies could run simultaneously)
   - Per-task HITL gates (agent asks for approval mid-execution)
   - CEO memory of past plans and outcomes
