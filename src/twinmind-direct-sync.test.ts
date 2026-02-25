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
