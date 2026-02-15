/**
 * Observatory — System Monitoring Dashboard
 *
 * A local web dashboard showing bot status, goals, memory, and live feed.
 * Reads from Supabase and the bot's health endpoint.
 *
 * Run: bun run observatory
 * Open: http://localhost:3001
 */

import { readFile } from "fs/promises";
import { join } from "path";

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const PORT = parseInt(process.env.OBSERVATORY_PORT || "3001");
const HEALTH_URL = `http://localhost:${process.env.HEALTH_PORT || "3000"}/health`;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";
const startedAt = Date.now();

// Load .env
try {
  const envContent = await readFile(join(PROJECT_ROOT, ".env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
} catch {}

const SB_URL = process.env.SUPABASE_URL || SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_KEY;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Observatory</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    background: #0a0a0f;
    color: #e0e0e8;
    min-height: 100vh;
  }
  .header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 20px 30px; border-bottom: 1px solid #1a1a2e;
  }
  .header h1 {
    font-size: 22px; font-weight: 700; color: #fff;
    display: flex; align-items: center; gap: 10px;
  }
  .header h1 .dot { color: #ef4444; font-size: 28px; }
  .header .subtitle { font-size: 11px; color: #666; letter-spacing: 2px; text-transform: uppercase; }
  .header-right { display: flex; align-items: center; gap: 15px; }
  .clock { font-size: 14px; color: #888; }
  .refresh-btn {
    background: #1a1a2e; border: 1px solid #2a2a3e; color: #888;
    padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px;
    font-family: inherit;
  }
  .refresh-btn:hover { background: #2a2a3e; color: #fff; }

  .container { display: grid; grid-template-columns: 1fr 300px; gap: 0; min-height: calc(100vh - 70px); }
  .main { padding: 20px 30px; overflow-y: auto; }
  .sidebar { border-left: 1px solid #1a1a2e; padding: 20px; overflow-y: auto; }

  .status-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .status-card {
    background: #0f0f1a; border: 1px solid #1a1a2e; border-radius: 8px; padding: 16px;
  }
  .status-card .label { font-size: 10px; color: #666; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px; }
  .status-card .value { font-size: 16px; font-weight: 600; }
  .status-card .value.online { color: #22c55e; }
  .status-card .value.offline { color: #ef4444; }
  .status-card .value.connected { color: #22c55e; }

  .section {
    background: #0f0f1a; border: 1px solid #1a1a2e; border-radius: 8px;
    margin-bottom: 20px; overflow: hidden;
  }
  .section-header {
    padding: 14px 18px; border-bottom: 1px solid #1a1a2e;
    display: flex; justify-content: space-between; align-items: center;
  }
  .section-header h2 { font-size: 13px; color: #888; letter-spacing: 1px; text-transform: uppercase; }
  .section-header .badge {
    background: #1a1a2e; color: #888; padding: 2px 8px; border-radius: 10px; font-size: 11px;
  }
  .section-header .live-badge {
    background: #1a1a2e; color: #22c55e; padding: 2px 10px; border-radius: 10px; font-size: 11px;
    display: flex; align-items: center; gap: 5px;
  }
  .live-dot { width: 6px; height: 6px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

  .goal-item {
    padding: 12px 18px; border-bottom: 1px solid #111122;
    display: flex; justify-content: space-between; align-items: center;
  }
  .goal-item:last-child { border-bottom: none; }
  .goal-title { font-size: 13px; color: #e0e0e8; }
  .goal-deadline { font-size: 11px; color: #666; margin-top: 3px; }
  .goal-deadline.overdue { color: #ef4444; }
  .goal-badge {
    font-size: 10px; padding: 3px 10px; border-radius: 4px; letter-spacing: 0.5px;
    background: #1a2e1a; color: #22c55e; border: 1px solid #2a3e2a;
  }

  .feed-item {
    padding: 10px 18px; border-bottom: 1px solid #111122; font-size: 12px;
    display: flex; gap: 10px; align-items: flex-start;
  }
  .feed-item:last-child { border-bottom: none; }
  .feed-time { color: #555; white-space: nowrap; font-size: 11px; }
  .feed-badge {
    font-size: 9px; padding: 2px 6px; border-radius: 3px; white-space: nowrap;
    font-weight: 600;
  }
  .feed-badge.bash { background: #2a1a2e; color: #a78bfa; }
  .feed-badge.web { background: #1a2a2e; color: #67e8f9; }
  .feed-badge.read { background: #1a2e1a; color: #86efac; }
  .feed-badge.write { background: #2e2a1a; color: #fcd34d; }
  .feed-badge.info { background: #1a1a2e; color: #818cf8; }
  .feed-badge.user { background: #2e1a1a; color: #fca5a5; }
  .feed-content { color: #999; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .feed-type {
    font-size: 9px; padding: 2px 6px; border-radius: 3px; white-space: nowrap;
    background: #1a1a2e; color: #666;
  }

  .sidebar-section { margin-bottom: 24px; }
  .sidebar-section h3 {
    font-size: 11px; color: #666; letter-spacing: 1.5px; text-transform: uppercase;
    margin-bottom: 12px; display: flex; align-items: center; gap: 6px;
  }
  .stat-number { font-size: 42px; font-weight: 700; color: #fff; text-align: center; margin: 10px 0; }
  .stat-label { font-size: 11px; color: #666; text-align: center; letter-spacing: 1px; text-transform: uppercase; }

  .tool-list { list-style: none; }
  .tool-item {
    display: flex; justify-content: space-between; padding: 6px 0;
    font-size: 12px; border-bottom: 1px solid #111122;
  }
  .tool-name { color: #999; }
  .tool-count { color: #fff; font-weight: 600; }

  .empty-state { padding: 30px; text-align: center; color: #444; font-size: 12px; }

  @media (max-width: 900px) {
    .container { grid-template-columns: 1fr; }
    .sidebar { border-left: none; border-top: 1px solid #1a1a2e; }
    .status-grid { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1><span class="dot">&#9673;</span> Observatory</h1>
    <div class="subtitle">Personal AI Infrastructure</div>
  </div>
  <div class="header-right">
    <span class="clock" id="clock"></span>
    <button class="refresh-btn" onclick="refreshAll()">&#8635; Refresh</button>
  </div>
</div>

<div class="container">
  <div class="main">
    <div class="status-grid">
      <div class="status-card">
        <div class="label">Telegram Bot</div>
        <div class="value" id="bot-status">Checking...</div>
      </div>
      <div class="status-card">
        <div class="label">Supabase</div>
        <div class="value" id="sb-status">Checking...</div>
      </div>
      <div class="status-card">
        <div class="label">Uptime</div>
        <div class="value" id="uptime">--</div>
      </div>
      <div class="status-card">
        <div class="label">Today's Messages</div>
        <div class="value" id="today-msgs">--</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <h2>&#9678; Active Goals</h2>
        <span class="badge" id="goal-count">0</span>
      </div>
      <div id="goals-list"><div class="empty-state">Loading...</div></div>
    </div>

    <div class="section">
      <div class="section-header">
        <h2>&#9673; Live Feed</h2>
        <span class="live-badge"><span class="live-dot"></span> Live</span>
      </div>
      <div id="feed-list" style="max-height: 400px; overflow-y: auto;">
        <div class="empty-state">Waiting for activity...</div>
      </div>
    </div>
  </div>

  <div class="sidebar">
    <div class="sidebar-section">
      <h3>&#9681; Memory</h3>
      <div class="stat-number" id="facts-count">--</div>
      <div class="stat-label">Facts</div>
    </div>

    <div class="sidebar-section">
      <h3>&#9883; Goals</h3>
      <div class="stat-number" id="goals-count-sidebar">--</div>
      <div class="stat-label">Active</div>
    </div>

    <div class="sidebar-section">
      <h3>&#9881; Top Tools (24H)</h3>
      <ul class="tool-list" id="top-tools">
        <li class="empty-state">No tool usage in 24h</li>
      </ul>
    </div>

    <div class="sidebar-section">
      <h3>&#9734; Recent Activity</h3>
      <ul class="tool-list" id="recent-activity">
        <li class="empty-state">No recent activity</li>
      </ul>
    </div>
  </div>
</div>

<script>
const SB_URL = "${SB_URL}";
const SB_KEY = "${SB_KEY}";
const HEALTH = "/api/health";
const TZ = "${process.env.USER_TIMEZONE || "UTC"}";
let botStartedAt = null;

function fmt(d) {
  return new Date(d).toLocaleTimeString("en-US", { timeZone: TZ, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function updateClock() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour12: false });
  setTimeout(updateClock, 1000);
}
updateClock();

async function sbQuery(table, params = "") {
  const res = await fetch(SB_URL + "/rest/v1/" + table + "?" + params, {
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY }
  });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

async function checkHealth() {
  try {
    const res = await fetch(HEALTH);
    if (res.ok) {
      const data = await res.json();
      document.getElementById("bot-status").textContent = "Online";
      document.getElementById("bot-status").className = "value online";
      if (data.uptime) {
        botStartedAt = Date.now() - data.uptime * 1000;
      }
    } else throw new Error();
  } catch {
    document.getElementById("bot-status").textContent = "Offline";
    document.getElementById("bot-status").className = "value offline";
  }
}

function updateUptime() {
  if (!botStartedAt) return;
  const diff = Date.now() - botStartedAt;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  document.getElementById("uptime").textContent = h + "h " + m + "m";
}
setInterval(updateUptime, 10000);

async function checkSupabase() {
  try {
    await sbQuery("memory", "limit=1");
    document.getElementById("sb-status").textContent = "Connected";
    document.getElementById("sb-status").className = "value connected";
  } catch {
    document.getElementById("sb-status").textContent = "Disconnected";
    document.getElementById("sb-status").className = "value offline";
  }
}

async function loadGoals() {
  try {
    const goals = await sbQuery("memory", "type=eq.goal&order=created_at.desc&limit=10");
    const container = document.getElementById("goals-list");
    document.getElementById("goal-count").textContent = goals.length;
    document.getElementById("goals-count-sidebar").textContent = goals.length;
    if (goals.length === 0) {
      container.innerHTML = '<div class="empty-state">No active goals</div>';
      return;
    }
    container.innerHTML = goals.map(g => {
      const deadline = g.deadline ? new Date(g.deadline) : null;
      const isOverdue = deadline && deadline < new Date();
      const deadlineStr = deadline
        ? (isOverdue ? "Overdue by " + Math.ceil((Date.now() - deadline) / 86400000) + " days" : deadline.toLocaleDateString())
        : "No deadline";
      return '<div class="goal-item"><div><div class="goal-title">' + escHtml(g.content) +
        '</div><div class="goal-deadline ' + (isOverdue ? "overdue" : "") + '">' + deadlineStr +
        '</div></div><span class="goal-badge">ACTIVE</span></div>';
    }).join("");
  } catch (e) {
    document.getElementById("goals-list").innerHTML = '<div class="empty-state">Error loading goals</div>';
  }
}

async function loadFacts() {
  try {
    const facts = await sbQuery("memory", "type=eq.fact&select=id&limit=1000");
    document.getElementById("facts-count").textContent = facts.length;
  } catch {
    document.getElementById("facts-count").textContent = "?";
  }
}

async function loadTodayMessages() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const msgs = await sbQuery("messages", "created_at=gte." + today + "T00:00:00&select=id&limit=1000");
    document.getElementById("today-msgs").textContent = msgs.length;
  } catch {
    document.getElementById("today-msgs").textContent = "?";
  }
}

async function loadFeed() {
  try {
    const logs = await sbQuery("logs", "order=created_at.desc&limit=30");
    const container = document.getElementById("feed-list");
    if (logs.length === 0) {
      container.innerHTML = '<div class="empty-state">No recent activity</div>';
      return;
    }
    container.innerHTML = logs.map(l => {
      const badgeClass = l.event?.includes("bash") ? "bash" :
        l.event?.includes("web") ? "web" :
        l.event?.includes("read") ? "read" :
        l.event?.includes("write") ? "write" :
        l.event?.includes("user") || l.event?.includes("message") ? "user" : "info";
      return '<div class="feed-item"><span class="feed-time">' + fmt(l.created_at) +
        '</span><span class="feed-badge ' + badgeClass + '">' + escHtml(l.event || "log").toUpperCase() +
        '</span><span class="feed-content">' + escHtml(l.message || "") +
        '</span><span class="feed-type">' + escHtml(l.level || "").toUpperCase() + '</span></div>';
    }).join("");
  } catch {
    document.getElementById("feed-list").innerHTML = '<div class="empty-state">Error loading feed</div>';
  }
}

async function loadToolStats() {
  try {
    const since = new Date(Date.now() - 86400000).toISOString();
    const logs = await sbQuery("logs", "created_at=gte." + since + "&select=event&limit=500");
    const counts = {};
    logs.forEach(l => { if (l.event) counts[l.event] = (counts[l.event] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const container = document.getElementById("top-tools");
    if (sorted.length === 0) {
      container.innerHTML = '<li class="empty-state">No tool usage in 24h</li>';
      return;
    }
    container.innerHTML = sorted.map(([name, count]) =>
      '<li class="tool-item"><span class="tool-name">' + escHtml(name) +
      '</span><span class="tool-count">' + count + '</span></li>'
    ).join("");
  } catch {
    document.getElementById("top-tools").innerHTML = '<li class="empty-state">Error loading stats</li>';
  }
}

async function loadRecentActivity() {
  try {
    const msgs = await sbQuery("messages", "order=created_at.desc&limit=5&select=role,content,created_at");
    const container = document.getElementById("recent-activity");
    if (msgs.length === 0) {
      container.innerHTML = '<li class="empty-state">No recent messages</li>';
      return;
    }
    container.innerHTML = msgs.map(m =>
      '<li class="tool-item"><span class="tool-name">' + fmt(m.created_at) + " " +
      m.role + '</span><span class="tool-count" style="color:#888;font-weight:400;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      escHtml(m.content?.substring(0, 50) || "") + '</span></li>'
    ).join("");
  } catch {
    document.getElementById("recent-activity").innerHTML = '<li class="empty-state">Error</li>';
  }
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

async function refreshAll() {
  await Promise.all([
    checkHealth(), checkSupabase(), loadGoals(), loadFacts(),
    loadTodayMessages(), loadFeed(), loadToolStats(), loadRecentActivity()
  ]);
  updateUptime();
}

refreshAll();
// Auto-refresh every 15 seconds
setInterval(refreshAll, 15000);
</script>
</body>
</html>`;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    // Proxy health check to avoid CORS issues
    if (url.pathname === "/api/health") {
      return fetch(HEALTH_URL).catch(() => new Response("{}", { status: 503 }));
    }

    // Serve dashboard
    return new Response(HTML, {
      headers: { "Content-Type": "text/html" },
    });
  },
});

console.log(`Observatory running at http://localhost:${PORT}`);
