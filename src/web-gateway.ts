/**
 * Web Gateway — local browser interface for GoBot agents
 *
 * Same agents as Telegram, persistent per-agent history in Supabase.
 * Uses SSE for tool progress + final response streaming.
 *
 * Usage: bun run web
 * Then open http://localhost:3001
 */

import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { loadEnv } from "./lib/env";
import { callClaudeStreaming, callClaude } from "./lib/claude";
import { getAgentConfig, getUserProfile } from "./agents";
import { saveMessage, getRecentMessages, getConversationContext } from "./lib/db";
import { getConvex } from "./lib/convex-client";
import { api } from "../convex/_generated/api";
import { getMemoryContext, processIntents } from "./lib/memory";
import { runBoardMeeting } from "./lib/board-meeting";
import { getProject, listProjects, createProject, appendProjectContext, archiveProject, createBoardSession, formatProjectContext } from "./lib/projects";
import { sendTelegramMessage } from "./lib/telegram";

await loadEnv(join(process.cwd(), ".env"));

const PORT = parseInt(process.env.WEB_PORT || "3002", 10);
const TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const PROJECT_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Agent metadata for the sidebar
// ---------------------------------------------------------------------------

const AGENT_META: Record<string, { icon: string; subtitle: string }> = {
  general:  { icon: "⚡", subtitle: "Default orchestrator" },
  research: { icon: "🔬", subtitle: "Market intel, analysis" },
  content:  { icon: "🎬", subtitle: "Video, audience growth" },
  finance:  { icon: "💰", subtitle: "ROI, unit economics" },
  strategy: { icon: "🎯", subtitle: "Decisions, long-term" },
  cto:      { icon: "🖥️",  subtitle: "Tech architecture" },
  coo:      { icon: "⚙️",  subtitle: "Ops, accountability" },
  critic:   { icon: "🔥", subtitle: "Devil's advocate" },
};

const AGENT_ORDER = ["general", "research", "content", "finance", "strategy", "cto", "coo", "critic"];

// Shared chat_id with Telegram — use group chat if available, else user DM
const WEB_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_USER_ID || "web";

// For getConversationContext (used in prompt building) we still filter by agent
// via metadata, but use the shared chat_id
function webChatId(_agent: string) {
  return WEB_CHAT_ID;
}

