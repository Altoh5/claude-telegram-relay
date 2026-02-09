/**
 * Direct REST API functions for Gmail, Calendar, Notion, and WhatsApp
 *
 * These functions call Google/Notion/Unipile APIs directly -- no MCP servers,
 * no Claude subprocess. Instant (<1s) results.
 *
 * Used by anthropic-processor.ts as tool implementations on VPS.
 *
 * Required env vars:
 *   GMAIL_REFRESH_TOKEN      — Gmail API access
 *   WORKSPACE_REFRESH_TOKEN  — Calendar API access
 *   NOTION_TOKEN             — Notion API integration token
 *   NOTION_TASKS_DB_ID       — Notion tasks database ID
 *   UNIPILE_DSN              — Unipile WhatsApp access
 *   UNIPILE_API_KEY          — Unipile API key
 *   UNIPILE_WHATSAPP_ACCOUNT_ID — Unipile WhatsApp account
 *   FOLK_API_KEY             — (Optional) Folk CRM for contact lookup
 */

import { getValidAccessToken } from "./google-auth-vps";

// ============================================================
// GMAIL
// ============================================================

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Search Gmail messages
 */
export async function gmailSearch(
  query: string,
  maxResults: number = 10
): Promise<{
  messages: {
    id: string;
    from: string;
    subject: string;
    snippet: string;
    date: string;
  }[];
  totalResults: number;
}> {
  const token = await getValidAccessToken("gmail-business");
  const headers = { Authorization: `Bearer ${token}` };

  const listRes = await fetch(
    `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    { headers }
  );
  if (!listRes.ok) {
    throw new Error(`Gmail search failed: ${listRes.status}`);
  }

  const listData = (await listRes.json()) as {
    messages?: { id: string }[];
    resultSizeEstimate?: number;
  };
  const messageIds = listData.messages || [];
  const totalResults = listData.resultSizeEstimate || 0;

  if (messageIds.length === 0) {
    return { messages: [], totalResults: 0 };
  }

  // Fetch metadata in parallel
  const messages = await Promise.all(
    messageIds.map(async (m) => {
      const res = await fetch(
        `${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers }
      );
      if (!res.ok) return null;
      const msg = (await res.json()) as {
        id: string;
        snippet: string;
        payload?: { headers?: { name: string; value: string }[] };
      };
      const hdrs = msg.payload?.headers || [];
      return {
        id: msg.id,
        from: hdrs.find((h) => h.name === "From")?.value || "",
        subject: hdrs.find((h) => h.name === "Subject")?.value || "",
        snippet: msg.snippet || "",
        date: hdrs.find((h) => h.name === "Date")?.value || "",
      };
    })
  );

  return {
    messages: messages.filter((m): m is NonNullable<typeof m> => m !== null),
    totalResults,
  };
}

/**
 * Get full email content
 */
export async function gmailGet(messageId: string): Promise<{
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  snippet: string;
}> {
  const token = await getValidAccessToken("gmail-business");
  const res = await fetch(`${GMAIL_BASE}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail get failed: ${res.status}`);

  const msg = (await res.json()) as any;
  const hdrs = msg.payload?.headers || [];

  // Extract body (prefer plain text)
  let body = "";
  function extractBody(part: any) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      body = Buffer.from(part.body.data, "base64url").toString("utf-8");
    } else if (!body && part.mimeType === "text/html" && part.body?.data) {
      body = Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    if (part.parts) part.parts.forEach(extractBody);
  }
  extractBody(msg.payload);

  return {
    id: msg.id,
    from: hdrs.find((h: any) => h.name === "From")?.value || "",
    to: hdrs.find((h: any) => h.name === "To")?.value || "",
    subject: hdrs.find((h: any) => h.name === "Subject")?.value || "",
    date: hdrs.find((h: any) => h.name === "Date")?.value || "",
    body: body.substring(0, 5000),
    snippet: msg.snippet || "",
  };
}

/**
 * Send a new email
 */
export async function gmailSend(
  to: string,
  subject: string,
  body: string
): Promise<{ id: string; threadId: string }> {
  const token = await getValidAccessToken("gmail-business");

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString("base64url");

  const res = await fetch(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) throw new Error(`Gmail send failed: ${res.status}`);
  return (await res.json()) as { id: string; threadId: string };
}

/**
 * Reply to an email (reply-all)
 */
