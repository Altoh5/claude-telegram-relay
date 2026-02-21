/**
 * Go - Telegram Helpers
 *
 * Send messages, sanitize markdown, manage typing indicators.
 */

import { Context, InputFile } from "grammy";

/**
 * Sanitize text for Telegram's strict Markdown parser.
 * Removes problematic formatting that causes API errors.
 */
export function sanitizeForTelegram(text: string): string {
  let result = text;

  // Remove markdown links (keep text only)
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove code blocks
  result = result.replace(/`{3,}[^\n]*\n?/g, "");
  result = result.replace(/`/g, "'");

  // Remove HTML-like tags
  result = result.replace(/<[^>]+>/g, "");

  // Handle underscores (italic in Telegram Markdown)
  result = result.replace(/_([^_\n]+)_/g, "$1");
  result = result.replace(/(?<![a-zA-Z0-9])_(?![a-zA-Z0-9])/g, "");

  // Ensure bold markers are balanced
  const boldCount = (result.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) {
    result = result.replace(/\*\*/g, "");
  }

  // Remove triple+ asterisks
  result = result.replace(/\*{3,}/g, "**");

  // Clean up whitespace
  result = result.replace(/  +/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}

/**
 * Send a message via Telegram Bot API (direct fetch, no grammy).
 * Useful for services that don't run the bot (check-in, briefing).
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  message: string,
  options?: {
    parseMode?: "Markdown" | "HTML";
    buttons?: { text: string; callback_data: string }[][];
    messageThreadId?: number;
  }
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: options?.parseMode ? sanitizeForTelegram(message) : message,
  };

  if (options?.messageThreadId) {
    body.message_thread_id = options.messageThreadId;
  }

  if (options?.parseMode) {
    body.parse_mode = options.parseMode;
  }

  if (options?.buttons && options.buttons.length > 0) {
    body.reply_markup = { inline_keyboard: options.buttons };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Retry without formatting on parse errors
      if (response.status === 400 && options?.parseMode) {
        const fallback = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message.replace(/\*/g, "").replace(/_/g, ""),
            reply_markup: body.reply_markup,
          }),
        });
        return fallback.ok;
      }
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Send a long response, splitting into chunks if needed.
 * Telegram has a 4096 character limit per message.
 */
export async function sendResponse(
  ctx: Context,
  text: string,
  wantsVoice?: boolean,
  voiceFn?: (text: string) => Promise<Buffer | null>
): Promise<void> {
  // Convert standard markdown bold (**bold**) to Telegram markdown bold (*bold*)
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Send voice if requested and voice function provided
  if (wantsVoice && voiceFn) {
    const audioBuffer = await voiceFn(text);
    if (audioBuffer) {
      await ctx.replyWithVoice(new InputFile(audioBuffer, "response.wav"));
      return;
    }
  }

  // Check for embedded image tags: [IMAGE:/path/to/file.png|Optional caption]
  const imageMatch = text.match(/\[IMAGE:([^\]|]+)(?:\|([^\]]+))?\]/);
  if (imageMatch) {
    const imagePath = imageMatch[1].trim();
    const caption = imageMatch[2]?.trim();
    const cleanText = text.replace(imageMatch[0], "").trim();

    try {
      await ctx.replyWithPhoto(new InputFile(imagePath), {
        caption: caption || undefined,
      });
    } catch {
      // Image send failed, continue with text
    }

    if (cleanText) {
      text = cleanText;
    } else {
      return;
    }
  }

  // Split long messages
  const MAX_LENGTH = 4000;
  if (text.length <= MAX_LENGTH) {
    await ctx
      .reply(text, { parse_mode: "Markdown" })
      .catch(() => ctx.reply(text));
    return;
  }

  // Split at paragraph boundaries
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split("\n\n")) {
    if ((current + "\n\n" + paragraph).length > MAX_LENGTH) {
      if (current) chunks.push(current);
      current = paragraph;
    } else {
      current = current ? current + "\n\n" + paragraph : paragraph;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await ctx
      .reply(chunk, { parse_mode: "Markdown" })
      .catch(() => ctx.reply(chunk));
  }
}

/**
 * Manage periodic typing indicator (Telegram expires after ~5s).
 */
export function createTypingIndicator(ctx: Context) {
  let interval: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      ctx.replyWithChatAction("typing").catch(() => {});
      interval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