// Fetch messages filtered by metadata.agent from Convex
async function getMessagesByAgent(agent: string, limit = 50): Promise<Array<{role: string; content: string; created_at: string}>> {
  const cx = getConvex();
  if (!cx) return [];
  try {
    const rows = await cx.query(api.messages.getByAgent, {
      chat_id: WEB_CHAT_ID,
      agent,
      limit,
    });
    return rows.map((r: any) => ({
      role: r.role,
      content: r.content,
      created_at: new Date(r._creationTime).toISOString(),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Prompt builder (mirrors bot.ts callClaude logic)
// ---------------------------------------------------------------------------

async function buildPrompt(userMessage: string, agent: string): Promise<string> {
  const agentConfig = getAgentConfig(agent);
  const userProfile = await getUserProfile();
  const memoryCtx = await getMemoryContext();
  const conversationCtx = await getConversationContext(webChatId(agent), 20);

  const now = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });

  const sections: string[] = [];

  sections.push(
    agentConfig?.systemPrompt ??
    "You are Go, a personal AI assistant. Be concise, direct, and helpful."
  );
  if (userProfile)     sections.push(`## USER PROFILE\n${userProfile}`);
  sections.push(`## CURRENT TIME\n${now}`);
  if (memoryCtx)       sections.push(`## MEMORY\n${memoryCtx}`);
  if (conversationCtx) sections.push(`## RECENT CONVERSATION\n${conversationCtx}`);

  sections.push(`## INTENT DETECTION
If the user sets a goal, include: [GOAL: description | DEADLINE: deadline]
If a goal is completed, include: [DONE: partial match]
If the user wants to cancel/abandon a goal, include: [CANCEL: partial match]
If you learn a fact worth remembering, include: [REMEMBER: fact]
If the user wants to forget a stored fact, include: [FORGET: partial match]`);

  // Web-only: cross-agent invocation support
  sections.push(`## CROSS-AGENT INVOCATION (WEB UI ONLY)
If this request would clearly benefit from a specialized agent, append ONE tag at the END of your response (after all other content):
[INVOKE: agent_name | specific task or question for that agent]
Available agents: research, content, finance, strategy, cto, coo, critic
Rules: only invoke when genuinely useful, max 1 invocation, omit the tag entirely if not needed.
Example: [INVOKE: research | Find recent PDPA enforcement cases in Malaysia 2024-2025]`);

  sections.push(`## USER MESSAGE\n${userMessage}`);

  return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Cross-agent invocation helpers
// ---------------------------------------------------------------------------

const INVOKE_RE = /\[INVOKE:\s*([\w-]+)\s*\|\s*([^\]]+)\]/i;

function parseInvokeTag(text: string): { agent: string; task: string } | null {
  const m = text.match(INVOKE_RE);
  if (!m) return null;
  const agent = m[1].trim().toLowerCase();
  if (!AGENT_META[agent]) return null; // unknown agent
  return { agent, task: m[2].trim() };
}

function stripInvokeTag(text: string): string {
  return text.replace(INVOKE_RE, "").trim();
}

async function runCrossAgent(
  sourceAgent: string,
  targetAgent: string,
  originalMessage: string,
  sourceResponse: string,
  task: string
): Promise<string> {
  const agentConfig = getAgentConfig(targetAgent);
  const userProfile = await getUserProfile();
  const memoryCtx  = await getMemoryContext();
  const convCtx    = await getConversationContext(webChatId(targetAgent), 10);

  const now = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });

  const sections: string[] = [];
  sections.push(
    agentConfig?.systemPrompt ??
    "You are Go, a personal AI assistant. Be concise, direct, and helpful."
  );
  if (userProfile)  sections.push(`## USER PROFILE\n${userProfile}`);
  sections.push(`## CURRENT TIME\n${now}`);
  if (memoryCtx)    sections.push(`## MEMORY\n${memoryCtx}`);
  if (convCtx)      sections.push(`## RECENT CONVERSATION\n${convCtx}`);

  sections.push(`## CROSS-AGENT CONTEXT
You were invoked by the ${sourceAgent} agent to handle a specific task.

Original user question:
${originalMessage}

${sourceAgent} agent's analysis:
${sourceResponse}

Your specific task: ${task}`);

  return sections.join("\n\n---\n\n");
}


// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  idleTimeout: 0,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // --- GET /convex-browser.js → serve Convex browser bundle ---
    if (req.method === "GET" && url.pathname === "/convex-browser.js") {
      const bundlePath = join(process.cwd(), "node_modules/convex/dist/browser.bundle.js");
      const file = Bun.file(bundlePath);
      return new Response(file, { headers: { "Content-Type": "application/javascript" } });
    }

    // --- GET / → serve UI ---
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // --- GET /api/agents ---
    if (req.method === "GET" && url.pathname === "/api/agents") {
      const agents = AGENT_ORDER.map((id) => ({
        id,
        name: id === 'cto' ? 'CTO' : id === 'coo' ? 'COO' : id.charAt(0).toUpperCase() + id.slice(1),
        ...AGENT_META[id],
      }));
      return Response.json(agents);
    }

    // --- GET /api/messages?agent=cto ---
    if (req.method === "GET" && url.pathname === "/api/messages") {
      const agent = url.searchParams.get("agent") || "general";
      const messages = await getMessagesByAgent(agent, 50);
      return Response.json(messages.map((m) => ({
        role: m.role,
        content: m.content,
        ts: m.created_at,
      })));
    }

    // --- POST /api/chat → SSE stream ---
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { message, agent = "general", fileUrl, fileName } = (await req.json()) as {
        message: string;
        agent?: string;
        fileUrl?: string;
        fileName?: string;
      };

      if (!message?.trim()) {
        return Response.json({ error: "message required" }, { status: 400 });
      }

      const chatId = webChatId(agent);
      const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
      const telegramChatId = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_USER_ID || "";

      // Save user message
      const userContent = fileUrl ? `${message}\n[Attached file: ${fileName} — ${process.env.WEB_BASE_URL || "http://localhost:" + PORT}${fileUrl}]` : message;
      await saveMessage({
        chat_id: chatId,
        role: "user",
        content: userContent,
        metadata: { agent, source: "web", fileUrl, fileName },
      });

      // Forward user message to Telegram so the conversation appears there too
      if (botToken && telegramChatId) {
        const agentLabel = agent === "general" ? "" : ` [${agent.toUpperCase()}]`;
        sendTelegramMessage(botToken, telegramChatId, `🖥️${agentLabel} ${userContent}`).catch(() => {});
      }

      // --- /project commands ---
      if (message.trim().toLowerCase().startsWith("/project")) {
        const args = message.trim().replace(/^\/project\s*/i, "").trim();
        const [sub, ...rest] = args.split(/\s+/);

        if (!sub || sub === "help") {
          return Response.json({ text: "**Project Commands**\n\n`/project new <name>` — create\n`/project list` — list all\n`/project show <name>` — details\n`/project context <name> | <text>` — add context\n`/project archive <name>` — archive\n\nThen run `/board <name>` for a board meeting." });
        }
        if (sub === "new") {
          const name = rest.join(" ").trim();
          if (!name) return Response.json({ text: "Usage: `/project new <name>`" });
          const project = await createProject(chatId, name);
          return Response.json({ text: project ? `✅ Project **${name}** created.\n\nAdd context: \`/project context ${name} | <notes>\`` : "Failed to create project." });
        }
        if (sub === "list") {
          const projects = await listProjects(chatId);
          if (!projects.length) return Response.json({ text: "No active projects. Create one with `/project new <name>`" });
          return Response.json({ text: `**Active Projects**\n\n${projects.map((p: any) => `• **${p.name}**${p.description ? ` — ${p.description}` : ""}`).join("\n")}` });
        }
        if (sub === "show") {
          const name = rest.join(" ").trim();
          const project = await getProject(chatId, name);
          if (!project) return Response.json({ text: `Project "${name}" not found.` });
          return Response.json({ text: formatProjectContext(project) });
        }
        if (sub === "context") {
          const full = rest.join(" ");
          const pipeIdx = full.indexOf("|");
          if (pipeIdx === -1) return Response.json({ text: "Usage: `/project context <name> | <notes to add>`" });
          const name = full.slice(0, pipeIdx).trim();
          const contextText = full.slice(pipeIdx + 1).trim();
          const project = await getProject(chatId, name);
          if (!project) return Response.json({ text: `Project "${name}" not found.` });
          const ok = await appendProjectContext(project.id, contextText);
          return Response.json({ text: ok ? `✅ Context added to **${project.name}**.` : "Failed to update context." });
        }
        if (sub === "archive") {
          const name = rest.join(" ").trim();
          const project = await getProject(chatId, name);
          if (!project) return Response.json({ text: `Project "${name}" not found.` });
          const ok = await archiveProject(project.id);
          return Response.json({ text: ok ? `✅ Project **${project.name}** archived.` : "Failed to archive." });
        }
        return Response.json({ text: `Unknown subcommand: ${sub}. Try \`/project help\`.` });
      }

      // --- /board <project> ---
      if (message.trim().toLowerCase().startsWith("/board")) {
        const projectName = message.trim().replace(/^\/board\s*/i, "").trim();
        if (!projectName) {
          const projects = await listProjects(chatId);
          const list = projects.length ? projects.map((p: any) => `• ${p.name}`).join("\n") : "No projects yet.";
          return Response.json({ text: `**Board Meeting**\n\n${list}\n\nUsage: \`/board <project name>\`` });
        }
        const project = await getProject(chatId, projectName);
        if (!project) {
          return Response.json({ text: `Project "${projectName}" not found. Create it first: \`/project new ${projectName}\`` });
        }
        const projectContext = formatProjectContext(project);
        const [userProfile, memoryCtx] = await Promise.all([getUserProfile(), getMemoryContext()]);
        const session = await createBoardSession(chatId, project);
        if (!session) return Response.json({ text: "Failed to create board session." });

        // Collect all replies into a single response
        const replies: string[] = [];
        const webCtx = { reply: async (text: string) => { replies.push(typeof text === "string" ? text : (text as any).text || ""); } };

        const buildBoardPrompt = (agentLabel: string, agentQuestion: string, projCtx: string, focus?: string) => {
          const sections = [`You are the ${agentLabel} advisor in a board meeting. Be concise and decisive.`, projCtx];
          if (userProfile) sections.push(`## USER PROFILE\n${userProfile}`);
          if (memoryCtx) sections.push(`## MEMORY CONTEXT\n${memoryCtx}`);
          if (focus) sections.push(`## FOCUS\n${focus}`);
          sections.push(`## YOUR QUESTION\n${agentQuestion}\n\nAnswer in 2-4 sentences. No preamble.`);
          return sections.join("\n\n---\n\n");
        };
        const callSub = async (prompt: string) => {
          const r = await callClaude({ prompt, cwd: PROJECT_ROOT, timeoutMs: 300_000, maxTurns: "3" });
          return r.text || "";
        };

        await runBoardMeeting({ chatId, sessionId: session.id, project, projectContext, ctx: webCtx as any }, buildBoardPrompt, callSub);

        const combined = replies.join("\n\n---\n\n");
        await saveMessage({ chat_id: chatId, role: "assistant", content: combined, metadata: { agent, source: "web", type: "board_meeting" } });
        return Response.json({ text: combined });
      }

      // Run Claude and return JSON response
      try {
        const prompt = await buildPrompt(userContent, agent);
        const agentConfig = getAgentConfig(agent);

        const result = await callClaudeStreaming({
          prompt,
          cwd: PROJECT_ROOT,
          timeoutMs: 1_800_000,
          ...(agentConfig?.allowedTools ? { allowedTools: agentConfig.allowedTools } : {}),
        });

        const rawText = result.text || "_(no response)_";

        // Check for cross-agent invocation tag
        const invocation = parseInvokeTag(rawText);
        const responseText = invocation ? stripInvokeTag(rawText) : rawText;

        await processIntents(responseText, chatId);

        await saveMessage({
          chat_id: chatId,
          role: "assistant",
          content: responseText,
          metadata: { agent, source: "web" },
        });

        // Mirror assistant response to Telegram
        if (botToken && telegramChatId && responseText !== "_(no response)_") {
          const agentLabel = agent === "general" ? "" : ` [${agent.toUpperCase()}]`;
          sendTelegramMessage(botToken, telegramChatId, `🤖${agentLabel} ${responseText}`).catch(() => {});
        }

        // Handle cross-agent invocation
        if (invocation) {
          const targetChatId = webChatId(invocation.agent);

          // Save the delegation note to target agent's history
          await saveMessage({
            chat_id: targetChatId,
            role: "user",
            content: `[From ${agent}] ${invocation.task}`,
            metadata: { agent: invocation.agent, source: "web", invokedBy: agent },
          });

          const crossPrompt = await runCrossAgent(
            agent, invocation.agent, message, responseText, invocation.task
          );
          const crossConfig = getAgentConfig(invocation.agent);
          const crossResult = await callClaudeStreaming({
            prompt: crossPrompt,
            cwd: PROJECT_ROOT,
            timeoutMs: 1_800_000,
            ...(crossConfig?.allowedTools ? { allowedTools: crossConfig.allowedTools } : {}),
          });

          const crossText = crossResult.text || "_(no response)_";

          await processIntents(crossText, targetChatId);

          await saveMessage({
            chat_id: targetChatId,
            role: "assistant",
            content: crossText,
            metadata: { agent: invocation.agent, source: "web", invokedBy: agent },
          });

          return Response.json({
            text: responseText,
            invoked: { agent: invocation.agent, task: invocation.task, text: crossText },
          });
        }

        return Response.json({ text: responseText });
      } catch (err: any) {
        return Response.json({ error: err?.message || "Unknown error" }, { status: 500 });
      }
    }

    // --- POST /api/upload → save file to /uploads ---
    if (req.method === "POST" && url.pathname === "/api/upload") {
      try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        if (!file) return Response.json({ error: "no file" }, { status: 400 });

        const uploadsDir = join(PROJECT_ROOT, "uploads");
        await mkdir(uploadsDir, { recursive: true });

        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `${Date.now()}-${safeName}`;
        const filepath = join(uploadsDir, filename);

        const buffer = Buffer.from(await file.arrayBuffer());
        await writeFile(filepath, buffer);

        return Response.json({ filename, url: `/uploads/${filename}`, size: file.size, type: file.type });
      } catch (err: any) {
        return Response.json({ error: err?.message }, { status: 500 });
      }
    }

    // --- GET /uploads/:file → serve uploaded files ---
    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
      const filename = url.pathname.slice(9).replace(/\.\./g, ""); // prevent path traversal
      try {
        const filepath = join(PROJECT_ROOT, "uploads", filename);
        const file = Bun.file(filepath);
        if (!await file.exists()) return new Response("Not found", { status: 404 });
        return new Response(file);
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n⚡ GoBot Web — http://localhost:${PORT}\n`);

// ---------------------------------------------------------------------------
// Embedded UI
// ---------------------------------------------------------------------------

function buildHTML() {
  const convexUrl = process.env.CONVEX_URL || "";
  const chatId = WEB_CHAT_ID;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GoBot — Local</title>
<script src="/convex-browser.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0d0d0d;
    --sidebar-bg: #111111;
    --sidebar-active: #1e1e2e;
    --sidebar-hover: #181828;
    --border: #222;
    --text: #e8e8e8;
    --muted: #666;
    --accent: #7c6af7;
    --user-bubble: #1e1e2e;
    --bot-bubble: #151515;
    --input-bg: #1a1a1a;
    --input-border: #333;
    --tool-color: #4a9eff;
    --thinking-color: #888;
  }

  html, body { height: 100%; width: 100%; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }

  .app { display: flex; height: 100vh; width: 100vw; overflow: hidden; }

  /* ---- Sidebar ---- */
  .sidebar {
    width: 220px; min-width: 220px; background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column; overflow: hidden;
  }

  .sidebar-header {
    padding: 20px 16px 14px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 10px;
  }

  .sidebar-header .logo { font-size: 22px; }
  .sidebar-header .brand { font-size: 15px; font-weight: 600; }
  .sidebar-header .brand-sub { font-size: 11px; color: var(--muted); margin-top: 1px; }

  .agent-list { flex: 1; overflow-y: auto; padding: 8px 0; }

  .agent-item {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; cursor: pointer;
    border-left: 3px solid transparent;
    transition: background 0.12s;
  }

  .agent-item:hover { background: var(--sidebar-hover); }
  .agent-item.active {
    background: var(--sidebar-active);
    border-left-color: var(--accent);
  }

  .agent-icon { font-size: 18px; width: 24px; text-align: center; flex-shrink: 0; }
  .agent-info { overflow: hidden; }
  .agent-name { font-size: 14px; font-weight: 500; }
  .agent-sub { font-size: 11px; color: var(--muted); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* ---- Main ---- */
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

  .chat-header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px;
  }

  .chat-header .icon { font-size: 22px; }
  .chat-header .agent-name { font-size: 16px; font-weight: 600; }
  .chat-header .agent-sub { font-size: 12px; color: var(--muted); }

  /* ---- Messages ---- */
  .messages {
    flex: 1; overflow-y: auto; padding: 24px;
    display: flex; flex-direction: column; gap: 16px;
  }

  .messages::-webkit-scrollbar { width: 6px; }
  .messages::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }

  .empty-state {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 12px; color: var(--muted);
  }

  .empty-state .big-icon { font-size: 48px; }
  .empty-state h2 { font-size: 20px; font-weight: 600; color: var(--text); }
  .empty-state p { font-size: 14px; text-align: center; max-width: 280px; }

  .message { display: flex; flex-direction: column; max-width: min(80%, calc(100% - 32px)); min-width: 0; }
  .message.user { align-self: flex-end; align-items: flex-end; }
  .message.assistant { align-self: flex-start; align-items: flex-start; }

  .bubble {
    padding: 12px 16px; border-radius: 14px;
    font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; min-width: 0;
  }

  .message.user .bubble {
    background: var(--user-bubble);
    border-bottom-right-radius: 4px;
    color: var(--text);
  }

  .message.assistant .bubble {
    background: var(--bot-bubble);
    border: 1px solid var(--border);
    border-bottom-left-radius: 4px;
  }

  .msg-time { font-size: 11px; color: var(--muted); margin-top: 4px; }

  /* ---- Status / tool use indicators ---- */
  .status-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 0; font-size: 13px; color: var(--thinking-color);
  }

  .spinner {
    width: 14px; height: 14px; border: 2px solid #333;
    border-top-color: var(--accent);
    border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .tool-pill {
    display: inline-flex; align-items: center; gap: 6px;
    background: #0d1a2d; border: 1px solid #1a3a5c;
    color: var(--tool-color); border-radius: 12px;
    padding: 3px 10px; font-size: 12px; margin: 2px;
  }

  /* ---- Input area ---- */
  .input-area {
    padding: 16px 24px;
    border-top: 1px solid var(--border);
    display: flex; gap: 12px; align-items: flex-end;
  }

  .input-wrap { flex: 1; position: relative; }

  textarea {
    width: 100%; background: var(--input-bg);
    border: 1px solid var(--input-border); border-radius: 12px;
    color: var(--text); font-size: 14px; font-family: inherit;
    padding: 12px 16px; resize: none; outline: none;
    max-height: 160px; overflow-y: auto; line-height: 1.5;
    transition: border-color 0.15s;
  }

  textarea:focus { border-color: var(--accent); }
  textarea::placeholder { color: var(--muted); }

  .send-btn {
    width: 42px; height: 42px; border-radius: 10px;
    background: var(--accent); border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: opacity 0.15s;
    color: white; font-size: 18px;
  }

  .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .send-btn:hover:not(:disabled) { opacity: 0.85; }

  .attach-btn {
    width: 42px; height: 42px; border-radius: 10px;
    background: var(--input-bg); border: 1px solid var(--input-border);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; cursor: pointer; font-size: 18px;
    transition: background 0.15s;
  }
  .attach-btn:hover { background: #222; }

  /* ---- Code blocks ---- */
  pre { background: #111; border: 1px solid #222; border-radius: 8px; padding: 12px; overflow-x: auto; margin: 8px 0; }

  .cross-agent-pill {
    display: inline-flex; align-items: center; gap: 8px;
    margin-top: 10px; padding: 8px 14px;
    background: #0f1f0f; border: 1px solid #1a3a1a;
    border-radius: 10px; font-size: 12px; color: #6ee86e;
    cursor: pointer; transition: background 0.15s;
  }
  .cross-agent-pill:hover { background: #162716; }
  .cross-agent-pill .pill-icon { font-size: 14px; }
  .cross-agent-pill .pill-label { font-weight: 500; }
  .cross-agent-pill .pill-arrow { opacity: 0.6; }
  code { font-family: "SF Mono", "Fira Code", monospace; font-size: 13px; }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="logo">⚡</div>
      <div>
        <div class="brand">GoBot</div>
        <div class="brand-sub">Local interface</div>
      </div>
    </div>
    <div class="agent-list" id="agentList"></div>
  </aside>

  <main class="main">
    <div class="chat-header" id="chatHeader">
      <div class="icon" id="headerIcon">⚡</div>
      <div>
        <div class="agent-name" id="headerName">General</div>
        <div class="agent-sub" id="headerSub">Default orchestrator</div>
      </div>
    </div>

    <div class="messages" id="messages">
      <div class="empty-state" id="emptyState">
        <div class="big-icon">⚡</div>
        <h2>GoBot — Local</h2>
        <p>Same agents as Telegram. Pick one on the left or just start typing.</p>
      </div>
    </div>

    <div class="input-area">
      <div class="input-wrap">
        <textarea id="input" rows="1" placeholder="Message General..." disabled></textarea>
      </div>
      <label class="attach-btn" id="attachBtn" title="Attach file">
        <input type="file" id="fileInput" style="display:none" accept="image/*,.pdf,.doc,.docx,.txt">
        📎
      </label>
      <button class="send-btn" id="sendBtn" disabled>➤</button>
    </div>
    <div id="attachPreview" style="display:none; padding: 0 24px 8px; font-size:12px; color:#888;"></div>
  </main>
</div>

<script>
  let agents = [];
  let activeAgent = null;
  let sending = false;

  const agentList   = document.getElementById('agentList');
  const messages    = document.getElementById('messages');
  const emptyState  = document.getElementById('emptyState');
  const input       = document.getElementById('input');
  const sendBtn     = document.getElementById('sendBtn');
  const headerIcon  = document.getElementById('headerIcon');
  const headerName  = document.getElementById('headerName');
  const headerSub   = document.getElementById('headerSub');

  // ---- Init ----
  async function init() {
    const res = await fetch('/api/agents');
    agents = await res.json();

    agentList.innerHTML = '';
    for (const a of agents) {
      const el = document.createElement('div');
      el.className = 'agent-item';
      el.dataset.id = a.id;
      el.innerHTML = \`
        <div class="agent-icon">\${a.icon}</div>
        <div class="agent-info">
          <div class="agent-name">\${a.name}</div>
          <div class="agent-sub">\${a.subtitle}</div>
        </div>\`;
      el.addEventListener('click', () => selectAgent(a));
      agentList.appendChild(el);
    }

    // Default to general
    selectAgent(agents[0]);
  }

  // ---- Select agent ----
  async function selectAgent(agent) {
    activeAgent = agent;

    document.querySelectorAll('.agent-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === agent.id);
    });

    headerIcon.textContent = agent.icon;
    headerName.textContent = agent.name;
    headerSub.textContent  = agent.subtitle;
    input.placeholder      = \`Message \${agent.name}...\`;
    input.disabled         = false;
    sendBtn.disabled       = sending;

    startConvexSubscription(agent.id);
  }

  // ---- Load history ----
  async function loadHistory(agentId) {
    messages.innerHTML = '';
    const res  = await fetch(\`/api/messages?agent=\${agentId}\`);
    const msgs = await res.json();

    if (msgs.length === 0) {
      messages.appendChild(emptyState);
      emptyState.style.display = '';
      return;
    }

    emptyState.style.display = 'none';
    for (const m of msgs) appendMessage(m.role, m.content, m.ts);
    scrollBottom();
  }

  // ---- Append message ----
  function appendMessage(role, content, ts) {
    emptyState.style.display = 'none';

    const wrap = document.createElement('div');
    wrap.className = \`message \${role}\`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = content;

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    wrap.appendChild(bubble);
    wrap.appendChild(time);
    messages.appendChild(wrap);
    return bubble;
  }

  // ---- Status row (tool use + thinking) ----
  function addStatusRow() {
    const row = document.createElement('div');
    row.className = 'status-row';
    row.id = 'statusRow';
    row.innerHTML = '<div class="spinner"></div><span id="statusText">Thinking...</span>';
    messages.appendChild(row);
    scrollBottom();
    return row;
  }

  function updateStatus(text) {
    const el = document.getElementById('statusText');
    if (el) el.textContent = text;
  }

  function removeStatus() {
    const row = document.getElementById('statusRow');
    if (row) row.remove();
  }

  // ---- Send ----
  async function send() {
    if (sending || !activeAgent) return;
    const text = input.value.trim();
    if (!text) return;

    sending = true;
    const fileData = await uploadPendingFile();
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;

    const displayText = fileData ? text + ' [file: ' + fileData.filename + ']' : text;
    appendMessage('user', displayText, new Date().toISOString());
    const statusRow = addStatusRow();
    scrollBottom();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, agent: activeAgent.id, fileUrl: fileData ? fileData.url : null, fileName: fileData ? fileData.filename : null }),
      });

      const data = await res.json();
      removeStatus();

      if (data.error) {
        appendMessage('assistant', '⚠️ Error: ' + data.error, new Date().toISOString());
      } else {
        const wrap = appendMessage('assistant', data.text, new Date().toISOString());
        if (data.invoked) {
          const pill = document.createElement('div');
          pill.className = 'cross-agent-pill';
          const meta = agents.find(a => a.id === data.invoked.agent);
          const icon = meta ? meta.icon : '🤖';
          const name = meta ? meta.name : data.invoked.agent;
          pill.innerHTML = '<span class="pill-icon">' + icon + '</span><span class="pill-label">' + name + ' also responded</span><span class="pill-arrow">→ ' + name + ' tab</span>';
          pill.addEventListener('click', () => selectAgent(meta || { id: data.invoked.agent, name: name, icon: icon, subtitle: '' }));
          // Append pill after the bubble inside the wrap
          wrap.parentElement.appendChild(pill);
        }
      }
      scrollBottom();
    } catch (err) {
      removeStatus();
      appendMessage('assistant', '⚠️ ' + (err?.message || 'fetch failed') + ' — is bun run web still running?', new Date().toISOString());
    }

    sending = false;
    sendBtn.disabled = false;
    input.focus();
  }

  // ---- Helpers ----
  function scrollBottom() {
    requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
  }

  // ---- Auto-resize textarea ----
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  // ---- Send on Enter (Shift+Enter = newline) ----
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sending) send();
    }
  });

  sendBtn.addEventListener('click', send);

  // ---- File upload ----
  let pendingFile = null;
  const fileInput  = document.getElementById('fileInput');
  const attachPrev = document.getElementById('attachPreview');

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    pendingFile = f;
    attachPrev.style.display = '';
    attachPrev.textContent = '📎 ' + f.name + ' (' + (f.size / 1024).toFixed(1) + ' KB) — will send with next message';
  });

  async function uploadPendingFile() {
    if (!pendingFile) return null;
    const fd = new FormData();
    fd.append('file', pendingFile);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    pendingFile = null;
    attachPrev.style.display = 'none';
    fileInput.value = '';
    return data.error ? null : data;
  }

  // ---- Convex real-time subscription ----
  const CONVEX_URL = ${JSON.stringify(convexUrl)};
  const CHAT_ID = ${JSON.stringify(chatId)};

  let convexClient = null;
  let activeSubscription = null;

  // Build a Convex function reference from a "module:fn" string
  function convexRef(name) {
    const ref = {};
    ref[Symbol.for("functionName")] = name;
    return ref;
  }

  function renderMessages(result) {
    if (!result || !Array.isArray(result)) return;
    // Don't wipe screen while a send is in progress — it would remove the status row
    if (sending) return;
    messages.innerHTML = '';
    if (result.length === 0) {
      messages.appendChild(emptyState);
      emptyState.style.display = '';
      return;
    }
    emptyState.style.display = 'none';
    for (const m of result) {
      appendMessage(m.role, m.content, new Date(m._creationTime).toISOString());
    }
    scrollBottom();
  }

  function startConvexSubscription(agentId) {
    // Always fetch immediately for fast initial render
    loadHistory(agentId);

    if (!CONVEX_URL || typeof convex === 'undefined') return;
    if (!convexClient) {
      convexClient = new convex.ConvexClient(CONVEX_URL);
    }
    if (activeSubscription) {
      activeSubscription();
      activeSubscription = null;
    }
    try {
      activeSubscription = convexClient.onUpdate(
        convexRef("messages:getByAgent"),
        { chat_id: CHAT_ID, agent: agentId, limit: 50 },
        renderMessages
      );
    } catch(e) {
      console.warn("Convex subscription failed, using HTTP fallback:", e);
    }
  }

  init();
</script>
</body>
</html>`;
}
const HTML = buildHTML();
