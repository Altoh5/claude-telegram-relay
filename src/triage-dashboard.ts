/**
 * Triage Dashboard Server
 *
 * Bun HTTP server on port 3002.
 * Serves a Kanban dashboard for triaged meeting tasks.
 * - GET /          — inline HTML dashboard with Convex real-time updates
 * - GET /api/tasks — all triageTasks as JSON
 * - PATCH /api/tasks/:id/status — update task status
 *
 * Start: bun run src/triage-dashboard.ts
 * Always-on: launchd com.go.triage-dashboard
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadEnv } from "./lib/env";

await loadEnv();

const PORT = parseInt(process.env.TRIAGE_DASHBOARD_PORT ?? "3002", 10);
const CONVEX_URL = process.env.CONVEX_URL ?? "";

function getConvex(): ConvexHttpClient | null {
  if (!CONVEX_URL) return null;
  return new ConvexHttpClient(CONVEX_URL);
}

// ============================================================
// HTML DASHBOARD (single-file, no build step)
// ============================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Task Triage Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  header { background: #1e293b; border-bottom: 1px solid #334155; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 1.25rem; font-weight: 600; color: #f1f5f9; }
  #status { margin-left: auto; font-size: 0.75rem; color: #64748b; }
  #controls { padding: 12px 24px; background: #1e293b; border-bottom: 1px solid #334155; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  #controls label { font-size: 0.8rem; color: #94a3b8; }
  #controls select, #controls input { background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 4px 8px; border-radius: 6px; font-size: 0.8rem; }
  #board { padding: 16px 24px; overflow-x: auto; }
  .project-section { margin-bottom: 24px; }
  .project-header { font-size: 0.85rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #1e293b; }
  .columns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; min-width: 720px; }
  .column { background: #1e293b; border-radius: 10px; padding: 12px; min-height: 80px; }
  .column-header { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; display: flex; justify-content: space-between; }
  .col-backlog .column-header { color: #94a3b8; }
  .col-in_progress .column-header { color: #f59e0b; }
  .col-done .column-header { color: #22c55e; }
  .card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px; margin-bottom: 8px; cursor: pointer; transition: border-color 0.15s; }
  .card:hover { border-color: #475569; }
  .card-desc { font-size: 0.85rem; color: #e2e8f0; line-height: 1.4; margin-bottom: 8px; }
  .card-meta { font-size: 0.72rem; color: #64748b; display: flex; flex-wrap: wrap; gap: 6px; }
  .badge { display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 500; }
  .badge-confidence { background: #1e3a5f; color: #60a5fa; }
  .badge-contact { background: #1a2a1a; color: #4ade80; }
  .badge-date { background: #2a1a2a; color: #c084fc; }
  .suggestion { margin-top: 8px; padding: 8px; background: #1e293b; border-radius: 6px; font-size: 0.78rem; color: #94a3b8; line-height: 1.4; border-left: 2px solid #3b82f6; display: none; }
  .card.expanded .suggestion { display: block; }
  .card-actions { margin-top: 10px; display: none; gap: 6px; }
  .card.expanded .card-actions { display: flex; }
  .btn { padding: 4px 10px; border-radius: 5px; border: none; font-size: 0.72rem; cursor: pointer; font-weight: 500; }
  .btn-backlog { background: #334155; color: #e2e8f0; }
  .btn-in_progress { background: #92400e; color: #fef3c7; }
  .btn-done { background: #14532d; color: #bbf7d0; }
  .btn:hover { opacity: 0.85; }
  .empty-col { text-align: center; color: #475569; font-size: 0.75rem; padding: 20px 0; }
  #loading { text-align: center; padding: 60px; color: #475569; }
</style>
</head>
<body>
<header>
  <h1>📋 Task Triage Dashboard</h1>
  <span id="status">Connecting...</span>
</header>
<div id="controls">
  <label>Project: <select id="filter-project"><option value="">All Projects</option></select></label>
  <label>Min confidence: <input type="range" id="filter-confidence" min="0" max="100" value="0" style="width:100px"> <span id="conf-label">0%</span></label>
  <label>Meeting: <select id="filter-meeting"><option value="">All Meetings</option></select></label>
</div>
<div id="board"><div id="loading">Loading tasks...</div></div>

<script>
// ---- State ----
let allTasks = [];
let filterProject = '';
let filterConfidence = 0;
let filterMeeting = '';

// ---- Fetch tasks from API ----
async function fetchTasks() {
  const res = await fetch('/api/tasks');
  if (!res.ok) throw new Error('Failed to load tasks');
  return res.json();
}

async function updateStatus(id, status) {
  await fetch('/api/tasks/' + encodeURIComponent(id) + '/status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  await reload();
}

async function reload() {
  try {
    allTasks = await fetchTasks();
    document.getElementById('status').textContent = 'Updated ' + new Date().toLocaleTimeString();
    populateFilters();
    render();
  } catch(e) {
    document.getElementById('status').textContent = 'Error: ' + e.message;
  }
}

function populateFilters() {
  const projects = [...new Set(allTasks.map(t => t.project))].sort();
  const meetings = [...new Set(allTasks.map(t => t.source_meeting_title))].sort();
  const projSel = document.getElementById('filter-project');
  const meetSel = document.getElementById('filter-meeting');
  const savedProj = projSel.value;
  const savedMeet = meetSel.value;
  projSel.innerHTML = '<option value="">All Projects</option>' + projects.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
  meetSel.innerHTML = '<option value="">All Meetings</option>' + meetings.map(m => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');
  projSel.value = savedProj;
  meetSel.value = savedMeet;
}

function filteredTasks() {
  return allTasks.filter(t => {
    if (filterProject && t.project !== filterProject) return false;
    if (t.confidence_score < filterConfidence) return false;
    if (filterMeeting && t.source_meeting_title !== filterMeeting) return false;
    return true;
  });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString('en-SG', { month: 'short', day: 'numeric' });
}

function cardHtml(task) {
  const dateStr = formatDate(task.date);
  const id = esc(task._id);
  const status = task.status;
  return '<div class="card" id="card-' + id + '" onclick="toggleCard(\'' + id + '\')">' +
    '<div class="card-desc">' + esc(task.description) + '</div>' +
    '<div class="card-meta">' +
      '<span class="badge badge-confidence">⚡ ' + task.confidence_score + '%</span>' +
      (task.relevant_contact ? '<span class="badge badge-contact">👤 ' + esc(task.relevant_contact) + '</span>' : '') +
      (dateStr ? '<span class="badge badge-date">📅 ' + esc(dateStr) + '</span>' : '') +
      '<span style="color:#475569;font-size:0.7rem">' + esc(task.source_meeting_title.slice(0, 40)) + (task.source_meeting_title.length > 40 ? '…' : '') + '</span>' +
    '</div>' +
    '<div class="suggestion">💡 ' + esc(task.suggestion) + '</div>' +
    '<div class="card-actions">' +
      (status !== 'backlog' ? '<button class="btn btn-backlog" onclick="event.stopPropagation();mv(\'' + id + '\',\'backlog\')">← Backlog</button>' : '') +
      (status !== 'in_progress' ? '<button class="btn btn-in_progress" onclick="event.stopPropagation();mv(\'' + id + '\',\'in_progress\')">▶ In Progress</button>' : '') +
      (status !== 'done' ? '<button class="btn btn-done" onclick="event.stopPropagation();mv(\'' + id + '\',\'done\')">✓ Done</button>' : '') +
    '</div>' +
  '</div>';
}

function toggleCard(id) {
  const el = document.getElementById('card-' + id);
  if (el) el.classList.toggle('expanded');
}

function mv(id, status) {
  updateStatus(id, status);
}

const STATUSES = ['backlog', 'in_progress', 'done'];
const STATUS_LABELS = { backlog: 'Backlog', in_progress: 'In Progress', done: 'Done' };

function render() {
  const tasks = filteredTasks();
  const board = document.getElementById('board');
  if (tasks.length === 0) {
    board.innerHTML = '<div style="text-align:center;padding:60px;color:#475569">No tasks match filters.</div>';
    return;
  }

  // Group by project
  const byProject = {};
  for (const t of tasks) {
    if (!byProject[t.project]) byProject[t.project] = [];
    byProject[t.project].push(t);
  }

  let html = '';
  for (const [project, ptasks] of Object.entries(byProject)) {
    html += '<div class="project-section">';
    html += '<div class="project-header">' + esc(project) + ' <span style="color:#475569;font-weight:400">(' + ptasks.length + ')</span></div>';
    html += '<div class="columns">';
    for (const st of STATUSES) {
      const col = ptasks.filter(t => t.status === st);
      html += '<div class="column col-' + st + '">';
      html += '<div class="column-header"><span>' + STATUS_LABELS[st] + '</span><span style="color:#475569">' + col.length + '</span></div>';
      if (col.length === 0) html += '<div class="empty-col">Empty</div>';
      for (const t of col) html += cardHtml(t);
      html += '</div>';
    }
    html += '</div></div>';
  }
  board.innerHTML = html;
}

// ---- Filters ----
document.getElementById('filter-project').addEventListener('change', e => { filterProject = e.target.value; render(); });
document.getElementById('filter-meeting').addEventListener('change', e => { filterMeeting = e.target.value; render(); });
document.getElementById('filter-confidence').addEventListener('input', e => {
  filterConfidence = Number(e.target.value);
  document.getElementById('conf-label').textContent = filterConfidence + '%';
  render();
});

// ---- Polling (every 30s for live updates) ----
reload();
setInterval(reload, 30000);
</script>
</body>
</html>`;

// ============================================================
// HTTP SERVER
// ============================================================

const server = Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET / — dashboard HTML
    if (req.method === "GET" && path === "/") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // GET /api/tasks — list all tasks as JSON
    if (req.method === "GET" && path === "/api/tasks") {
      const cx = getConvex();
      if (!cx) {
        return new Response(JSON.stringify({ error: "CONVEX_URL not set" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const tasks = await cx.query(api.triageTasks.listAll, {});
        return new Response(JSON.stringify(tasks), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // PATCH /api/tasks/:id/status — update task status
    const statusMatch = path.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (req.method === "PATCH" && statusMatch) {
      const taskId = decodeURIComponent(statusMatch[1]);
      const cx = getConvex();
      if (!cx) {
        return new Response(JSON.stringify({ error: "CONVEX_URL not set" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const body = (await req.json()) as { status: string };
        const validStatuses = ["backlog", "in_progress", "done"];
        if (!validStatuses.includes(body.status)) {
          return new Response(
            JSON.stringify({ error: "Invalid status" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        await cx.mutation(api.triageTasks.updateStatus, {
          id: taskId as any,
          status: body.status,
        });

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Triage Dashboard running at http://localhost:${PORT}`);
console.log(`Convex URL: ${CONVEX_URL || "(not set)"}`);
