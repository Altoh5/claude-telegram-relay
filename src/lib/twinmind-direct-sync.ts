// src/lib/twinmind-direct-sync.ts

import { readFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TwinMindMeeting {
  meeting_id: string;
  meeting_title: string;
  summary: string;
  action_items?: string;
  start_time?: string;
  end_time?: string;
}

/**
 * Reads the TwinMind OAuth token from ~/.claude/.credentials.json.
 * Returns null if not found or file unreadable.
 */
export async function readTwinMindToken(): Promise<{ accessToken: string; serverUrl: string } | null> {
  try {
    const credsPath = path.join(os.homedir(), ".claude", ".credentials.json");
    const raw = await readFile(credsPath, "utf-8");
    const creds = JSON.parse(raw);
    const mcpOAuth = creds?.mcpOAuth ?? {};
    const entry = Object.values(mcpOAuth).find(
      (a: any) => typeof a?.serverUrl === "string" && a.serverUrl.includes("thirdear.live")
    ) as any;
    if (!entry?.accessToken) return null;
    return { accessToken: entry.accessToken, serverUrl: entry.serverUrl };
  } catch {
    return null;
  }
}

/**
 * Calls TwinMind's MCP server directly via HTTP JSON-RPC.
 * Returns parsed meetings or null on failure.
 */
export async function fetchMeetingsFromTwinMind(
  accessToken: string,
  serverUrl: string,
  daysBack = 7
): Promise<TwinMindMeeting[] | null> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "summary_search",
          arguments: { start_time: since, limit: 20 },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn(`TwinMind direct sync: HTTP ${res.status} — skipping`);
      return null;
    }

    const json = await res.json() as any;
    // MCP tool result: { result: { content: [{ type: "text", text: "..." }] } }
    const text = json?.result?.content?.[0]?.text;
    if (!text) return null;

    const meetings: any[] = JSON.parse(text);
    return meetings.map((m) => ({
      meeting_id: m.meeting_id,
      meeting_title: m.meeting_title ?? "Untitled",
      summary: m.summary ?? "",
      action_items: m.action ?? m.action_items ?? "",
      start_time: m.start_time_local ?? m.start_time ?? null,
      end_time: m.end_time_local ?? m.end_time ?? null,
    }));
  } catch (err: any) {
    console.warn(`TwinMind direct sync: fetch failed — ${err.message}`);
    return null;
  }
}

/**
 * Upserts meetings to Supabase twinmind_meetings table.
 * Returns number of rows upserted.
 */
export async function upsertMeetings(
  supabase: SupabaseClient,
  meetings: TwinMindMeeting[]
): Promise<number> {
  if (meetings.length === 0) return 0;

  const rows = meetings.map((m) => ({
    meeting_id: m.meeting_id,
    meeting_title: m.meeting_title,
    summary: m.summary,
    action_items: m.action_items ?? "",
    start_time: m.start_time ?? null,
    end_time: m.end_time ?? null,
  }));

  const { error } = await supabase.from("twinmind_meetings").upsert(rows, {
    onConflict: "meeting_id",
    ignoreDuplicates: false,
  });

  if (error) {
    console.error(`TwinMind direct sync: Supabase upsert failed — ${error.message}`);
    return 0;
  }
  return rows.length;
}

/**
 * Main entry: sync meetings from TwinMind → Supabase.
 * Returns number of meetings upserted (0 on any failure).
 */
export async function syncFromTwinmindDirect(supabase: SupabaseClient): Promise<number> {
  const auth = await readTwinMindToken();
  if (!auth) {
    console.warn("TwinMind direct sync: no token found in ~/.claude/.credentials.json — skipping");
    return 0;
  }

  console.log("TwinMind direct sync: fetching from API...");
  const meetings = await fetchMeetingsFromTwinMind(auth.accessToken, auth.serverUrl);
  if (!meetings) return 0;

  console.log(`TwinMind direct sync: got ${meetings.length} meeting(s) from API`);
  const count = await upsertMeetings(supabase, meetings);
  console.log(`TwinMind direct sync: upserted ${count} meeting(s) to Supabase`);
  return count;
}
