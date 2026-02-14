import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";

// Helper to create a mock Supabase client
function mockSupabase() {
  const inserted: Array<{ table: string; data: any }> = [];
  const updated: Array<{ table: string; data: any; filter: any }> = [];

  let selectResult: { data: any[] | null } = { data: null };
  let rpcResults: Record<string, { data: any[]; error: any }> = {};
  let functionsResult: { data: any; error: any } = { data: null, error: null };

  const client: any = {
    from: (table: string) => ({
      insert: mock(async (data: any) => {
        inserted.push({ table, data });
        return { error: null };
      }),
      select: (_cols: string) => ({
        eq: (_col: string, _val: any) => ({
          ilike: (_col2: string, _pattern: string) => ({
            limit: (_n: number) => {
              return Promise.resolve(selectResult);
            },
          }),
        }),
      }),
      update: mock((data: any) => ({
        eq: (_col: string, _val: any) => {
          updated.push({ table, data, filter: { col: _col, val: _val } });
          return Promise.resolve({ error: null });
        },
      })),
    }),
    rpc: mock(async (fn: string) => {
      return rpcResults[fn] || { data: [], error: null };
    }),
    functions: {
      invoke: mock(async (_name: string, _opts: any) => {
        return functionsResult;
      }),
    },
  };

  return {
    client,
    inserted,
    updated,
    setSelectResult: (data: any[] | null) => {
      selectResult = { data };
    },
    setRpcResults: (results: Record<string, { data: any[]; error: any }>) => {
      rpcResults = results;
    },
    setFunctionsResult: (result: { data: any; error: any }) => {
      functionsResult = result;
    },
  };
}

// ============================================================
// processMemoryIntents
// ============================================================

describe("processMemoryIntents", () => {
  it("returns response unchanged when supabase is null", async () => {
    const result = await processMemoryIntents(null, "Hello [REMEMBER: test]");
    expect(result).toBe("Hello [REMEMBER: test]");
  });

  it("parses and strips [REMEMBER: ...] tags", async () => {
    const sb = mockSupabase();
    const result = await processMemoryIntents(
      sb.client,
      "Got it! [REMEMBER: User likes TypeScript] I'll keep that in mind."
    );
    expect(result).toBe("Got it!  I'll keep that in mind.");
    expect(sb.inserted).toHaveLength(1);
    expect(sb.inserted[0].table).toBe("memory");
    expect(sb.inserted[0].data).toEqual({
      type: "fact",
      content: "User likes TypeScript",
    });
  });

  it("parses multiple REMEMBER tags", async () => {
    const sb = mockSupabase();
    const result = await processMemoryIntents(
      sb.client,
      "[REMEMBER: Fact one] and [REMEMBER: Fact two]"
    );
    expect(result).toBe("and");
    expect(sb.inserted).toHaveLength(2);
    expect(sb.inserted[0].data.content).toBe("Fact one");
    expect(sb.inserted[1].data.content).toBe("Fact two");
  });

  it("parses [GOAL: ...] without deadline", async () => {
    const sb = mockSupabase();
    const result = await processMemoryIntents(
      sb.client,
      "Let's do it! [GOAL: Learn Rust]"
    );
    expect(result).toBe("Let's do it!");
    expect(sb.inserted).toHaveLength(1);
    expect(sb.inserted[0].data).toEqual({
      type: "goal",
      content: "Learn Rust",
      deadline: null,
    });
  });

  it("parses [GOAL: ... | DEADLINE: ...] with deadline", async () => {
    const sb = mockSupabase();
    const result = await processMemoryIntents(
      sb.client,
      "Added! [GOAL: Ship v2 | DEADLINE: 2025-03-01]"
    );
    expect(result).toBe("Added!");
    expect(sb.inserted).toHaveLength(1);
    expect(sb.inserted[0].data).toEqual({
      type: "goal",
      content: "Ship v2",
      deadline: "2025-03-01",
    });
  });

  it("parses [DONE: ...] and marks goal as completed", async () => {
    const sb = mockSupabase();
    sb.setSelectResult([{ id: "goal-123" }]);
    const result = await processMemoryIntents(
      sb.client,
      "Congrats! [DONE: Learn Rust]"
    );
    expect(result).toBe("Congrats!");
    expect(sb.updated).toHaveLength(1);
    expect(sb.updated[0].data.type).toBe("completed_goal");
    expect(sb.updated[0].data.completed_at).toBeDefined();
    expect(sb.updated[0].filter).toEqual({ col: "id", val: "goal-123" });
  });

  it("does not update when [DONE: ...] finds no matching goal", async () => {
    const sb = mockSupabase();
    sb.setSelectResult(null);
    const result = await processMemoryIntents(
      sb.client,
      "Done! [DONE: nonexistent goal]"
    );
    expect(result).toBe("Done!");
    expect(sb.updated).toHaveLength(0);
  });

  it("handles mixed tags in one response", async () => {
    const sb = mockSupabase();
    sb.setSelectResult([{ id: "g1" }]);
    const result = await processMemoryIntents(
      sb.client,
      "OK [REMEMBER: likes coffee] [GOAL: Run 5k | DEADLINE: 2025-06-01] [DONE: morning jog] done"
    );
    expect(result).toBe("OK    done");
    // 1 REMEMBER + 1 GOAL
    expect(sb.inserted).toHaveLength(2);
    // 1 DONE
    expect(sb.updated).toHaveLength(1);
  });

  it("is case-insensitive for tags", async () => {
    const sb = mockSupabase();
    const result = await processMemoryIntents(
      sb.client,
      "Noted [remember: lowercase test]"
    );
    expect(result).toBe("Noted");
    expect(sb.inserted).toHaveLength(1);
    expect(sb.inserted[0].data.content).toBe("lowercase test");
  });
});

