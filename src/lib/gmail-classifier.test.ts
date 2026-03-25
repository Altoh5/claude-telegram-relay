import { describe, it, expect, mock } from "bun:test";

// We mock the Anthropic call so tests don't cost tokens
const mockAnthropicCreate = mock(async (args: any) => ({
  content: [{ type: "text", text: "receipt" }],
}));

mock.module("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockAnthropicCreate };
  },
}));

const { classifyEmail } = await import("./gmail-classifier");

describe("classifyEmail", () => {
  it("returns classification from Haiku response", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "receipt" }],
    });
    const result = await classifyEmail({
      subject: "Your receipt from Grab",
      sender: "receipts@grab.com",
      snippet: "SGD 12.50 charged on 24 Mar",
    });
    expect(result).toBe("receipt");
  });

  it("returns ignore for unrecognised response", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "unknown_garbage" }],
    });
    const result = await classifyEmail({
      subject: "Weekly digest",
      sender: "newsletter@example.com",
      snippet: "Top stories this week",
    });
    expect(result).toBe("ignore");
  });
});

describe("isNccSender", () => {
  it("matches New Creation Church domain", async () => {
    const { isNccSender } = await import("./gmail-classifier");
    expect(isNccSender("announcements@newcreation.org.sg")).toBe(true);
    expect(isNccSender("Noah <noah@ncc.org.sg>")).toBe(true);
    expect(isNccSender("random@gmail.com")).toBe(false);
  });
});

describe("extractReceiptDetails", () => {
  it("parses valid JSON from model response", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ vendor: "Grab", amount: 12.5, currency: "SGD", date: "2026-03-24" }) }],
    });
    const { extractReceiptDetails } = await import("./gmail-classifier");
    const result = await extractReceiptDetails("Your Grab receipt", "body text");
    expect(result.vendor).toBe("Grab");
    expect(result.amount).toBe(12.5);
    expect(result.currency).toBe("SGD");
  });

  it("returns fallback on JSON parse failure", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "not valid json at all" }],
    });
    const { extractReceiptDetails } = await import("./gmail-classifier");
    const result = await extractReceiptDetails("Subject fallback", "body");
    expect(result.vendor).toBe("Subject fallback"); // falls back to subject
    expect(result.currency).toBe("SGD");
  });
});

describe("extractSermonDetails", () => {
  it("returns subject as title and truncated body (no API call)", async () => {
    const { extractSermonDetails } = await import("./gmail-classifier");
    const result = await extractSermonDetails("Easter Sunday sermon", "a".repeat(20000));
    expect(result.title).toBe("Easter Sunday sermon");
    expect(result.body.length).toBe(10000); // truncated
  });
});
