/**
 * Board Meeting Data Injection
 *
 * Gathers live business data from multiple sources and formats it
 * per-agent for informed board meeting discussions.
 *
 * Called once before the agent loop — all sources fetched in parallel.
 * Every source is wrapped in fetchWithTimeout — no source failure blocks the meeting.
 */

import {
  isGoogleAuthAvailable,
  getGoogleAccessToken,
} from "./data-sources/google-auth";

// ============================================================
// Types
// ============================================================

export interface BoardData {
  agentData: Record<string, string>;
  sharedSummary: string;
  fetchDurationMs: number;
  errors: string[];
}

interface SharedData {
  metrics: LatestMetrics | null;
  calendar: CalendarEvent[] | null;
  goals: string[] | null;
  tasks: TaskItem[] | null;
  emails: EmailItem[] | null;
  github: GitHubData | null;
  news: string[] | null;
  contentPipeline: ContentItem[] | null;
  transactions: TransactionItem[] | null;
}

interface LatestMetrics {
  date: string;
  ytSubscribers: number;
  ytSubscribersDelta: string;
  ytTotalViews: number;
  ghStars: number;
  ghStarsDelta: string;
  ghForks: number;
  ghIssues: number;
  websiteVisitors: number;
  websiteVisitorsDelta: string;
  websitePageviews: number;
  skoolMRR: string;
  skoolMRRDelta: string;
  skoolMembers: string;
  skoolMembersDelta: string;
  skoolRetention: string;
  communityRank: string;
  communityRankDelta: string;
  freeMembers: string;
}

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
}

interface TaskItem {
  title: string;
  due: string;
  status: string;
  isOverdue: boolean;
}

interface EmailItem {
  from: string;
  subject: string;
}

interface GitHubData {
  gobot: { openPRs: number; openIssues: number; prTitles: string[] };
  relay: {
    stars: number;
    forks: number;
    openIssues: number;
    openPRs: number;
    prTitles: string[];
  };
}

interface ContentItem {
  title: string;
  status: string;
}

interface TransactionItem {
  title: string;
  amount: string;
  date: string;
}

// ============================================================
// Fetch Utilities
// ============================================================

async function fetchWithTimeout<T>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number = 5000
): Promise<{ data: T | null; error: string | null }> {
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${name} timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
    return { data: result, error: null };
  } catch (err: any) {
    console.warn(`[BoardData] ${name} failed: ${err.message}`);
    return { data: null, error: name };
  }
}

// ============================================================
// Data Fetchers
// ============================================================

