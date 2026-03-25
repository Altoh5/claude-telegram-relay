import { sendTelegramMessage } from "../telegram";
import { createTask, updateTask } from "../supabase";

export async function triggerPaymentReminderFlow(opts: {
  botToken: string;
  chatId: string;
  service: string;
  amount: number;
  currency: string;
  dueDate: string;
  messageId: string;
}): Promise<void> {
  const { botToken, chatId, service, amount, currency, dueDate, messageId } = opts;

  const task = await createTask(chatId, `Payment reminder: ${service}`);
  if (!task) return;

  await updateTask(task.id, {
    status: "pending",
    metadata: { type: "email_task", service, amount, currency, due_date: dueDate, source_email_id: messageId },
  });

  const dueLine = dueDate ? ` due ${dueDate}` : "";
  const amtLine = amount > 0 ? ` — ${currency} ${amount.toFixed(2)}` : "";

  const buttons = [
    [
      { text: "Make Task", callback_data: `gm:task:${task.id}` },
      { text: "Ignore", callback_data: `gm:ign:${task.id}` },
    ],
  ];

  const msg = `💳 *Payment reminder*: ${service}${amtLine}${dueLine}`;

  await sendTelegramMessage(botToken, chatId, msg, {
    parseMode: "Markdown",
    buttons,
  });
}
