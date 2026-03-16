/**
 * Triage Dashboard Server
 *
 * Bun HTTP server on port 3003.
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

const PORT = parseInt(process.env.TRIAGE_DASHBOARD_PORT ?? "3003", 10);
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
  .card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px; margin-bottom: 8px; cursor: grab; transition: border-color 0.15s, opacity 0.15s; }
  .card:hover { border-color: #475569; }
  .card.dragging { opacity: 0.35; transform: rotate(1deg); cursor: grabbing; }
  .column.drag-over { border: 2px dashed #3b82f6; background: rgba(59,130,246,0.07); }
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
  .card-delete { margin-top: 6px; display: none; }
  .card.expanded .card-delete { display: block; }
  .card-notes-wrap { margin-top: 10px; display: none; }
  .card.expanded .card-notes-wrap { display: block; }
  .card-notes { width: 100%; background: #0a1628; border: 1px solid #334155; border-radius: 6px; color: #cbd5e1; font-size: 0.78rem; padding: 7px 9px; resize: vertical; min-height: 56px; font-family: inherit; line-height: 1.45; }
  .card-notes:focus { outline: none; border-color: #3b82f6; }
  .notes-saved { font-size: 0.68rem; color: #22c55e; margin-top: 3px; display: none; }
  .btn { padding: 4px 10px; border-radius: 5px; border: none; font-size: 0.72rem; cursor: pointer; font-weight: 500; }
  .btn-backlog { background: #334155; color: #e2e8f0; }
  .btn-in_progress { background: #92400e; color: #fef3c7; }
  .btn-done { background: #14532d; color: #bbf7d0; }
  .btn-delete { background: transparent; color: #64748b; border: 1px solid #334155; width: 100%; margin-top: 6px; }
  .btn-delete:hover { color: #ef4444; background: rgba(239,68,68,0.08); border-color: #ef4444; }
  .btn:hover { opacity: 0.85; }
  .empty-col { text-align: center; color: #475569; font-size: 0.75rem; padding: 20px 0; }
  #loading { text-align: center; padding: 60px; color: #475569; }
  #btn-new { background: #3b82f6; color: #fff; border: none; padding: 7px 14px; border-radius: 7px; font-size: 0.8rem; font-weight: 600; cursor: pointer; }
  #btn-new:hover { background: #2563eb; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 100; }
  .modal-overlay.open { display: flex; }
  .modal { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; width: 100%; max-width: 480px; margin: 16px; }
  .modal h2 { font-size: 1rem; font-weight: 600; color: #f1f5f9; margin-bottom: 16px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 0.75rem; color: #94a3b8; margin-bottom: 4px; }
  .field input, .field textarea, .field select { width: 100%; background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 8px 10px; border-radius: 7px; font-size: 0.82rem; font-family: inherit; }
  .field textarea { resize: vertical; min-height: 64px; }
  .field input:focus, .field textarea:focus, .field select:focus { outline: none; border-color: #3b82f6; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
  .btn-cancel { background: #334155; color: #e2e8f0; padding: 7px 16px; border-radius: 7px; border: none; font-size: 0.82rem; cursor: pointer; }
  .btn-submit { background: #3b82f6; color: #fff; padding: 7px 16px; border-radius: 7px; border: none; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
  .btn-submit:hover { background: #2563eb; }
  .contact-popover { position: fixed; background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; min-width: 200px; z-index: 200; box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: none; }
  .contact-popover.open { display: block; }
  .contact-popover h3 { font-size: 0.85rem; font-weight: 600; color: #f1f5f9; margin-bottom: 10px; }
  .contact-row { font-size: 0.78rem; color: #94a3b8; margin-bottom: 5px; display: flex; gap: 6px; }
  .contact-row a { color: #60a5fa; text-decoration: none; }
  .contact-row a:hover { text-decoration: underline; }
  .contact-badge-btn { cursor: pointer; }
  .contact-badge-btn:hover { filter: brightness(1.2); }
  .contact-assign-btn { display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 500; background: #1a2535; color: #475569; border: 1px dashed #334155; cursor: pointer; }
  .contact-assign-btn:hover { color: #94a3b8; border-color: #475569; }
  .contact-picker-results { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
  .contact-option { padding: 9px 11px; border-radius: 8px; border: 1px solid #334155; cursor: pointer; transition: background 0.1s; }
  .contact-option:hover { background: #263244; border-color: #3b82f6; }
  .contact-option-name { font-size: 0.82rem; color: #e2e8f0; font-weight: 500; }
  .contact-option-meta { font-size: 0.72rem; color: #64748b; margin-top: 2px; }
  .contact-popover-edit { margin-top: 10px; padding-top: 8px; border-top: 1px solid #334155; }
  .btn-edit-contact { background: #1e3a5f; color: #60a5fa; border: none; padding: 4px 10px; border-radius: 5px; font-size: 0.72rem; cursor: pointer; font-weight: 500; }
  .btn-edit-contact:hover { background: #2563eb; color: #fff; }
</style>
</head>
<body>
<header>
  <h1>📋 Task Triage Dashboard</h1>
  <button id="btn-new" onclick="openModal()">+ New Task</button>
  <span id="status">Connecting...</span>
</header>

<div class="modal-overlay" id="modal">
  <div class="modal">
    <h2>New Task</h2>
    <div class="field"><label>Description *</label><textarea id="f-desc" placeholder="What needs to be done?"></textarea></div>
    <div class="field"><label>Project *</label><input id="f-project" placeholder="e.g. MSG Grant Pipeline" list="project-list"><datalist id="project-list"></datalist></div>
    <div class="field"><label>Contacts <span style="color:#475569">(comma-separated)</span></label><input id="f-contacts" placeholder="e.g. Stephen, Angela"></div>
    <div class="field"><label>Due date</label><input id="f-date" type="date"></div>
    <div class="field"><label>Confidence <span id="f-conf-label">80%</span></label><input id="f-conf" type="range" min="0" max="100" value="80" oninput="document.getElementById('f-conf-label').textContent=this.value+'%'"></div>
    <div class="field"><label>Suggestion / next step</label><textarea id="f-suggestion" placeholder="What's the recommended action?"></textarea></div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-submit" onclick="submitTask()">Create Task</button>
    </div>
  </div>
</div>
<div class="modal-overlay" id="contact-modal">
  <div class="modal">
    <h2>Assign Contact</h2>
    <div class="field"><label>Search by name</label><input id="contact-search" placeholder="Type a name…" autocomplete="off"></div>
    <div class="contact-picker-results" id="contact-results"></div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeContactModal()">Cancel</button>
      <button class="btn-cancel" onclick="clearContact()" style="color:#ef4444">Clear / None</button>
    </div>
  </div>
</div>

<div id="controls">
  <label>Project: <select id="filter-project"><option value="">All Projects</option></select></label>
  <label>Min confidence: <input type="range" id="filter-confidence" min="0" max="100" value="0" style="width:100px"> <span id="conf-label">0%</span></label>
  <label>Meeting: <select id="filter-meeting"><option value="">All Meetings</option></select></label>
</div>
<div id="board"><div id="loading">Loading tasks...</div></div>
<div class="contact-popover" id="contact-popover"></div>

<script>
// ---- State ----
let allTasks = [];
let filterProject = '';
let filterConfidence = 0;
let filterMeeting = '';

// ---- Fetch tasks from API ----
async function fetchTasks() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('/api/tasks', { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out — browser may be blocking localhost');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
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
    document.getElementById('board').innerHTML = '<div style="text-align:center;padding:60px;color:#ef4444;font-size:0.9rem">⚠️ ' + esc(String(e.message)) + '<br><br><span style="color:#64748b;font-size:0.78rem">Check that the dashboard server is running: bun run src/triage-dashboard.ts</span></div>';
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
  return '<div class="card" data-id="' + id + '" draggable="true">' +
    '<div class="card-desc">' + esc(task.description) + '</div>' +
    '<div class="card-meta">' +
      '<span class="badge badge-confidence">⚡ ' + task.confidence_score + '%</span>' +
      (task.relevant_contact
        ? task.relevant_contact.split(',').map(c => '<span class="badge badge-contact contact-badge-btn" data-contact="' + esc(c.trim()) + '" data-task-id="' + id + '">👤 ' + esc(c.trim()) + '</span>').join('')
        : '<button class="contact-assign-btn" data-task-id="' + id + '" data-contact="">👤 + assign</button>') +
      (dateStr ? '<span class="badge badge-date">📅 ' + esc(dateStr) + '</span>' : '') +
      '<span style="color:#475569;font-size:0.7rem">' + esc(task.source_meeting_title.slice(0, 40)) + (task.source_meeting_title.length > 40 ? '…' : '') + '</span>' +
    '</div>' +
    '<div class="suggestion">💡 ' + esc(task.suggestion) + '</div>' +
    '<div class="card-notes-wrap">' +
      '<textarea class="card-notes" placeholder="Add notes..." data-id="' + id + '">' + esc(task.notes || '') + '</textarea>' +
      '<div class="notes-saved">Saved</div>' +
    '</div>' +
    '<div class="card-actions">' +
      (status !== 'backlog' ? '<button class="btn btn-backlog" data-status="backlog">← Backlog</button>' : '') +
      (status !== 'in_progress' ? '<button class="btn btn-in_progress" data-status="in_progress">▶ In Progress</button>' : '') +
      (status !== 'done' ? '<button class="btn btn-done" data-status="done">✓ Done</button>' : '') +
    '</div>' +
    '<div class="card-delete"><button class="btn btn-delete" data-delete="true" style="width:100%">🗑 Delete task</button></div>' +
  '</div>';
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
      html += '<div class="column col-' + st + '" data-status="' + st + '">';
      html += '<div class="column-header"><span>' + STATUS_LABELS[st] + '</span><span style="color:#475569">' + col.length + '</span></div>';
      if (col.length === 0) html += '<div class="empty-col">Empty</div>';
      for (const t of col) html += cardHtml(t);
      html += '</div>';
    }
    html += '</div></div>';
  }
  board.innerHTML = html;
}

// ---- Notes save-on-blur ----
document.getElementById('board').addEventListener('focusout', async function(e) {
  const ta = e.target.closest('textarea.card-notes');
  if (!ta) return;
  const id = ta.dataset.id;
  await fetch('/api/tasks/' + encodeURIComponent(id) + '/notes', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: ta.value })
  });
  const saved = ta.nextElementSibling;
  if (saved) { saved.style.display = 'block'; setTimeout(() => { saved.style.display = 'none'; }, 1500); }
});
document.getElementById('board').addEventListener('click', function(e) {
  if (e.target.closest('textarea.card-notes')) e.stopPropagation();
});

// ---- Board click delegation (toggle expand + status buttons + delete) ----
document.getElementById('board').addEventListener('click', function(e) {
  const delBtn = e.target.closest('.btn[data-delete]');
  const statusBtn = e.target.closest('.btn[data-status]');
  const card = e.target.closest('.card[data-id]');
  if (!card) return;
  if (delBtn) {
    e.stopPropagation();
    deleteTask(card.dataset.id);
    return;
  }
  if (statusBtn) {
    e.stopPropagation();
    updateStatus(card.dataset.id, statusBtn.dataset.status);
    return;
  }
  card.classList.toggle('expanded');
});

async function deleteTask(id) {
  await fetch('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
  await reload();
}

// ---- Drag and drop ----
let dragId = null;
document.getElementById('board').addEventListener('dragstart', function(e) {
  const card = e.target.closest('.card[data-id]');
  if (!card) return;
  dragId = card.dataset.id;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
document.getElementById('board').addEventListener('dragend', function(e) {
  const card = e.target.closest('.card[data-id]');
  if (card) card.classList.remove('dragging');
  document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
  dragId = null;
});
document.getElementById('board').addEventListener('dragover', function(e) {
  const col = e.target.closest('.column[data-status]');
  if (!col || !dragId) return;
  e.preventDefault();
  document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
  col.classList.add('drag-over');
});
document.getElementById('board').addEventListener('dragleave', function(e) {
  const col = e.target.closest('.column[data-status]');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
});
document.getElementById('board').addEventListener('drop', function(e) {
  const col = e.target.closest('.column[data-status]');
  if (!col || !dragId) return;
  e.preventDefault();
  col.classList.remove('drag-over');
  updateStatus(dragId, col.dataset.status);
  dragId = null;
});

// ---- Filters ----
document.getElementById('filter-project').addEventListener('change', e => { filterProject = e.target.value; render(); });
document.getElementById('filter-meeting').addEventListener('change', e => { filterMeeting = e.target.value; render(); });
document.getElementById('filter-confidence').addEventListener('input', e => {
  filterConfidence = Number(e.target.value);
  document.getElementById('conf-label').textContent = filterConfidence + '%';
  render();
});

// ---- Contact popover (hover) ----
const popover = document.getElementById('contact-popover');
let popoverTimer = null;
let contactCache = {};

function showPopover(badge) {
  const name = badge.dataset.contact;
  const taskId = badge.dataset.taskId || null;
  const rect = badge.getBoundingClientRect();
  popover.innerHTML = '<div style="color:#64748b;font-size:0.75rem">Loading...</div>';
  popover.classList.add('open');
  popover.style.top = (rect.bottom + 6 + window.scrollY) + 'px';
  const left = Math.min(rect.left, window.innerWidth - 240);
  popover.style.left = Math.max(8, left) + 'px';

  if (contactCache[name] !== undefined) {
    renderPopover(name, contactCache[name], taskId);
    return;
  }
  fetch('/api/contacts?name=' + encodeURIComponent(name))
    .then(r => r.json())
    .then(c => { contactCache[name] = c; renderPopover(name, c, taskId); })
    .catch(() => { popover.innerHTML = '<div style="color:#ef4444;font-size:0.78rem">Failed to load</div>'; });
}

function renderPopover(name, c, taskId) {
  const editBtn = taskId
    ? '<div class="contact-popover-edit"><button class="btn-edit-contact" onclick="openContactModal(\\'' + esc(taskId) + '\\', \\'' + esc(name) + '\\')">✏ Edit contact</button></div>'
    : '';
  if (!c || c.error) {
    popover.innerHTML = '<div style="color:#64748b;font-size:0.78rem">No details found for <b style="color:#e2e8f0">' + esc(name) + '</b></div>' + editBtn;
    return;
  }
  popover.innerHTML =
    '<h3>👤 ' + esc(c.name) + '</h3>' +
    (c.organization ? '<div class="contact-row">🏢 ' + esc(c.organization) + '</div>' : '') +
    (c.email ? '<div class="contact-row">✉️ <a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a></div>' : '') +
    (c.phone ? '<div class="contact-row">📞 <a href="tel:' + esc(c.phone) + '">' + esc(c.phone) + '</a></div>' : '') +
    (!c.email && !c.phone && !c.organization ? '<div class="contact-row" style="color:#475569">No details on file</div>' : '') +
    editBtn;
}

document.getElementById('board').addEventListener('mouseover', function(e) {
  const badge = e.target.closest('.contact-badge-btn');
  if (!badge) return;
  clearTimeout(popoverTimer);
  popoverTimer = setTimeout(() => showPopover(badge), 120);
});
document.getElementById('board').addEventListener('mouseout', function(e) {
  const badge = e.target.closest('.contact-badge-btn');
  if (!badge) return;
  // Only hide if not moving to the popover
  clearTimeout(popoverTimer);
  popoverTimer = setTimeout(() => {
    if (!popover.matches(':hover')) popover.classList.remove('open');
  }, 200);
});
popover.addEventListener('mouseleave', function() {
  clearTimeout(popoverTimer);
  popoverTimer = setTimeout(() => popover.classList.remove('open'), 100);
});
document.addEventListener('click', function(e) {
  if (!popover.contains(e.target) && !e.target.closest('.contact-badge-btn')) {
    popover.classList.remove('open');
  }
});

// ---- New task modal ----
function openModal() {
  document.getElementById('modal').classList.add('open');
  // populate project datalist
  const dl = document.getElementById('project-list');
  const projects = [...new Set(allTasks.map(t => t.project))].sort();
  dl.innerHTML = projects.map(p => '<option value="' + esc(p) + '">').join('');
  document.getElementById('f-desc').focus();
}
function closeModal() {
  document.getElementById('modal').classList.remove('open');
  ['f-desc','f-project','f-contacts','f-date','f-suggestion'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('f-conf').value = '80';
  document.getElementById('f-conf-label').textContent = '80%';
}
document.getElementById('modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeModal(); closeContactModal(); }
});
async function submitTask() {
  const desc = document.getElementById('f-desc').value.trim();
  const project = document.getElementById('f-project').value.trim();
  if (!desc || !project) { alert('Description and Project are required.'); return; }
  const dateVal = document.getElementById('f-date').value;
  const body = {
    description: desc,
    project,
    suggestion: document.getElementById('f-suggestion').value.trim() || '—',
    relevant_contact: document.getElementById('f-contacts').value.trim() || null,
    date: dateVal ? new Date(dateVal).getTime() : null,
    confidence_score: Number(document.getElementById('f-conf').value),
    status: 'backlog',
    source_meeting_title: 'Manual',
    meeting_id: 'manual',
  };
  const btn = document.querySelector('.btn-submit');
  btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const res = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    closeModal();
    await reload();
  } catch(e) {
    alert('Error: ' + e.message);
  } finally {
    btn.textContent = 'Create Task'; btn.disabled = false;
  }
}

// ---- Contact picker modal ----
let contactPickerTaskId = null;
let contactSearchTimer = null;

function openContactModal(taskId, currentName) {
  popover.classList.remove('open');
  contactPickerTaskId = taskId;
  document.getElementById('contact-search').value = currentName || '';
  document.getElementById('contact-results').innerHTML = '';
  document.getElementById('contact-modal').classList.add('open');
  document.getElementById('contact-search').focus();
  if (currentName) searchContacts(currentName);
}

function closeContactModal() {
  document.getElementById('contact-modal').classList.remove('open');
  contactPickerTaskId = null;
}

async function searchContacts(q) {
  if (!q.trim()) { document.getElementById('contact-results').innerHTML = ''; return; }
  const res = await fetch('/api/contacts/search?q=' + encodeURIComponent(q));
  const candidates = await res.json();
  const el = document.getElementById('contact-results');
  if (!candidates.length) {
    el.innerHTML = '<div style="color:#475569;font-size:0.78rem;padding:8px 0">No contacts found</div>';
    return;
  }
  el.innerHTML = candidates.map(c =>
    '<div class="contact-option" onclick="pickContact(' + JSON.stringify(JSON.stringify(c)) + ')">' +
      '<div class="contact-option-name">👤 ' + esc(c.name) + '</div>' +
      '<div class="contact-option-meta">' +
        (c.organization ? '🏢 ' + esc(c.organization) + '  ' : '') +
        (c.email ? '✉️ ' + esc(c.email) : '') +
      '</div>' +
    '</div>'
  ).join('');
}

async function pickContact(cJson) {
  const c = JSON.parse(cJson);
  await saveContact(c.name, c.email || null);
}

async function clearContact() {
  await saveContact(null, null);
}

async function saveContact(name, email) {
  if (!contactPickerTaskId) return;
  try {
    await fetch('/api/tasks/' + encodeURIComponent(contactPickerTaskId) + '/contact', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relevant_contact: name, relevant_contact_email: email })
    });
    contactCache = {}; // clear cache so badge re-fetches
    closeContactModal();
    await reload();
  } catch(e) {
    alert('Error saving contact: ' + e.message);
  }
}

document.getElementById('contact-search').addEventListener('input', function() {
  clearTimeout(contactSearchTimer);
  contactSearchTimer = setTimeout(() => searchContacts(this.value), 250);
});
document.getElementById('contact-modal').addEventListener('click', function(e) {
  if (e.target === this) closeContactModal();
});

// Click on "👤 + assign" badge (no contact yet)
document.getElementById('board').addEventListener('click', function(e) {
  const btn = e.target.closest('.contact-assign-btn');
  if (!btn) return;
  e.stopPropagation();
  openContactModal(btn.dataset.taskId, '');
});

// Click on existing contact badge — open edit modal directly
document.getElementById('board').addEventListener('click', function(e) {
  const badge = e.target.closest('.contact-badge-btn');
  if (!badge) return;
  e.stopPropagation();
  popover.classList.remove('open');
  openContactModal(badge.dataset.taskId, badge.dataset.contact || '');
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

    // GET /api/contacts/search?q=... — fuzzy search returning all matches (for picker)
    if (req.method === "GET" && path === "/api/contacts/search") {
      const q = url.searchParams.get("q") ?? "";
      const cx = getConvex();
      if (!cx) return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
      try {
        const contacts = await cx.query(api.contacts.searchAllByName, { name: q });
        return new Response(JSON.stringify(contacts), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
      }
    }

    // GET /api/contacts?name=... — look up a contact by name
    if (req.method === "GET" && path === "/api/contacts") {
      const name = url.searchParams.get("name") ?? "";
      const cx = getConvex();
      if (!cx) return new Response(JSON.stringify({ error: "CONVEX_URL not set" }), { status: 500, headers: { "Content-Type": "application/json" } });
      try {
        const contact = await cx.query(api.contacts.searchByName, { name });
        return new Response(JSON.stringify(contact ?? null), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // POST /api/tasks — create task
    if (req.method === "POST" && path === "/api/tasks") {
      const cx = getConvex();
      if (!cx) return new Response(JSON.stringify({ error: "CONVEX_URL not set" }), { status: 500, headers: { "Content-Type": "application/json" } });
      try {
        const b = (await req.json()) as any;
        const id = await cx.mutation(api.triageTasks.create, {
          description: b.description,
          project: b.project,
          suggestion: b.suggestion,
          relevant_contact: b.relevant_contact ?? undefined,
          date: b.date ?? undefined,
          confidence_score: b.confidence_score,
          status: b.status ?? "backlog",
          source_meeting_title: b.source_meeting_title ?? "Manual",
          meeting_id: b.meeting_id ?? "manual",
          created_at: Date.now(),
        });
        return new Response(JSON.stringify({ ok: true, id }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // PATCH /api/tasks/:id/status — update task status
    const statusMatch = path.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (req.method === "PATCH" && statusMatch) {
      const taskId = decodeURIComponent(statusMatch[1]);

      // Validate Convex ID format before passing to mutation (alphanumeric + special chars)
      if (!/^[a-zA-Z0-9_-]{8,}$/.test(taskId)) {
        return new Response(JSON.stringify({ error: "Invalid task ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

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
          id: taskId as any, // ConvexHttpClient accepts string IDs; validated above
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

    // DELETE /api/tasks/:id — delete task
    const deleteMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      const taskId = decodeURIComponent(deleteMatch[1]);
      if (!/^[a-zA-Z0-9_-]{8,}$/.test(taskId)) {
        return new Response(JSON.stringify({ error: "Invalid task ID" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      const cx = getConvex();
      if (!cx) return new Response(JSON.stringify({ error: "CONVEX_URL not set" }), { status: 500, headers: { "Content-Type": "application/json" } });
      try {
        await cx.mutation(api.triageTasks.deleteTask, { id: taskId as any });
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // PATCH /api/tasks/:id/contact — reassign contact
    const contactMatch = path.match(/^\/api\/tasks\/([^/]+)\/contact$/);
    if (req.method === "PATCH" && contactMatch) {
      const taskId = decodeURIComponent(contactMatch[1]);
      if (!/^[a-zA-Z0-9_-]{8,}$/.test(taskId)) {
        return new Response(JSON.stringify({ error: "Invalid task ID" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const cx = getConvex();
      if (!cx) return new Response(JSON.stringify({ error: "CONVEX_URL not set" }), { status: 500, headers: { "Content-Type": "application/json" } });
      try {
        const body = (await req.json()) as { relevant_contact: string | null; relevant_contact_email: string | null };
        await cx.mutation(api.triageTasks.updateContact, {
          id: taskId as any,
          relevant_contact: body.relevant_contact ?? undefined,
          relevant_contact_email: body.relevant_contact_email ?? undefined,
        });
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // PATCH /api/tasks/:id/notes — save notes
    const notesMatch = path.match(/^\/api\/tasks\/([^/]+)\/notes$/);
    if (req.method === "PATCH" && notesMatch) {
      const taskId = decodeURIComponent(notesMatch[1]);
      if (!/^[a-zA-Z0-9_-]{8,}$/.test(taskId)) {
        return new Response(JSON.stringify({ error: "Invalid task ID" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      const cx = getConvex();
      if (!cx) return new Response(JSON.stringify({ error: "CONVEX_URL not set" }), { status: 500, headers: { "Content-Type": "application/json" } });
      try {
        const body = (await req.json()) as { notes: string };
        await cx.mutation(api.triageTasks.updateNotes, { id: taskId as any, notes: body.notes ?? "" });
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Triage Dashboard running at http://localhost:${PORT}`);
console.log(`Convex URL: ${CONVEX_URL || "(not set)"}`);