async function fetchMetrics(): Promise<LatestMetrics | null> {
  if (!isGoogleAuthAvailable()) return null;

  const token = await getGoogleAccessToken();
  const SHEETS_ID =
    process.env.METRICS_SHEET_ID ||
    "1mdURi5F-sBpwDbv_jCZu-uSOfZxOM0GnPuTLR_p0Czk";
  const TAB_NAME = "Business Metrics";

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${encodeURIComponent(TAB_NAME)}!A:U`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`Sheets API: ${res.status}`);

  const data = await res.json();
  const rows = data.values || [];
  if (rows.length < 2) return null;

  const lastRow = rows[rows.length - 1];
  const prevRow = rows.length > 2 ? rows[rows.length - 2] : null;

  const p = (idx: number) => parseInt(lastRow[idx] || "0");
  const pp = (idx: number) => (prevRow ? parseInt(prevRow[idx] || "0") : 0);

  const formatDelta = (current: number, previous: number): string => {
    if (!previous || !current) return "";
    const diff = current - previous;
    if (diff === 0) return "";
    return `${diff > 0 ? "+" : ""}${diff.toLocaleString()}`;
  };

  const parseMRR = (val: string) =>
    parseFloat((val || "0").replace(/[$,]/g, "")) || 0;
  const currentMRR = parseMRR(lastRow[9]);
  const prevMRR = prevRow ? parseMRR(prevRow[9]) : 0;
  const mrrDiff = prevMRR > 0 ? currentMRR - prevMRR : 0;

  const currentRank = p(14);
  const prevRank = pp(14);
  const rankDiff = currentRank && prevRank ? currentRank - prevRank : 0;

  return {
    date: lastRow[0] || "",
    ytSubscribers: p(1),
    ytSubscribersDelta: formatDelta(p(1), pp(1)),
    ytTotalViews: p(2),
    ghStars: p(4),
    ghStarsDelta: formatDelta(p(4), pp(4)),
    ghForks: p(5),
    ghIssues: p(6),
    websiteVisitors: p(7),
    websiteVisitorsDelta: formatDelta(p(7), pp(7)),
    websitePageviews: p(8),
    skoolMRR: lastRow[9] || "",
    skoolMRRDelta:
      mrrDiff !== 0
        ? `${mrrDiff >= 0 ? "+" : ""}$${mrrDiff.toFixed(2)}`
        : "",
    skoolMembers: lastRow[10] || "",
    skoolMembersDelta: formatDelta(p(10), pp(10)),
    skoolRetention: lastRow[13] || "",
    communityRank: lastRow[14] || "",
    communityRankDelta:
      rankDiff !== 0
        ? rankDiff < 0
          ? `+${Math.abs(rankDiff)}`
          : `-${rankDiff}`
        : "",
    freeMembers: lastRow[18] || "",
  };
}

async function fetchCalendar(): Promise<CalendarEvent[] | null> {
  if (!isGoogleAuthAvailable()) return null;

  const token = await getGoogleAccessToken();
  const endDate = new Date(Date.now() + 3 * 86400000);

  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "20",
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`Calendar API: ${res.status}`);

  const data = await res.json();
  return (data.items || []).map((e: any) => ({
    summary: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    allDay: !!e.start?.date,
  }));
}

async function fetchGoals(): Promise<string[] | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return null;

  const res = await fetch(
    `${supabaseUrl}/rest/v1/memory?type=eq.goal&select=content,metadata&order=created_at.desc&limit=5`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    }
  );

  if (!res.ok) throw new Error(`Supabase goals: ${res.status}`);

  const data = await res.json();
  return data.map((g: any) => {
    const deadline = g.metadata?.deadline
      ? ` (deadline: ${g.metadata.deadline})`
      : "";
    return `${g.content}${deadline}`;
  });
}

async function fetchNotionTasks(): Promise<TaskItem[] | null> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!token || !dbId) return null;

  const today = new Date().toISOString().split("T")[0];

  const res = await fetch(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          or: [
            {
              and: [
                { property: "Due", date: { on_or_before: today } },
                { property: "Status", status: { does_not_equal: "Done" } },
              ],
            },
            {
              property: "Status",
              status: { equals: "In progress" },
            },
          ],
        },
        sorts: [{ property: "Due", direction: "ascending" }],
        page_size: 15,
      }),
    }
  );

  if (!res.ok) throw new Error(`Notion tasks: ${res.status}`);

  const data = await res.json();
  return (data.results || []).map((page: any) => {
    const title = extractNotionTitle(page);
    const due = page.properties?.Due?.date?.start || "";
    const status = page.properties?.Status?.status?.name || "";
    return { title, due, status, isOverdue: !!(due && due < today) };
  });
}

async function fetchEmails(): Promise<EmailItem[] | null> {
  if (!isGoogleAuthAvailable()) return null;

  const token = await getGoogleAccessToken();

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread+in:inbox&maxResults=5",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`Gmail API: ${res.status}`);

  const data = await res.json();
  const messageIds: string[] =
    data.messages?.map((m: any) => m.id).slice(0, 5) || [];

  if (messageIds.length === 0) return [];

  const emails = await Promise.all(
    messageIds.map(async (id) => {
      try {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!msgRes.ok) return null;
        const msg = await msgRes.json();
        const headers = msg.payload?.headers || [];
        const subject =
          headers.find((h: any) => h.name === "Subject")?.value ||
          "(no subject)";
        const from =
          headers.find((h: any) => h.name === "From")?.value || "";
        const fromName = from.replace(/<.*>/, "").trim() || from;
        return { from: fromName, subject };
      } catch {
        return null;
      }
    })
  );

  return emails.filter(Boolean) as EmailItem[];
}

async function fetchGitHub(): Promise<GitHubData | null> {
  const headers: Record<string, string> = { "User-Agent": "GoBot-Board" };
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) headers["Authorization"] = `Bearer ${ghToken}`;

  const [gobotPRs, gobotIssues, relayRepo, relayPRs] = await Promise.all([
    fetch(
      "https://api.github.com/repos/autonomee/gobot/pulls?state=open&per_page=10",
      { headers }
    )
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
    fetch(
      "https://api.github.com/repos/autonomee/gobot/issues?state=open&per_page=10",
      { headers }
    )
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
    fetch("https://api.github.com/repos/godagoo/claude-telegram-relay", {
      headers,
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(
      "https://api.github.com/repos/godagoo/claude-telegram-relay/pulls?state=open&per_page=5",
      { headers }
    )
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
  ]);

  // GitHub API includes PRs in issues endpoint — filter them out
  const gobotIssuesOnly = Array.isArray(gobotIssues)
    ? gobotIssues.filter((i: any) => !i.pull_request)
    : [];

  return {
    gobot: {
      openPRs: Array.isArray(gobotPRs) ? gobotPRs.length : 0,
      openIssues: gobotIssuesOnly.length,
      prTitles: Array.isArray(gobotPRs)
        ? gobotPRs.map((p: any) => p.title).slice(0, 5)
        : [],
    },
    relay: {
      stars: relayRepo?.stargazers_count || 0,
      forks: relayRepo?.forks_count || 0,
      openIssues: relayRepo?.open_issues_count || 0,
      openPRs: Array.isArray(relayPRs) ? relayPRs.length : 0,
      prTitles: Array.isArray(relayPRs)
        ? relayPRs.map((p: any) => p.title).slice(0, 5)
        : [],
    },
  };
}

async function fetchAINews(): Promise<string[] | null> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-3-mini-fast",
      messages: [
        {
          role: "system",
          content:
            "Return 3-5 bullet points about the most important AI news from the last 24 hours. Each bullet: one sentence with source. Format: • [news] (source). No headers.",
        },
        { role: "user", content: "Top AI news today?" },
      ],
      max_tokens: 300,
      temperature: 0,
      search_mode: "on",
    }),
  });

  if (!res.ok) throw new Error(`Grok API: ${res.status}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return null;

  return content
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0);
}

