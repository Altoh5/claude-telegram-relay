import { sendTelegramMessage } from "../telegram";
import { createTask, updateTask } from "../supabase";

export interface ReceiptData {
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  purpose?: string;
  with_person?: string;
}

export function formatExpenseMessage(data: ReceiptData & { purpose: string; with_person: string }): string {
  const amt = `${data.currency} ${data.amount.toFixed(2)}`;
  return `[Expense] ${amt} — ${data.vendor} | For: ${data.purpose} | With: ${data.with_person} | Date: ${data.date}`;
}

export function buildReceiptForwardText(
  data: ReceiptData & { purpose: string; with_person: string },
  imagePath?: string
): string {
  let text = formatExpenseMessage(data);
  if (imagePath) text += "\n[Photo attached]";
  return text;
}

/**
 * Initiates the receipt HITL flow.
 * Sends "Receipt detected" message and creates async_tasks row awaiting user reply.
 */
export async function startReceiptFlow(opts: {
  botToken: string;
  chatId: string;
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  imagePath?: string;
}): Promise<void> {
  const { botToken, chatId, vendor, amount, currency, date, imagePath } = opts;

  const desc = vendor
    ? `Receipt from ${vendor} (${currency} ${amount.toFixed(2)}) — what's this for, and who's it with?`
    : "Receipt detected — what's this for, and who's it with?";

  const task = await createTask(chatId, desc);
  if (!task) return;

  await updateTask(task.id, {
    status: "needs_input",
    metadata: {
      type: "receipt_pending",
      vendor,
      amount,
      currency,
      date,
      image_path: imagePath ?? null,
    },
  });

  await sendTelegramMessage(botToken, chatId, desc);
}

/**
 * Completes the receipt flow after the user has replied.
 * Called from bot.ts when a needs_input receipt_pending task exists for this chat.
 */
export async function completeReceiptFlow(opts: {
  botToken: string;
  chatId: string;
  taskId: string;
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  purpose: string;
  with_person: string;
  imagePath?: string;
}): Promise<void> {
  const { botToken, chatId, taskId, imagePath, ...data } = opts;

  const forwardText = buildReceiptForwardText(
    { ...data, purpose: data.purpose, with_person: data.with_person },
    imagePath
  );

  // Store forward_text in metadata so the ph:copy: callback can retrieve it
  await updateTask(taskId, { status: "completed", metadata: { forward_text: forwardText } });

  // Send forward-ready message with inline button (using direct fetch — background context)
  const keyboard = {
    inline_keyboard: [[{ text: "📋 Copy Message for Honey", callback_data: `ph:copy:${taskId}` }]],
  };
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `✅ Expense logged. Tap the button to get the forward-ready text.`,
      reply_markup: keyboard,
    }),
  });
}
