# TwinMind Autonomous Sync — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `twinmind-monitor.ts` sync new meetings directly from TwinMind's API at startup, so the full pipeline (TwinMind → Supabase → Telegram) runs autonomously via launchd without needing an open Claude Code session.

**Architecture:** Add a `syncFromTwinmindDirect()` function extracted into `src/lib/twinmind-direct-sync.ts`. It reads the stored OAuth Bearer token from `~/.claude/.credentials.json`, calls `https://api.thirdear.live/v3/mcp` via MCP JSON-RPC over HTTP, upserts any new meetings to Supabase, and falls back gracefully on any failure. `twinmind-monitor.ts` calls this at the top of `main()` before the existing Supabase fetch.

**Tech Stack:** Bun, TypeScript, `bun:test` for tests, `@supabase/supabase-js`, native `fetch`

---

### Task 1: Create `src/lib/twinmind-direct-sync.ts` with failing test

**Files:**
- Create: `src/lib/twinmind-direct-sync.ts`
- Create: `src/twinmind-direct-sync.test.ts`

**Step 1: Create the test file**

```typescript
// src/twinmind-direct-sync.test.ts
import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// We'll import after module exists
let syncFromTwinmindDirect: (supabase: any) => Promise<number>;

beforeEach(async () => {
  const mod = await import("./lib/twinmind-direct-sync.ts");
  syncFromTwinmindDirect = mod.syncFromTwinmindDirect;
});
```

**Step 2: Run test to confirm it fails (import error expected)**

```bash
cd ~/claudeprojects/claude-telegram-relay
bun test src/twinmind-direct-sync.test.ts
```

Expected: Error — `Cannot find module './lib/twinmind-direct-sync.ts'`

**Step 3: Create the stub module**

```typescript
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
```

**Step 4: Run test to confirm module loads (no test assertions yet — just import check)**

```bash
bun test src/twinmind-direct-sync.test.ts
```

Expected: PASS (0 tests, no errors)

**Step 5: Commit**

```bash
cd ~/claudeprojects/claude-telegram-relay
git add src/lib/twinmind-direct-sync.ts src/twinmind-direct-sync.test.ts
git commit -m "feat: add twinmind-direct-sync module (stub + empty test)"
```

---

### Task 2: Write and pass tests for `readTwinMindToken`

**Files:**
- Modify: `src/twinmind-direct-sync.test.ts`

**Step 1: Write the failing tests**

Replace the contents of `src/twinmind-direct-sync.test.ts`:

```typescript
import { describe, it, expect, mock, spyOn, afterEach } from "bun:test";
import * as fs from "fs/promises";

// Dynamic import to allow mocking
const getModule = () => import("./lib/twinmind-direct-sync.ts");

// ─── readTwinMindToken ────────────────────────────────────────────────────────

describe("readTwinMindToken", () => {
  afterEach(() => {
    // clear module cache between tests
  });

  it("returns token when credentials file has twinmind entry", async () => {
    const fakeCreds = {
      mcpOAuth: {
        "twinmind|abc123": {
          serverUrl: "https://api.thirdear.live/v3/mcp",
          accessToken: "test-access-token-xyz",
          refreshToken: "test-refresh-token",
        },
      },
    };

    const readFileSpy = spyOn(fs, "readFile").mockResolvedValueOnce(
      JSON.stringify(fakeCreds) as any
    );

    const { readTwinMindToken } = await getModule();
    const result = await readTwinMindToken();

    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("test-access-token-xyz");
    expect(result?.serverUrl).toBe("https://api.thirdear.live/v3/mcp");

    readFileSpy.mockRestore();
  });

  it("returns null when credentials file is missing", async () => {
    const readFileSpy = spyOn(fs, "readFile").mockRejectedValueOnce(
      new Error("ENOENT") as any
    );

    const { readTwinMindToken } = await getModule();
    const result = await readTwinMindToken();

    expect(result).toBeNull();
    readFileSpy.mockRestore();
  });

  it("returns null when mcpOAuth has no twinmind entry", async () => {
    const fakeCreds = { mcpOAuth: { "other|server": { serverUrl: "https://other.com" } } };
    const readFileSpy = spyOn(fs, "readFile").mockResolvedValueOnce(
      JSON.stringify(fakeCreds) as any
    );

    const { readTwinMindToken } = await getModule();
    const result = await readTwinMindToken();

    expect(result).toBeNull();
    readFileSpy.mockRestore();
  });
});
```

**Step 2: Run tests to verify they fail first**

```bash
bun test src/twinmind-direct-sync.test.ts 2>&1 | tail -20
```

Expected: Tests may partially pass since stub is already written. If all pass, move on.

**Step 3: Run full test suite**

