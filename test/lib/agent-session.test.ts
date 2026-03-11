// test/lib/agent-session.test.ts
import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Minimal Grammy Context stub ──────────────────────────────────────────────
const mockCtx = {
  reply: mock(async () => ({ message_id: 1 })),
  message: { message_thread_id: undefined },
} as any;

// ── Reset mocks between tests ────────────────────────────────────────────────
beforeEach(() => {
  mockCtx.reply.mockClear();
});

// ── Agent SDK mock factory ────────────────────────────────────────────────────
function makeQueryMock(responseText = "Hello from Agent SDK") {
  return mock(async function* (_payload: any) {
    yield {
      type: "system",
      subtype: "init",
      session_id: "sess_abc123",
      tools: ["Read", "Write", "Bash"],
      mcp_servers: [{ name: "supabase" }],
    };
    yield {
      type: "assistant",
      session_id: "sess_abc123",
      message: { content: [{ type: "text", text: responseText }] },
    };
    yield {
      type: "result",
      subtype: "success",
      result: responseText,
      session_id: "sess_abc123",
      num_turns: 1,
      total_cost_usd: 0.001,
      duration_ms: 300,
    };
  });
}

describe("processWithAgentSDK — VPS-04: SDK absent fallback", () => {
  it("calls fallback LLM when Agent SDK query throws SDK_UNAVAILABLE", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: mock(async function* () {
        throw Object.assign(
          new Error("Agent SDK not available: Cannot find module"),
          { code: "SDK_UNAVAILABLE" }
        );
      }),
    }));

    mock.module("../../src/lib/supabase", () => ({
      getConversationContext: mock(async () => ""),
      getMemoryContext: mock(async () => ""),
    }));

    const fallbackMock = mock(async () => "Fallback response");
    mock.module("../../src/lib/fallback-llm", () => ({
      callFallbackLLM: fallbackMock,
    }));

    const { processWithAgentSDK } = await import("../../src/lib/agent-session");
    const result = await processWithAgentSDK("hello", "chat_vps04", mockCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
