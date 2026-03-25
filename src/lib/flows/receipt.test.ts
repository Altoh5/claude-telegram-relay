import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockSendTelegram = mock(async () => ({ ok: true, result: { message_id: 1 } }));
mock.module("../telegram", () => ({ sendTelegramMessage: mockSendTelegram }));

const mockCreateTask = mock(async () => ({ id: "task-1" }));
const mockUpdateTask = mock(async () => true);
mock.module("../supabase", () => ({
  createTask: mockCreateTask,
  updateTask: mockUpdateTask,
}));

const mockFetch = mock(async () => ({ ok: true, json: async () => ({}) }));
globalThis.fetch = mockFetch as any;

const { formatExpenseMessage, buildReceiptForwardText } = await import("./receipt");

describe("formatExpenseMessage", () => {
  it("formats expense with all fields", () => {
    const result = formatExpenseMessage({
      vendor: "Grab",
      amount: 12.5,
      currency: "SGD",
      date: "2026-03-24",
      purpose: "Client lunch",
      with_person: "Rishi",
    });
    expect(result).toBe("[Expense] SGD 12.50 — Grab | For: Client lunch | With: Rishi | Date: 2026-03-24");
  });
});

describe("buildReceiptForwardText", () => {
  it("includes image path marker when photo-triggered", () => {
    const result = buildReceiptForwardText({
      vendor: "FairPrice", amount: 23.4, currency: "SGD",
      date: "2026-03-24", purpose: "Groceries", with_person: "self",
    }, "/tmp/photo.jpg");
    expect(result).toContain("[Photo attached]");
  });

  it("omits image marker for email-triggered receipts", () => {
    const result = buildReceiptForwardText({
      vendor: "Grab", amount: 5, currency: "SGD",
      date: "2026-03-24", purpose: "Ride", with_person: "self",
    });
    expect(result).not.toContain("[Photo attached]");
  });
});

describe("startReceiptFlow", () => {
  beforeEach(() => {
    mockCreateTask.mockClear();
    mockUpdateTask.mockClear();
    mockSendTelegram.mockClear();
  });

  it("creates task with needs_input status and receipt_pending type", async () => {
    const { startReceiptFlow } = await import("./receipt");
    await startReceiptFlow({
      botToken: "tok", chatId: "123",
      vendor: "Grab", amount: 12.5, currency: "SGD", date: "2026-03-24",
    });
    expect(mockCreateTask).toHaveBeenCalledWith("123", expect.stringContaining("Grab"));
    expect(mockUpdateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({
      status: "needs_input",
      metadata: expect.objectContaining({ type: "receipt_pending", vendor: "Grab" }),
    }));
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
  });

  it("returns early without sending if createTask returns null", async () => {
    mockCreateTask.mockResolvedValueOnce(null as any);
    const { startReceiptFlow } = await import("./receipt");
    await startReceiptFlow({ botToken: "tok", chatId: "123", vendor: "", amount: 0, currency: "SGD", date: "2026-03-24" });
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });
});

describe("completeReceiptFlow", () => {
  beforeEach(() => {
    mockUpdateTask.mockClear();
    mockFetch.mockClear();
  });

  it("stores forward_text and sends ph:copy button", async () => {
    const { completeReceiptFlow } = await import("./receipt");
    await completeReceiptFlow({
      botToken: "tok", chatId: "123", taskId: "task-1",
      vendor: "Grab", amount: 12.5, currency: "SGD", date: "2026-03-24",
      purpose: "Client lunch", with_person: "Rishi",
    });
    expect(mockUpdateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({
      status: "completed",
      metadata: expect.objectContaining({ forward_text: expect.stringContaining("[Expense]") }),
    }));
    // Verify ph:copy:task-1 button was sent
    const fetchCall = mockFetch.mock.calls[0] as any[];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe("ph:copy:task-1");
  });
});