```bash
bun test src/twinmind-direct-sync.test.ts --verbose
```

Expected: All 3 tests PASS

**Step 4: Commit**

```bash
git add src/twinmind-direct-sync.test.ts
git commit -m "test: add readTwinMindToken unit tests"
```

---

### Task 3: Write and pass tests for `fetchMeetingsFromTwinMind`

**Files:**
- Modify: `src/twinmind-direct-sync.test.ts` (append)

**Step 1: Append these tests to the file**

```typescript
// ─── fetchMeetingsFromTwinMind ────────────────────────────────────────────────

describe("fetchMeetingsFromTwinMind", () => {
  const FAKE_TOKEN = "bearer-token-123";
  const FAKE_URL = "https://api.thirdear.live/v3/mcp";

  const fakeMcpResponse = (meetings: any[]) => ({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(meetings) }],
      isError: false,
    },
  });

  it("parses meetings from MCP response", async () => {
    const rawMeetings = [
      {
        meeting_id: "abc-123",
        meeting_title: "WMI Strategy Call",
        summary: "Discussed proposal.",
        action: "Follow up with Rachel.",
        start_time_local: "2026-02-25T10:00:00",
        end_time_local: "2026-02-25T11:00:00",
      },
    ];

    global.fetch = mock(async () => ({
      ok: true,
      json: async () => fakeMcpResponse(rawMeetings),
    })) as any;

    const { fetchMeetingsFromTwinMind } = await getModule();
    const result = await fetchMeetingsFromTwinMind(FAKE_TOKEN, FAKE_URL);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].meeting_id).toBe("abc-123");
    expect(result![0].meeting_title).toBe("WMI Strategy Call");
    expect(result![0].action_items).toBe("Follow up with Rachel.");
  });

  it("returns null on HTTP 401", async () => {
    global.fetch = mock(async () => ({ ok: false, status: 401 })) as any;

    const { fetchMeetingsFromTwinMind } = await getModule();
    const result = await fetchMeetingsFromTwinMind(FAKE_TOKEN, FAKE_URL);

    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    global.fetch = mock(async () => { throw new Error("Network error"); }) as any;

    const { fetchMeetingsFromTwinMind } = await getModule();
    const result = await fetchMeetingsFromTwinMind(FAKE_TOKEN, FAKE_URL);

    expect(result).toBeNull();
  });

  it("returns null when response has no content", async () => {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: {} }),
    })) as any;

    const { fetchMeetingsFromTwinMind } = await getModule();
    const result = await fetchMeetingsFromTwinMind(FAKE_TOKEN, FAKE_URL);

    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests**

```bash
bun test src/twinmind-direct-sync.test.ts --verbose
```

Expected: All 7 tests PASS

**Step 3: Commit**

```bash
git add src/twinmind-direct-sync.test.ts
git commit -m "test: add fetchMeetingsFromTwinMind unit tests"
```

---

### Task 4: Write and pass tests for `upsertMeetings`

**Files:**
- Modify: `src/twinmind-direct-sync.test.ts` (append)

**Step 1: Append these tests**

```typescript
// ─── upsertMeetings ───────────────────────────────────────────────────────────