export async function gmailReply(
  messageId: string,
  body: string
): Promise<{ id: string; threadId: string }> {
  const token = await getValidAccessToken("gmail-business");
  const headers = { Authorization: `Bearer ${token}` };

  // Get original message for headers
  const origRes = await fetch(
    `${GMAIL_BASE}/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`,
    { headers }
  );
  if (!origRes.ok)
    throw new Error(`Gmail get original failed: ${origRes.status}`);
  const orig = (await origRes.json()) as any;
  const origHeaders = orig.payload?.headers || [];

  const from = origHeaders.find((h: any) => h.name === "From")?.value || "";
  const to = origHeaders.find((h: any) => h.name === "To")?.value || "";
  const cc = origHeaders.find((h: any) => h.name === "Cc")?.value || "";
  const subject =
    origHeaders.find((h: any) => h.name === "Subject")?.value || "";
  const messageIdHeader =
    origHeaders.find((h: any) => h.name === "Message-ID")?.value || "";
  const references =
    origHeaders.find((h: any) => h.name === "References")?.value || "";

  const replyTo = [from, to, cc].filter(Boolean).join(", ");
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const newReferences = references
    ? `${references} ${messageIdHeader}`
    : messageIdHeader;

  const rawEmail = [
    `To: ${replyTo}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${messageIdHeader}`,
    `References: ${newReferences}`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    body,
  ].join("\r\n");

  const raw = Buffer.from(rawEmail).toString("base64url");

  const res = await fetch(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw, threadId: orig.threadId }),
  });

  if (!res.ok) throw new Error(`Gmail reply failed: ${res.status}`);
  return (await res.json()) as { id: string; threadId: string };
}

// ============================================================
// CALENDAR
// ============================================================

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

/**
 * List calendar events
 */
