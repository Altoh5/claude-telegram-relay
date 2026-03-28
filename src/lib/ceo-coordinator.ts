/**
 * CEO Coordinator — Goal-Driven Agent Orchestration
 *
 * Turns project goals into executed results by:
 * 1. Asking the CEO agent to decompose goals into agent tasks
 * 2. Presenting the plan for user approval (HITL)
 * 3. Dispatching agents sequentially (later agents see prior results)
 * 4. Synthesizing results and reporting back
 */

import type { Project } from "./projects";
import { formatProjectContext } from "./projects";

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
// Plan Generation Prompt
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
  finance: "\u{1F4B0}",
  research: "\u{1F50D}",
  strategy: "\u{1F4C8}",
  content: "\u{1F4E3}",
  cto: "\u{1F6E0}",
  coo: "\u2699\uFE0F",
  critic: "\u{1F3AF}",
};

export function getAgentEmoji(agentName: string): string {
  return AGENT_EMOJI[agentName] || "\u25AA\uFE0F";
}

export function formatPlanForDisplay(plan: CEOPlan): string {
  const taskLines = plan.tasks.map((t) => {
    const emoji = getAgentEmoji(t.agentName);
    const status = t.status === "completed" ? "\u2705"
      : t.status === "running" ? "\u23F3"
      : t.status === "failed" ? "\u274C"
      : "\u2B1C";
    return `${status} ${emoji} *${t.agentName}*: ${t.description}`;
  });

  return `\u{1F3E2} *CEO Plan: ${plan.title}*\n_Goal: ${plan.goal}_\n\n${taskLines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Plan Execution
// ---------------------------------------------------------------------------

/**
 * Execute an approved plan by dispatching agents sequentially.
 * Each agent gets the goal, project context, its specific task, and prior agent results.
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
// Synthesis Prompt
// ---------------------------------------------------------------------------

/**
 * Build a prompt for the CEO to synthesize all agent results.
 */
export function buildSynthesisPrompt(plan: CEOPlan): string {
  const results = plan.tasks
    .filter((t) => t.result)
    .map((t) => {
      const emoji = getAgentEmoji(t.agentName);
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