// ============================================================
// getMemoryContext
// ============================================================

describe("getMemoryContext", () => {
  it("returns empty string when supabase is null", async () => {
    const result = await getMemoryContext(null);
    expect(result).toBe("");
  });

  it("returns empty string when no facts or goals", async () => {
    const sb = mockSupabase();
    const result = await getMemoryContext(sb.client);
    expect(result).toBe("");
  });

  it("formats facts correctly", async () => {
    const sb = mockSupabase();
    sb.setRpcResults({
      get_facts: {
        data: [{ content: "Likes TypeScript" }, { content: "Lives in NYC" }],
        error: null,
      },
      get_active_goals: { data: [], error: null },
    });
    const result = await getMemoryContext(sb.client);
    expect(result).toBe("FACTS:\n- Likes TypeScript\n- Lives in NYC");
  });

  it("formats goals correctly", async () => {
    const sb = mockSupabase();
    sb.setRpcResults({
      get_facts: { data: [], error: null },
      get_active_goals: {
        data: [{ content: "Learn Rust", deadline: null }],
        error: null,
      },
    });
    const result = await getMemoryContext(sb.client);
    expect(result).toBe("GOALS:\n- Learn Rust");
  });

  it("formats goals with deadlines", async () => {
    const sb = mockSupabase();
    sb.setRpcResults({
      get_facts: { data: [], error: null },
      get_active_goals: {
        data: [{ content: "Ship v2", deadline: "2025-03-01T00:00:00Z" }],
        error: null,
      },
    });
    const result = await getMemoryContext(sb.client);
    expect(result).toContain("GOALS:");
    expect(result).toContain("Ship v2");
    expect(result).toMatch(/\(by \d+\/\d+\/\d+\)/);
  });

  it("combines facts and goals", async () => {
    const sb = mockSupabase();
    sb.setRpcResults({
      get_facts: { data: [{ content: "Fact 1" }], error: null },
      get_active_goals: {
        data: [{ content: "Goal 1", deadline: null }],
        error: null,
      },
    });
    const result = await getMemoryContext(sb.client);
    expect(result).toContain("FACTS:");
    expect(result).toContain("GOALS:");
    expect(result.indexOf("FACTS:")).toBeLessThan(result.indexOf("GOALS:"));
  });
});

// ============================================================
// getRelevantContext
// ============================================================

describe("getRelevantContext", () => {
  it("returns empty string when supabase is null", async () => {
    const result = await getRelevantContext(null, "test query");
    expect(result).toBe("");
  });

  it("returns empty string when search returns no data", async () => {
    const sb = mockSupabase();
    sb.setFunctionsResult({ data: [], error: null });
    const result = await getRelevantContext(sb.client, "test");
    expect(result).toBe("");
  });

  it("returns empty string on error", async () => {
    const sb = mockSupabase();
    sb.setFunctionsResult({ data: null, error: "search failed" });
    const result = await getRelevantContext(sb.client, "test");
    expect(result).toBe("");
  });

  it("formats search results correctly", async () => {
    const sb = mockSupabase();
    sb.setFunctionsResult({
      data: [
        { role: "user", content: "How do I use Bun?" },
        { role: "assistant", content: "Bun is a JS runtime..." },
      ],
      error: null,
    });
    const result = await getRelevantContext(sb.client, "bun");
    expect(result).toBe(
      "RELEVANT PAST MESSAGES:\n[user]: How do I use Bun?\n[assistant]: Bun is a JS runtime..."
    );
  });

  it("invokes the search edge function with correct params", async () => {
    const sb = mockSupabase();
    sb.setFunctionsResult({ data: [], error: null });
    await getRelevantContext(sb.client, "my query");
    expect(sb.client.functions.invoke).toHaveBeenCalledWith("search", {
      body: { query: "my query", match_count: 5, table: "messages" },
    });
  });
});
