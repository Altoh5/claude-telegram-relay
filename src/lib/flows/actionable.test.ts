import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockCreateTask = mock(async () => ({ id: "task-abc" }));
const mockUpdateTask = mock(async () => {});
const mockSendTelegramMessage = mock(async () => {});

mock.module("../supabase", () => ({
  createTask: mockCreateTask,
  updateTask: mockUpdateTask,
}));
mock.module("../telegram", () => ({
  sendTelegramMessage: mockSendTelegramMessage,
}));

const { triggerActionableFlow } = await import("./actionable");

describe("triggerActionableFlow", () => {
  beforeEach(() => {
    mockCreateTask.mockClear();
    mockUpdateTask.mockClear();
    mockSendTelegramMessage.mockClear();
  });

  it("creates a task with correct metadata", async () => {
    await triggerActionableFlow({
      botToken: "tok",
      chatId: "123",
      subject: "Budget approval",
      senderName: "Rishi",
      summary: "Approve Q2 budget SGD 4200",
      messageId: "msg-1",
    });
    expect(mockCreateTask).toHaveBeenCalledWith("123", "Email action: Budget approval");
    expect(mockUpdateTask).toHaveBeenCalledWith("task-abc", expect.objectContaining({
      status: "pending",
      metadata: expect.objectContaining({ type: "email_task", subject: "Budget approval" }),
    }));
  });

  it("sends Telegram message with Make Task / Add to Calendar / Ignore buttons", async () => {
    await triggerActionableFlow({
      botToken: "tok",
      chatId: "123",
      subject: "Test",
      senderName: "Rishi",
      summary: "A summary",
      messageId: "msg-2",
    });
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    const [, , text, opts] = mockSendTelegramMessage.mock.calls[0] as any[];
    expect(text).toContain("Rishi");
    const buttons = opts.buttons.flat().map((b: any) => b.text);
    expect(buttons).toContain("Make Task");
    expect(buttons).toContain("Add to Calendar");
    expect(buttons).toContain("Ignore");
  });

  it("returns early without sending if createTask returns null", async () => {
    mockCreateTask.mockResolvedValueOnce(null as any);
    await triggerActionableFlow({
      botToken: "tok", chatId: "123", subject: "X", senderName: "Y", summary: "Z", messageId: "m",
    });
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });
});
