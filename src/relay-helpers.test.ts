import { describe, it, expect, mock } from "bun:test";
import {
  buildPrompt,
  sendResponse,
  extractSessionId,
  saveMessage,
  isAuthorizedUser,
} from "./relay-helpers.ts";

// ============================================================
// buildPrompt
// ============================================================

describe("buildPrompt", () => {
  const baseOptions = {
    timeStr: "Monday, January 1, 2024, 10:00 AM",
  };

  it("includes the system instruction and user message", () => {
    const result = buildPrompt("Hello", baseOptions);
    expect(result).toContain("personal AI assistant");
    expect(result).toContain("User: Hello");
  });

  it("includes the user name when provided", () => {
    const result = buildPrompt("Hello", { ...baseOptions, userName: "Alvin" });
    expect(result).toContain("You are speaking with Alvin.");
  });

  it("omits the user name when not provided", () => {
    const result = buildPrompt("Hello", baseOptions);
    expect(result).not.toContain("You are speaking with");
  });

  it("includes the current time", () => {
    const result = buildPrompt("Hello", baseOptions);
    expect(result).toContain("Current time: Monday, January 1, 2024, 10:00 AM");
  });

  it("includes profile context when provided", () => {
    const result = buildPrompt("Hello", {
      ...baseOptions,
      profileContext: "Works as a software engineer",
    });
    expect(result).toContain("Profile:\nWorks as a software engineer");
  });

  it("includes memory context when provided", () => {
    const result = buildPrompt("Hello", {
      ...baseOptions,
      memoryContext: "User prefers dark mode",
    });
    expect(result).toContain("User prefers dark mode");
  });

  it("includes relevant context when provided", () => {
    const result = buildPrompt("Hello", {
      ...baseOptions,
      relevantContext: "Previous conversation about testing",
    });
    expect(result).toContain("Previous conversation about testing");
  });

  it("includes memory management instructions", () => {
    const result = buildPrompt("Hello", baseOptions);
    expect(result).toContain("MEMORY MANAGEMENT:");
    expect(result).toContain("[REMEMBER:");
    expect(result).toContain("[GOAL:");
    expect(result).toContain("[DONE:");
  });

  it("assembles all sections in order", () => {
    const result = buildPrompt("Hi there", {
      userName: "Alvin",
      timeStr: "Monday, January 1, 2024, 10:00 AM",
      profileContext: "Engineer",
      memoryContext: "Likes TypeScript",
      relevantContext: "Talked about Bun yesterday",
    });

    const systemIdx = result.indexOf("personal AI assistant");
    const nameIdx = result.indexOf("speaking with Alvin");
    const timeIdx = result.indexOf("Current time:");
    const profileIdx = result.indexOf("Profile:");
    const memoryIdx = result.indexOf("Likes TypeScript");
    const relevantIdx = result.indexOf("Talked about Bun");
    const userIdx = result.indexOf("User: Hi there");

    expect(systemIdx).toBeLessThan(nameIdx);
    expect(nameIdx).toBeLessThan(timeIdx);
    expect(timeIdx).toBeLessThan(profileIdx);
    expect(profileIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(relevantIdx);
    expect(relevantIdx).toBeLessThan(userIdx);
  });
});

// ============================================================
// sendResponse
// ============================================================

describe("sendResponse", () => {
  function mockCtx() {
    const replies: string[] = [];
    return {
      reply: mock(async (text: string) => {
        replies.push(text);
      }),
      replies,
    };
  }

  it("sends a short message as a single reply", async () => {
    const ctx = mockCtx();
    await sendResponse(ctx as any, "Hello!");
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.replies[0]).toBe("Hello!");
  });

  it("splits a long message into multiple chunks", async () => {
    const ctx = mockCtx();
    const longMessage = "A".repeat(4500);
    await sendResponse(ctx as any, longMessage);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(ctx.replies.join("").length).toBe(4500);
  });

  it("splits at paragraph boundaries when possible", async () => {
    const ctx = mockCtx();
    const part1 = "A".repeat(3000);
    const part2 = "B".repeat(2000);
    const longMessage = part1 + "\n\n" + part2;
    await sendResponse(ctx as any, longMessage);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(ctx.replies[0]).toBe(part1);
    expect(ctx.replies[1]).toBe(part2);
  });

  it("splits at newline if no paragraph break available", async () => {
    const ctx = mockCtx();
    const part1 = "A".repeat(3000);
    const part2 = "B".repeat(2000);
    const longMessage = part1 + "\n" + part2;
    await sendResponse(ctx as any, longMessage);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(ctx.replies[0]).toBe(part1);
    expect(ctx.replies[1]).toBe(part2);
  });

  it("splits at space if no newline available", async () => {
    const ctx = mockCtx();
    const part1 = "A".repeat(3000);
    const part2 = "B".repeat(2000);
    const longMessage = part1 + " " + part2;
    await sendResponse(ctx as any, longMessage);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(ctx.replies[0]).toBe(part1);
    expect(ctx.replies[1]).toBe(part2);
  });

  it("hard-splits if no natural boundary exists", async () => {
    const ctx = mockCtx();
    const longMessage = "A".repeat(5000);
    await sendResponse(ctx as any, longMessage);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(ctx.replies[0]).toBe("A".repeat(4000));
    expect(ctx.replies[1]).toBe("A".repeat(1000));
  });

  it("handles exactly 4000 chars without splitting", async () => {
    const ctx = mockCtx();
    const message = "A".repeat(4000);
    await sendResponse(ctx as any, message);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it("handles empty string", async () => {
    const ctx = mockCtx();
    await sendResponse(ctx as any, "");
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.replies[0]).toBe("");
  });
});

// ============================================================
// extractSessionId
// ============================================================

describe("extractSessionId", () => {
  it("extracts a valid session ID", () => {
    const output = "Some output\nSession ID: abc123-def456-789\nMore output";
    expect(extractSessionId(output)).toBe("abc123-def456-789");
  });

  it("extracts a UUID-style session ID", () => {
    const output = "Session ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(extractSessionId(output)).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("returns null when no session ID is present", () => {
    expect(extractSessionId("No session here")).toBeNull();
    expect(extractSessionId("")).toBeNull();
  });

  it("is case-insensitive", () => {
    const output = "session id: abc123-def456";
    expect(extractSessionId(output)).toBe("abc123-def456");
  });

  it("extracts only the first match", () => {
    const output = "Session ID: aaa111-bbb222\nSession ID: ccc333-ddd444";
    expect(extractSessionId(output)).toBe("aaa111-bbb222");
  });
});

// ============================================================
// saveMessage
// ============================================================

describe("saveMessage", () => {
  function mockSupabase() {
    const inserted: any[] = [];
    const client: any = {
      from: (table: string) => ({
        insert: mock(async (data: any) => {
          inserted.push({ table, data });
          return { error: null };
        }),
      }),
    };
    return { client, inserted };
  }

  it("does nothing when supabase is null", async () => {
    await saveMessage(null, "user", "hello");
    // No error thrown
  });

  it("inserts a message with correct fields", async () => {
    const sb = mockSupabase();
    await saveMessage(sb.client, "user", "hello world");
    expect(sb.inserted).toHaveLength(1);
    expect(sb.inserted[0].table).toBe("messages");
    expect(sb.inserted[0].data).toEqual({
      role: "user",
      content: "hello world",
      channel: "telegram",
      metadata: {},
    });
  });

  it("includes metadata when provided", async () => {
    const sb = mockSupabase();
    await saveMessage(sb.client, "assistant", "reply", { source: "voice" });
    expect(sb.inserted[0].data.metadata).toEqual({ source: "voice" });
  });

  it("saves assistant messages", async () => {
    const sb = mockSupabase();
    await saveMessage(sb.client, "assistant", "I can help with that");
    expect(sb.inserted[0].data.role).toBe("assistant");
    expect(sb.inserted[0].data.content).toBe("I can help with that");
  });

  it("does not throw on supabase error", async () => {
    const client: any = {
      from: () => ({
        insert: async () => {
          throw new Error("connection failed");
        },
      }),
    };
    // Should not throw
    await saveMessage(client, "user", "test");
  });
});

// ============================================================
// isAuthorizedUser
// ============================================================

describe("isAuthorizedUser", () => {
  it("returns true when no allowed user ID is set", () => {
    expect(isAuthorizedUser("12345", "")).toBe(true);
  });

  it("returns true when user ID matches", () => {
    expect(isAuthorizedUser("12345", "12345")).toBe(true);
  });

  it("returns false when user ID does not match", () => {
    expect(isAuthorizedUser("99999", "12345")).toBe(false);
  });

  it("returns false when user ID is undefined", () => {
    expect(isAuthorizedUser(undefined, "12345")).toBe(false);
  });

  it("returns true when both are empty (no restriction)", () => {
    expect(isAuthorizedUser("any-id", "")).toBe(true);
  });
});