describe("upsertMeetings", () => {
  function mockSupabase(upsertError: any = null) {
    const upserted: any[] = [];
    return {
      client: {
        from: () => ({
          upsert: mock(async (rows: any[]) => {
            upserted.push(...rows);
            return { error: upsertError };
          }),
        }),
      } as any,
      upserted,
    };
  }

  it("upserts all meetings and returns count", async () => {
    const { client, upserted } = mockSupabase();
    const meetings = [
      { meeting_id: "m1", meeting_title: "Meet 1", summary: "S1", action_items: "A1" },
      { meeting_id: "m2", meeting_title: "Meet 2", summary: "S2", action_items: "" },
    ];

    const { upsertMeetings } = await getModule();
    const count = await upsertMeetings(client, meetings);

    expect(count).toBe(2);
    expect(upserted.length).toBe(2);
    expect(upserted[0].meeting_id).toBe("m1");
  });

  it("returns 0 on Supabase error", async () => {
    const { client } = mockSupabase({ message: "DB error" });
    const meetings = [{ meeting_id: "m1", meeting_title: "T", summary: "S" }];

    const { upsertMeetings } = await getModule();
    const count = await upsertMeetings(client, meetings);

    expect(count).toBe(0);
  });

  it("returns 0 for empty array", async () => {
    const { client } = mockSupabase();

    const { upsertMeetings } = await getModule();
    const count = await upsertMeetings(client, []);

    expect(count).toBe(0);
  });
});
```

**Step 2: Run all tests**

```bash
bun test src/twinmind-direct-sync.test.ts --verbose
```

Expected: All 10 tests PASS

**Step 3: Commit**

```bash
git add src/twinmind-direct-sync.test.ts
git commit -m "test: add upsertMeetings unit tests"
```

---

### Task 5: Wire `syncFromTwinmindDirect` into `twinmind-monitor.ts`

**Files:**
- Modify: `src/twinmind-monitor.ts`

**Step 1: Add import at top of file**

Find the existing imports block (around line 12–18) and add:

```typescript
import { syncFromTwinmindDirect } from "./lib/twinmind-direct-sync";
```

**Step 2: Add sync call in `main()`**

Find the `main()` function. After the startup log lines (the `console.log("TwinMind Monitor starting...")` block) and before `const meetings = await fetchUnprocessedMeetings()`, add:

```typescript
// Sync latest meetings from TwinMind API directly (no Claude Code needed)
console.log("Step 1/3: Syncing from TwinMind API...");
const synced = await syncFromTwinmindDirect(getSupabase()!);
if (synced > 0) {
  console.log(`  ↳ Synced ${synced} new meeting(s) from TwinMind`);
} else {
  console.log("  ↳ No new meetings synced (token issue or already up to date)");
}
console.log("Step 2/3: Fetching unprocessed meetings from Supabase...");
```

Also update the existing `console.log` before `fetchUnprocessedMeetings` if present, or just add the `Step 2/3` line right before the fetch.

**Step 3: Verify TypeScript compiles**

```bash
cd ~/claudeprojects/claude-telegram-relay
bun run --dry src/twinmind-monitor.ts 2>&1 | head -20
```

Expected: No TypeScript errors (script starts and exits immediately with `--dry` not supported, so just check for compile errors)

```bash
bun build src/twinmind-monitor.ts --outdir /tmp/build-check 2>&1
```

Expected: Build succeeds or only warns about external deps

**Step 4: Run all tests to confirm nothing broken**

```bash
bun test --verbose 2>&1 | tail -20
```

Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/twinmind-monitor.ts
git commit -m "feat: wire syncFromTwinmindDirect into twinmind-monitor startup"
```

---

### Task 6: End-to-end manual test

**Step 1: Mark a recent meeting as unprocessed to test with**

```bash
# Get a meeting_id from the last run to test with
cd ~/claudeprojects/claude-telegram-relay
```

In Supabase SQL editor (or via MCP), run:
```sql
UPDATE twinmind_meetings
SET processed = false, processed_at = null
WHERE meeting_id = '4a476045-cdf8-4c7c-a2a4-1381a8f31ed9'
  -- (WMI Agentic proposal — most recent)
;
```

**Step 2: Run monitor manually with --force**

```bash
bun run src/twinmind-monitor.ts --force 2>&1 | tee /tmp/monitor-test.log
```

Expected output:
```
TwinMind Monitor starting...
Step 1/3: Syncing from TwinMind API...
TwinMind direct sync: fetching from API...
TwinMind direct sync: got N meeting(s) from API
TwinMind direct sync: upserted N meeting(s) to Supabase
  ↳ Synced N new meeting(s) from TwinMind
Step 2/3: Fetching unprocessed meetings from Supabase...
Found 1 unprocessed meeting(s)
Processing: WMI Agentic proposal
  Summary text sent
  ...
```

**Step 3: Verify Telegram received the message**

Check your Telegram — you should receive the WMI meeting summary.

**Step 4: Confirm processed flag reset correctly**

The WMI meeting should now show `processed=true` in Supabase again.

**Step 5: Commit final**

```bash
git add -A
git commit -m "feat: TwinMind autonomous sync — pipeline now runs fully without Claude Code"
```

---

### Task 7: Add `test` script to `package.json`

**Files:**
- Modify: `package.json`

**Step 1: Add test script**

Open `package.json` and add to `scripts`:

```json
"test": "bun test",
"test:watch": "bun test --watch"
```

**Step 2: Verify**

```bash
bun run test
```

Expected: All tests PASS

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add bun test script to package.json"
```

---

## Summary

After these 7 tasks, the full pipeline runs autonomously:

```
Meeting ends in TwinMind
       ↓
launchd fires twinmind-monitor (every 30 min, 8am–10pm)
       ↓
syncFromTwinmindDirect() — reads token, calls TwinMind API, upserts to Supabase
       ↓
fetchUnprocessedMeetings() — reads Supabase
       ↓
processMeeting() — sends summary + infographics to Telegram
```

No Claude Code session required. Token expires every ~1 hour but is refreshed each time you open Claude Code. The launchd fallback gracefully handles expired tokens by skipping the sync step and processing whatever is already in Supabase.
