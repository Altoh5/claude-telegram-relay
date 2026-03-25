import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockCreateTask = mock(async () => ({ id: "task-pay" }));
const mockUpdateTask = mock(async () => {});
const mockSendTelegramMessage = mock(async () => {});

mock.module("../supabase", () => ({
  createTask: mockCreateTask,
  updateTask: mockUpdateTask,
}));
mock.module("../telegram", () => ({
  sendTelegramMessage: mockSendTelegramMessage,
}));

const { triggerPaymentReminderFlow } = await import("./payment-reminder");

describe("triggerPaymentReminderFlow", () => {
  beforeEach(() => {
    mockCreateTask.mockClear();
    mockUpdateTask.mockClear();
    mockSendTelegramMessage.mockClear();
  });

  it("creates a task with payment metadata", async () => {
    await triggerPaymentReminderFlow({
      botToken: "tok",
      chatId: "123",
      service: "Canva Pro",
      amount: 17.9,
      currency: "SGD",
      dueDate: "2026-03-28",
      messageId: "msg-pay",
    });
    expect(mockCreateTask).toHaveBeenCalledWith("123", "Payment reminder: Canva Pro");
    expect(mockUpdateTask).toHaveBeenCalledWith("task-pay", expect.objectContaining({
      status: "pending",
      metadata: expect.objectContaining({ type: "email_task", service: "Canva Pro", amount: 17.9 }),
    }));
  });

  it("sends Telegram message with amount and due date", async () => {
    await triggerPaymentReminderFlow({
      botToken: "tok",
      chatId: "123",
      service: "Canva Pro",
      amount: 17.9,
      currency: "SGD",
      dueDate: "2026-03-28",
      messageId: "msg-pay",
    });
    const [, , text] = mockSendTelegramMessage.mock.calls[0] as any[];
    expect(text).toContain("Canva Pro");
    expect(text).toContain("17.90");
    expect(text).toContain("2026-03-28");
  });

  it("sends Make Task and Ignore buttons", async () => {
    await triggerPaymentReminderFlow({
      botToken: "tok", chatId: "123", service: "X", amount: 0, currency: "SGD", dueDate: "", messageId: "m",
    });
    const [, , , opts] = mockSendTelegramMessage.mock.calls[0] as any[];
    const buttons = opts.buttons.flat().map((b: any) => b.text);
    expect(buttons).toContain("Make Task");
    expect(buttons).toContain("Ignore");
  });
});