async function fetchContentPipeline(): Promise<ContentItem[] | null> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_CONTENT_PIPELINE_DB;
  if (!token || !dbId) return null;

  const res = await fetch(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          property: "Status",
          status: { does_not_equal: "Published" },
        },
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 10,
      }),
    }
  );

  if (!res.ok) throw new Error(`Notion content pipeline: ${res.status}`);

  const data = await res.json();
  return (data.results || []).map((page: any) => ({
    title: extractNotionTitle(page),
    status: page.properties?.Status?.status?.name || "Unknown",
  }));
}

async function fetchTransactions(): Promise<TransactionItem[] | null> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_TRANSACTIONS_DB;
  if (!token || !dbId) return null;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000)
    .toISOString()
    .split("T")[0];

  const res = await fetch(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          property: "Date",
          date: { on_or_after: thirtyDaysAgo },
        },
        sorts: [{ property: "Date", direction: "descending" }],
        page_size: 10,
      }),
    }
  );

  if (!res.ok) throw new Error(`Notion transactions: ${res.status}`);

  const data = await res.json();
  return (data.results || []).map((page: any) => ({
    title: extractNotionTitle(page),
    amount: extractNotionNumber(page, "Amount") || "",
    date: page.properties?.Date?.date?.start || "",
  }));
}

// ============================================================
// Notion Helpers
// ============================================================

function extractNotionTitle(page: any): string {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && prop.title?.length > 0) {
      return prop.title.map((t: any) => t.plain_text).join("");
    }
  }
  return "(untitled)";
}

function extractNotionNumber(page: any, name: string): string | null {
  const prop = page.properties?.[name];
  if (!prop) return null;
  if (prop.type === "number" && prop.number != null)
    return prop.number.toString();
  if (prop.type === "rich_text")
    return (
      prop.rich_text?.map((t: any) => t.plain_text).join("") || null
    );
  return null;
}

// ============================================================
// Per-Agent Formatters
// ============================================================

