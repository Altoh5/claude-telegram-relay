import { sendTelegramMessage } from "../telegram";
import { createTask, updateTask } from "../supabase";

export interface ReceiptData {
  vendor: string;
  items: string;
  amount: number;
  currency: string;
  date: string;
  category?: "business" | "personal";
}

/**
 * Extract receipt details from a vision description using Claude subprocess.
 * Works without ANTHROPIC_API_KEY — uses the CLI.
 */
export async function extractReceiptData(visionDescription: string): Promise<ReceiptData> {
  const { callClaude } = await import("../claude");

  const prompt = `Extract receipt details from this image description. Reply with ONLY valid JSON, no markdown fences.

Image description: ${visionDescription}

Schema:
{
  "vendor": "store/restaurant name",
  "items": "comma-separated list of items or a brief description",
  "amount": 0.00,
  "currency": "SGD",
  "date": "YYYY-MM-DD"
}

Rules:
- If vendor is unclear, use "Unknown"
- If items aren't visible, use "Not specified"
- If amount isn't visible, use 0
- Default currency to SGD unless another currency is clearly shown
- Default date to today (${new Date().toISOString().slice(0, 10)}) unless visible on receipt`;

  try {
    const result = await callClaude({ prompt, timeoutMs: 30_000 });
    if (result.isError) throw new Error(result.text.slice(0, 200));

    const jsonStr = result.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(jsonStr);

    return {
      vendor: parsed.vendor || "Unknown",
      items: parsed.items || "Not specified",
      amount: typeof parsed.amount === "number" ? parsed.amount : 0,
      currency: parsed.currency || "SGD",
      date: parsed.date || new Date().toISOString().slice(0, 10),
    };
  } catch (err) {
    console.warn("[receipt] Extraction failed:", err);
    return {
      vendor: "Unknown",
      items: "Not specified",
      amount: 0,
      currency: "SGD",
      date: new Date().toISOString().slice(0, 10),
    };
  }
}

/**
 * Start the receipt HITL flow.
 * Shows extracted details and asks user to classify as Business or Personal.
 */
export async function startReceiptFlow(opts: {
  botToken: string;
  chatId: string;
  vendor: string;
  items: string;
  amount: number;
  currency: string;
  date: string;
  imagePath?: string;
}): Promise<void> {
  const { botToken, chatId, vendor, items, amount, currency, date, imagePath } = opts;

  const amtStr = amount > 0 ? `${currency} ${amount.toFixed(2)}` : "Amount not detected";
  const desc = [
    `Receipt from ${vendor}`,
    `Items: ${items}`,
    `Total: ${amtStr}`,
    `Date: ${date}`,
  ].join("\n");

  const task = await createTask(chatId, desc);
  if (!task) return;

  await updateTask(task.id, {
    status: "needs_input",
    metadata: {
      type: "receipt_classify",
      vendor,
      items,
      amount,
      currency,
      date,
      image_path: imagePath ?? null,
    },
  });

  const keyboard = {
    inline_keyboard: [[
      { text: "Business", callback_data: `rcpt:biz:${task.id}` },
      { text: "Personal", callback_data: `rcpt:personal:${task.id}` },
    ]],
  };

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🧾 *Receipt Detected*\n\n*${vendor}*\nItems: ${items}\nTotal: ${amtStr}\nDate: ${date}\n\nClassify this expense:`,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }),
  });
}

/**
 * Complete the receipt flow after Business/Personal classification.
 */
export async function classifyReceipt(opts: {
  botToken: string;
  chatId: string;
  taskId: string;
  category: "business" | "personal";
}): Promise<void> {
  const { botToken, chatId, taskId, category } = opts;

  // Retrieve task metadata
  const { getSupabase } = await import("../supabase");
  const sb = getSupabase();
  if (!sb) return;

  const { data: task } = await sb
    .from("async_tasks")
    .select("metadata")
    .eq("id", taskId)
    .single();

  if (!task?.metadata) return;

  const { vendor, items, amount, currency, date } = task.metadata;
  const amtStr = amount > 0 ? `${currency} ${amount.toFixed(2)}` : "Unknown amount";
  const label = category === "business" ? "Business" : "Personal";

  // Store as memory fact
  const factContent = `[Receipt] ${amtStr} — ${vendor} | Items: ${items} | ${label} | ${date}`;
  try {
    const { addFact } = await import("../memory");
    await addFact(factContent);
  } catch (err) {
    console.warn("[receipt] Memory save failed:", err);
  }

  // Mark task completed
  await updateTask(taskId, {
    status: "completed",
    metadata: { ...task.metadata, category, fact: factContent },
  });

  await sendTelegramMessage(
    botToken,
    chatId,
    `✅ *${label} expense saved*\n${amtStr} — ${vendor}\nItems: ${items}`,
    { parseMode: "Markdown" }
  );
}
