#!/usr/bin/env bun
/**
 * Google Calendar CLI
 *
 * Usage:
 *   bun src/cli/gcal.ts list [YYYY-MM-DD]
 *   bun src/cli/gcal.ts create "<title>" "<startISO>" "<endISO>" ["<description>"]
 *   bun src/cli/gcal.ts get <eventId>
 */

import { init, getToken, output, error, run } from "./_google";

const BASE = "https://www.googleapis.com/calendar/v3";

async function listEvents(date?: string): Promise<void> {
  const token = await getToken();
  const tz = process.env.USER_TIMEZONE || "UTC";

  // Default to today in user's timezone
  const target = date || new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  const offset = getTimezoneOffset(tz);
  const timeMin = new Date(`${target}T00:00:00${offset}`).toISOString();
  const timeMax = new Date(`${target}T23:59:59${offset}`).toISOString();

  const params = new URLSearchParams({
    timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "25",
  });

  const res = await fetch(`${BASE}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) error(`Calendar API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const events = (data.items || []).map((e: any) => ({
    id: e.id,
    title: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    allDay: !!e.start?.date,
    location: e.location || null,
    description: e.description?.substring(0, 200) || null,
  }));

  output(events);
}

async function createEvent(title: string, start: string, end: string, description?: string): Promise<void> {
  const token = await getToken();
  const tz = process.env.USER_TIMEZONE || "UTC";

  const body: any = {
    summary: title,
    start: { dateTime: start, timeZone: tz },
    end: { dateTime: end, timeZone: tz },
  };
  if (description) body.description = description;

  const res = await fetch(`${BASE}/calendars/primary/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) error(`Calendar API ${res.status}: ${await res.text()}`);

  const event = await res.json();
  output({ id: event.id, title: event.summary, start: event.start, end: event.end, link: event.htmlLink });
}

async function getEvent(eventId: string): Promise<void> {
  const token = await getToken();

  const res = await fetch(`${BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) error(`Calendar API ${res.status}: ${await res.text()}`);

  const e = await res.json();
  output({
    id: e.id,
    title: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || null,
    description: e.description || null,
    attendees: e.attendees?.map((a: any) => a.email) || [],
    link: e.htmlLink,
  });
}

function getTimezoneOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, timeZoneName: "longOffset",
    }).formatToParts(new Date());
    const offsetPart = parts.find((p) => p.type === "timeZoneName");
    const match = offsetPart?.value?.match(/GMT([+-]\d{2}:\d{2})/);
    if (match) return match[1];
  } catch {}
  return "+00:00";
}

// --- Main ---
run(async () => {
  await init();
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "list":
      await listEvents(args[0]);
      break;
    case "create":
      if (args.length < 3) error("Usage: create <title> <startISO> <endISO> [description]");
      await createEvent(args[0], args[1], args[2], args[3]);
      break;
    case "get":
      if (!args[0]) error("Usage: get <eventId>");
      await getEvent(args[0]);
      break;
    default:
      error(`Unknown command: ${cmd || "(none)"}. Available: list, create, get`);
  }
});