function formatResearchData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.news?.length) {
    sections.push("### AI News (Last 24h)");
    sections.push(d.news.join("\n"));
  }

  if (d.metrics) {
    sections.push("\n### Key Metrics Snapshot");
    sections.push(
      `• YouTube: ${d.metrics.ytSubscribers.toLocaleString()} subs ${d.metrics.ytSubscribersDelta ? `(${d.metrics.ytSubscribersDelta})` : ""}`
    );
    sections.push(
      `• Website: ${d.metrics.websiteVisitors.toLocaleString()} visitors/7d ${d.metrics.websiteVisitorsDelta ? `(${d.metrics.websiteVisitorsDelta})` : ""}`
    );
    sections.push(
      `• Skool Rank: #${d.metrics.communityRank} ${d.metrics.communityRankDelta ? `(${d.metrics.communityRankDelta})` : ""}`
    );
  }

  if (d.emails?.length) {
    sections.push("\n### Recent Unread Emails");
    d.emails.forEach((e) => sections.push(`• ${e.from}: ${e.subject}`));
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatContentData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.metrics) {
    sections.push("### YouTube Performance");
    sections.push(
      `• Subscribers: ${d.metrics.ytSubscribers.toLocaleString()} ${d.metrics.ytSubscribersDelta ? `(${d.metrics.ytSubscribersDelta})` : ""}`
    );
    sections.push(
      `• Total views: ${d.metrics.ytTotalViews.toLocaleString()}`
    );
    sections.push("\n### Website Traffic");
    sections.push(
      `• Visitors (7d): ${d.metrics.websiteVisitors.toLocaleString()} ${d.metrics.websiteVisitorsDelta ? `(${d.metrics.websiteVisitorsDelta})` : ""}`
    );
    sections.push(
      `• Pageviews (7d): ${d.metrics.websitePageviews.toLocaleString()}`
    );
  }

  if (d.contentPipeline?.length) {
    sections.push("\n### Content Pipeline");
    d.contentPipeline.forEach((c) =>
      sections.push(`• [${c.status}] ${c.title}`)
    );
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatFinanceData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.metrics) {
    sections.push("### Revenue & Community");
    sections.push(
      `• MRR: $${d.metrics.skoolMRR} ${d.metrics.skoolMRRDelta ? `(${d.metrics.skoolMRRDelta})` : ""}`
    );
    sections.push(
      `• Paid members: ${d.metrics.skoolMembers} ${d.metrics.skoolMembersDelta ? `(${d.metrics.skoolMembersDelta})` : ""}`
    );
    sections.push(`• Retention: ${d.metrics.skoolRetention}%`);
    sections.push(`• Free members: ${d.metrics.freeMembers}`);
  }

  if (d.transactions?.length) {
    sections.push("\n### Recent Transactions (30d)");
    d.transactions.forEach((t) =>
      sections.push(
        `• ${t.date}: ${t.title} ${t.amount ? `— $${t.amount}` : ""}`
      )
    );
  }

  if (d.emails?.length) {
    const costEmails = d.emails.filter((e) =>
      /invoice|receipt|payment|billing|subscription|charge/i.test(e.subject)
    );
    if (costEmails.length) {
      sections.push("\n### Cost-Related Emails");
      costEmails.forEach((e) =>
        sections.push(`• ${e.from}: ${e.subject}`)
      );
    }
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatStrategyData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.metrics) {
    sections.push("### Executive Dashboard");
    sections.push(
      `• MRR: $${d.metrics.skoolMRR} ${d.metrics.skoolMRRDelta || ""}`
    );
    sections.push(
      `• Paid: ${d.metrics.skoolMembers} ${d.metrics.skoolMembersDelta ? `(${d.metrics.skoolMembersDelta})` : ""} | Free: ${d.metrics.freeMembers} | Retention: ${d.metrics.skoolRetention}%`
    );
    sections.push(
      `• YouTube: ${d.metrics.ytSubscribers.toLocaleString()} subs ${d.metrics.ytSubscribersDelta ? `(${d.metrics.ytSubscribersDelta})` : ""}`
    );
    sections.push(
      `• Website: ${d.metrics.websiteVisitors.toLocaleString()} visitors/7d | Skool Rank: #${d.metrics.communityRank} ${d.metrics.communityRankDelta || ""}`
    );
    sections.push(
      `• GitHub: ${d.metrics.ghStars} stars ${d.metrics.ghStarsDelta ? `(${d.metrics.ghStarsDelta})` : ""} | ${d.metrics.ghForks} forks`
    );
  }

  if (d.goals?.length) {
    sections.push("\n### Active Goals");
    d.goals.forEach((g) => sections.push(`• ${g}`));
  }

  if (d.calendar?.length) {
    sections.push("\n### Calendar (Today + 3 Days)");
    const tz = process.env.USER_TIMEZONE || "UTC";
    d.calendar.forEach((e) => {
      if (e.allDay) {
        sections.push(`• 📌 ${e.summary} (all day)`);
      } else {
        const time = new Date(e.start).toLocaleTimeString("en-US", {
          timeZone: tz,
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        sections.push(`• ${time} — ${e.summary}`);
      }
    });
  }

  if (d.news?.length) {
    sections.push("\n### Top AI News");
    d.news.slice(0, 3).forEach((n) => sections.push(n));
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatCTOData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.github) {
    sections.push("### GitHub — GoBot (autonomee/gobot)");
    sections.push(
      `• Open PRs: ${d.github.gobot.openPRs} | Open Issues: ${d.github.gobot.openIssues}`
    );
    if (d.github.gobot.prTitles.length) {
      d.github.gobot.prTitles.forEach((t) =>
        sections.push(`  - PR: ${t}`)
      );
    }
    sections.push("\n### GitHub — Relay (godagoo/claude-telegram-relay)");
    sections.push(
      `• Stars: ${d.github.relay.stars} | Forks: ${d.github.relay.forks} | Open Issues: ${d.github.relay.openIssues}`
    );
    if (d.github.relay.prTitles.length) {
      d.github.relay.prTitles.forEach((t) =>
        sections.push(`  - PR: ${t}`)
      );
    }
  }

  if (d.metrics) {
    sections.push("\n### Key Business Metrics");
    sections.push(
      `• Paid members: ${d.metrics.skoolMembers} | MRR: $${d.metrics.skoolMRR}`
    );
    sections.push(
      `• GitHub stars: ${d.metrics.ghStars} ${d.metrics.ghStarsDelta ? `(${d.metrics.ghStarsDelta})` : ""}`
    );
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatCOOData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.tasks?.length) {
    const overdue = d.tasks.filter((t) => t.isOverdue);
    const inProgress = d.tasks.filter((t) => t.status === "In progress");

    if (overdue.length) {
      sections.push(`### ⚠️ OVERDUE TASKS (${overdue.length})`);
      overdue.forEach((t) =>
        sections.push(`• ${t.title} (due: ${t.due})`)
      );
    }
    if (inProgress.length) {
      sections.push("\n### In Progress");
      inProgress.forEach((t) =>
        sections.push(`• ${t.title}${t.due ? ` (due: ${t.due})` : ""}`)
      );
    }
  } else {
    sections.push("### Tasks\nNo task data available.");
  }

  if (d.calendar?.length) {
    sections.push("\n### Today's Calendar");
    const tz = process.env.USER_TIMEZONE || "UTC";
    const todayStr = new Date().toISOString().split("T")[0];
    const todayEvents = d.calendar.filter((e) => {
      const eventDate = e.allDay ? e.start : e.start.split("T")[0];
      return eventDate === todayStr;
    });
    if (todayEvents.length) {
      todayEvents.forEach((e) => {
        if (e.allDay) {
          sections.push(`• 📌 ${e.summary} (all day)`);
        } else {
          const time = new Date(e.start).toLocaleTimeString("en-US", {
            timeZone: tz,
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
          sections.push(`• ${time} — ${e.summary}`);
        }
      });
    } else {
      sections.push("No events today.");
    }
  }

  if (d.emails?.length) {
    sections.push("\n### Unread Emails");
    d.emails.forEach((e) =>
      sections.push(`• ${e.from}: ${e.subject}`)
    );
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatCriticData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  sections.push("### Key Numbers");
  if (d.metrics) {
    sections.push(
      `• MRR: $${d.metrics.skoolMRR} ${d.metrics.skoolMRRDelta || ""}`
    );
    sections.push(
      `• Paid members: ${d.metrics.skoolMembers} ${d.metrics.skoolMembersDelta || ""} | Retention: ${d.metrics.skoolRetention}%`
    );
    sections.push(
      `• YouTube: ${d.metrics.ytSubscribers.toLocaleString()} subs | Website: ${d.metrics.websiteVisitors.toLocaleString()} visitors/7d`
    );
  }

  sections.push("\n### Risk Indicators");
  const overdueTasks = d.tasks?.filter((t) => t.isOverdue) || [];
  sections.push(`• Overdue tasks: ${overdueTasks.length}`);
  sections.push(
    `• Open GitHub issues (GoBot): ${d.github?.gobot?.openIssues ?? "unknown"}`
  );
  sections.push(
    `• Open GitHub issues (Relay): ${d.github?.relay?.openIssues ?? "unknown"}`
  );
  sections.push(`• Unread emails: ${d.emails?.length ?? "unknown"}`);

  return sections.join("\n");
}

// ============================================================
// Main Entry Point
// ============================================================

export async function gatherBoardData(): Promise<BoardData> {
  const start = Date.now();
  const errors: string[] = [];

  const [
    metricsResult,
    calendarResult,
    goalsResult,
    tasksResult,
    emailsResult,
    githubResult,
    newsResult,
    contentResult,
    transactionsResult,
  ] = await Promise.all([
    fetchWithTimeout("metrics", fetchMetrics, 8000),
    fetchWithTimeout("calendar", fetchCalendar, 5000),
    fetchWithTimeout("goals", fetchGoals, 5000),
    fetchWithTimeout("tasks", fetchNotionTasks, 5000),
    fetchWithTimeout("emails", fetchEmails, 5000),
    fetchWithTimeout("github", fetchGitHub, 5000),
    fetchWithTimeout("news", fetchAINews, 10000),
    fetchWithTimeout("content-pipeline", fetchContentPipeline, 5000),
    fetchWithTimeout("transactions", fetchTransactions, 5000),
  ]);

  for (const r of [
    metricsResult,
    calendarResult,
    goalsResult,
    tasksResult,
    emailsResult,
    githubResult,
    newsResult,
    contentResult,
    transactionsResult,
  ]) {
    if (r.error) errors.push(r.error);
  }

  const shared: SharedData = {
    metrics: metricsResult.data,
    calendar: calendarResult.data,
    goals: goalsResult.data,
    tasks: tasksResult.data,
    emails: emailsResult.data,
    github: githubResult.data,
    news: newsResult.data,
    contentPipeline: contentResult.data,
    transactions: transactionsResult.data,
  };

  const agentData: Record<string, string> = {
    research: formatResearchData(shared),
    content: formatContentData(shared),
    finance: formatFinanceData(shared),
    strategy: formatStrategyData(shared),
    cto: formatCTOData(shared),
    coo: formatCOOData(shared),
    critic: formatCriticData(shared),
  };

  // Shared summary for synthesis prompt
  const summaryParts: string[] = [];
  if (shared.metrics) {
    summaryParts.push(
      `MRR: $${shared.metrics.skoolMRR} ${shared.metrics.skoolMRRDelta || ""} | Members: ${shared.metrics.skoolMembers} | Retention: ${shared.metrics.skoolRetention}% | YT: ${shared.metrics.ytSubscribers.toLocaleString()} subs | Rank: #${shared.metrics.communityRank}`
    );
  }
  const overdue = shared.tasks?.filter((t) => t.isOverdue) || [];
  if (overdue.length)
    summaryParts.push(`⚠️ ${overdue.length} overdue tasks`);
  if (shared.github)
    summaryParts.push(
      `GitHub: ${shared.github.gobot.openPRs} open PRs, ${shared.github.gobot.openIssues + shared.github.relay.openIssues} total issues`
    );

  return {
    agentData,
    sharedSummary: summaryParts.join("\n"),
    fetchDurationMs: Date.now() - start,
    errors,
  };
}
