import { sendTelegramMessage } from "../telegram";
import { createTask, updateTask } from "../supabase";

export async function triggerActionableFlow(opts: {
  botToken: string;
  chatId: string;
  subject: string;
  senderName: string;
  summary: string;
  messageId: string;
}): Promise<void> {
  const { botToken, chatId, subject, senderName, summary, messageId } = opts;

  const task = await createTask(chatId, `Email action: ${subject}`);
  if (!task) return;

  await updateTask(task.id, {
    status: "pending",
    metadata: { type: "email_task", subject, sender: senderName, summary, source_email_id: messageId },
  });

  const buttons = [
    [
      { text: "Make Task", callback_data: `gm:task:${task.id}` },
      { text: "Add to Calendar", callback_data: `gm:cal:${task.id}` },
      { text: "Ignore", callback_data: `gm:ign:${task.id}` },
    ],
  ];

  const msg = `📧 *Email from ${senderName}*\n\n${summary}`;

  await sendTelegramMessage(botToken, chatId, msg, {
    parseMode: "Markdown",
    buttons,
  });
}