export async function calendarListEvents(
  calendarId: string = "primary",
  timeMin?: string,
  timeMax?: string,
  maxResults: number = 20
): Promise<{
  events: {
    id: string;
    summary: string;
    start: string;
    end: string;
    location?: string;
    attendees?: string[];
  }[];
}> {
  const token = await getValidAccessToken("google-workspace");

  const now = new Date();
  const params = new URLSearchParams({
    timeMin: timeMin || now.toISOString(),
    timeMax:
      timeMax ||
      new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    maxResults: maxResults.toString(),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const res = await fetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Calendar API failed: ${res.status}`);

  const data = (await res.json()) as { items?: any[] };
  const events = (data.items || []).map((e: any) => ({
    id: e.id,
    summary: e.summary || "Untitled",
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    location: e.location,
    attendees: e.attendees?.map((a: any) => a.email),
  }));

  return { events };
}

// ============================================================
// NOTION
// ============================================================

const NOTION_BASE = "https://api.notion.com/v1";

function notionHeaders(): Record<string, string> {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN not configured");
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
}

/**
 * Query Notion tasks database
 */
export async function notionQueryTasks(
  statusFilter?: string
): Promise<{
  tasks: {
    id: string;
    title: string;
    status: string;
    priority: string;
    due?: string;
  }[];
}> {
  const dbId = process.env.NOTION_TASKS_DB_ID;
  if (!dbId) throw new Error("NOTION_TASKS_DB_ID not configured");

  const filters: any[] = [];

  if (statusFilter) {
    filters.push({
      property: "Status",
      select: { equals: statusFilter },
    });
  } else {
    filters.push({
      property: "Status",
      select: { does_not_equal: "Done" },
    });
  }

  const body: any = { page_size: 30 };
  if (filters.length === 1) {
    body.filter = filters[0];
  } else if (filters.length > 1) {
    body.filter = { and: filters };
  }

  const res = await fetch(`${NOTION_BASE}/databases/${dbId}/query`, {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion query failed: ${res.status}`);

  const data = (await res.json()) as { results: any[] };
  const tasks = data.results.map((page: any) => {
    const props = page.properties;
    // Try common title property names
    const titleProp =
      props.Task?.title || props.Name?.title || props.Title?.title;
    return {
      id: page.id,
      title: titleProp?.[0]?.plain_text || "Untitled",
      status: props.Status?.select?.name || "",
      priority: props.Priority?.select?.name || "",
      due: props.Due?.date?.start || undefined,
    };
  });

  return { tasks };
}

/**
 * Search across Notion pages
 */
export async function notionSearch(
  query: string
): Promise<{ results: { id: string; title: string; type: string }[] }> {
  const res = await fetch(`${NOTION_BASE}/search`, {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify({ query, page_size: 10 }),
  });
  if (!res.ok) throw new Error(`Notion search failed: ${res.status}`);

  const data = (await res.json()) as { results: any[] };
  const results = data.results.map((r: any) => ({
    id: r.id,
    title:
      r.properties?.title?.title?.[0]?.plain_text ||
      r.properties?.Task?.title?.[0]?.plain_text ||
      r.properties?.Name?.title?.[0]?.plain_text ||
      "Untitled",
    type: r.object,
  }));

  return { results };
}

// ============================================================
// WHATSAPP (via Unipile API)
// ============================================================

function unipileHeaders(): Record<string, string> {
  const apiKey = process.env.UNIPILE_API_KEY;
  if (!apiKey) throw new Error("UNIPILE_API_KEY not configured");
  return {
    "X-API-KEY": apiKey,
    "Content-Type": "application/json",
    accept: "application/json",
  };
}

function unipileBase(): string {
  const dsn = process.env.UNIPILE_DSN;
  if (!dsn) throw new Error("UNIPILE_DSN not configured");
  return `https://${dsn}/api/v1`;
}

/**
 * Find a WhatsApp chat by name or phone number.
 * Falls back to Folk CRM for phone lookup if configured.
 */
export async function whatsappFindChat(
  query: string
): Promise<{
  chats: {
    id: string;
    name: string;
    phone: string | null;
    type: string;
  }[];
}> {
  const accountId = process.env.UNIPILE_WHATSAPP_ACCOUNT_ID;

  const res = await fetch(
    `${unipileBase()}/chats?account_id=${accountId}&limit=200`,
    { headers: unipileHeaders() }
  );
  if (!res.ok) throw new Error(`Unipile chats failed: ${res.status}`);

  const data = (await res.json()) as { items?: any[] };
  const allChats = data.items || [];

  const q = query.toLowerCase().replace(/[^a-z0-9]/g, "");

  function searchChats(searchQ: string) {
    return allChats.filter((chat: any) => {
      const providerId = (chat.provider_id || "").toLowerCase();
      const chatName = (chat.name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      const attendeeMatch = (chat.attendees || []).some((a: any) =>
        (a.display_name || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .includes(searchQ)
      );
      return (
        providerId.includes(searchQ) ||
        chatName.includes(searchQ) ||
        attendeeMatch
      );
    });
  }

  let matches = searchChats(q);

  // Fallback: try Folk CRM for phone number lookup
  const folkApiKey = process.env.FOLK_API_KEY;
  if (matches.length === 0 && folkApiKey) {
    console.log(
      `WhatsApp: no chat found for "${query}", trying Folk CRM...`
    );
    try {
      const folkContacts = await folkSearchContacts(query);
      if (folkContacts.length > 0 && folkContacts[0].phones?.length > 0) {
        const phone = folkContacts[0].phones[0].replace(/[^0-9]/g, "");
        console.log(
          `Folk CRM found: ${folkContacts[0].fullName}, phone: ${phone}`
        );
        matches = searchChats(phone);
      }
    } catch (err: any) {
      console.error("Folk CRM fallback error:", err.message);
    }
  }

  return {
    chats: matches.slice(0, 5).map((chat: any) => {
      const phoneMatch = chat.provider_id?.match(/(\d+)@/);
      const attendeeName = chat.attendees?.find((a: any) => !a.is_self)
        ?.display_name;
      return {
        id: chat.id,
        name: attendeeName || chat.name || "Unknown",
        phone: phoneMatch ? `+${phoneMatch[1]}` : null,
        type: chat.type === 1 ? "group" : "individual",
      };
    }),
  };
}

/**
 * Send a WhatsApp message
 */
export async function whatsappSend(
  chatId: string,
  message: string
): Promise<{ message_id: string }> {
  const res = await fetch(`${unipileBase()}/chats/${chatId}/messages`, {
    method: "POST",
    headers: unipileHeaders(),
    body: JSON.stringify({ text: message }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Unipile send failed: ${res.status} - ${errText}`);
  }

  return (await res.json()) as { message_id: string };
}

// ============================================================
// FOLK CRM (contact lookup fallback - optional)
// ============================================================

const FOLK_BASE = "https://api.folk.app/v1";

async function folkSearchContacts(
  query: string
): Promise<{ fullName: string; phones: string[]; emails: string[] }[]> {
  const folkApiKey = process.env.FOLK_API_KEY;
  if (!folkApiKey) return [];

  const res = await fetch(`${FOLK_BASE}/people?limit=100`, {
    headers: { Authorization: `Bearer ${folkApiKey}` },
  });
  if (!res.ok) throw new Error(`Folk API failed: ${res.status}`);

  const data = (await res.json()) as { data?: { items?: any[] } };
  const people = data.data?.items || [];

  const q = query.toLowerCase().trim();
  return people
    .filter(
      (p: any) =>
        p.fullName?.toLowerCase().includes(q) ||
        p.firstName?.toLowerCase().includes(q) ||
        p.lastName?.toLowerCase().includes(q)
    )
    .map((p: any) => ({
      fullName: p.fullName || "",
      phones: p.phones || [],
      emails: p.emails || [],
    }));
}
