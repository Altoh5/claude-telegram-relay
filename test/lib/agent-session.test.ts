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

describe("processWithAgentSDK — VPS-03: session resume", () => {
  it("falls back to fresh session when resume session ID is stale", async () => {
    let callCount = 0;
    const resumeQuery = mock(async function* (payload: any) {
      callCount++;
      if (payload.options?.resume) {
        throw new Error("Session not found: sess_stale_999");
      }
      yield {
        type: "system", subtype: "init",
        session_id: "sess_fresh_001", tools: [], mcp_servers: [],
      };
      yield {
        type: "result", subtype: "success", result: "Fresh response",
        session_id: "sess_fresh_001", num_turns: 1,
        total_cost_usd: 0.0005, duration_ms: 200,
      };
    });

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({ query: resumeQuery }));
    mock.module("../../src/lib/supabase", () => ({
      getConversationContext: mock(async () => ""),
      getMemoryContext: mock(async () => ""),
      createTask: mock(async () => null),
      updateTask: mock(async () => {}),
    }));

    const { processWithAgentSDK } = await import("../../src/lib/agent-session");
    const resumeState = {
      taskId: "task_1",
      sessionId: "sess_stale_999",
      userChoice: "Yes",
      originalPrompt: "original message",
    };

    const result = await processWithAgentSDK(
      "original message", "chat_vps03", mockCtx, resumeState
    );
    expect(result).toBe("Fresh response");
    expect(callCount).toBe(2);
  });
});

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
