import { describe, it, expect, mock } from "bun:test";
import { buildPrompt, sendResponse } from "./relay-helpers.ts";

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
    // Create a message longer than 4000 chars
    const longMessage = "A".repeat(4500);
    await sendResponse(ctx as any, longMessage);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    // All content should be preserved
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
