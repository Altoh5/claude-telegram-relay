/**
 * Bot Registry — Multi-Bot Agent Identity
 *
 * Maps agent names to individual Grammy Bot instances.
 * Agent bots are outbound-only (no polling/webhook) — they just send messages.
 * Falls back to primary bot if no token is configured for an agent.
 */

import { Bot } from "grammy";

/** Env var mapping: agent name → env var suffix */
const AGENT_TOKEN_MAP: Record<string, string> = {
  research: "TELEGRAM_BOT_TOKEN_RESEARCH",
  content: "TELEGRAM_BOT_TOKEN_CONTENT",
  finance: "TELEGRAM_BOT_TOKEN_FINANCE",
  strategy: "TELEGRAM_BOT_TOKEN_STRATEGY",
  critic: "TELEGRAM_BOT_TOKEN_CRITIC",
  cto: "TELEGRAM_BOT_TOKEN_CTO",
  coo: "TELEGRAM_BOT_TOKEN_COO",
};

/** Alias resolution: alternative names → canonical agent name */
const AGENT_ALIASES: Record<string, string> = {
  ceo: "strategy",
  cfo: "finance",
  cmo: "content",
  researcher: "research",
  "devils-advocate": "critic",
  dev: "cto",
  development: "cto",
  ops: "coo",
  operations: "coo",
};

export class BotRegistry {
  private primary: Bot;
  private bots: Map<string, Bot> = new Map();

  constructor(primaryBot: Bot) {
    this.primary = primaryBot;
  }

  /**
   * Initialize agent bots from env vars.
   * Creates Bot instances and calls bot.init() (no bot.start() — outbound only).
   */
  async initialize(): Promise<void> {
    const initPromises: Promise<void>[] = [];

    for (const [agent, envVar] of Object.entries(AGENT_TOKEN_MAP)) {
      const token = process.env[envVar];
      if (!token) continue;

      const agentBot = new Bot(token);
      initPromises.push(
        agentBot
          .init()
          .then(() => {
            this.bots.set(agent, agentBot);
            console.log(
              `[BotRegistry] ${agent} bot initialized: @${agentBot.botInfo.username}`
            );
          })
          .catch((err) => {
            console.error(
              `[BotRegistry] Failed to init ${agent} bot: ${err.message}`
            );
          })
      );
    }

    await Promise.all(initPromises);
    console.log(
      `[BotRegistry] ${this.bots.size} agent bot(s) ready, primary bot as fallback`
    );
  }

  /** Resolve agent name (handles aliases) and return the Bot instance. */
  resolve(agentName: string): Bot {
    const canonical = AGENT_ALIASES[agentName.toLowerCase()] || agentName.toLowerCase();
    return this.bots.get(canonical) || this.primary;
  }

  /** Check if a dedicated bot exists for this agent. */
  hasBot(agentName: string): boolean {
    const canonical = AGENT_ALIASES[agentName.toLowerCase()] || agentName.toLowerCase();
    return this.bots.has(canonical);
  }

  /**
   * Send a message as a specific agent's bot.
   * Handles Telegram's 4096 char limit by chunking at paragraph boundaries.
   */
  async sendAsAgent(
    agentName: string,
    chatId: string | number,
    text: string,
    options?: { threadId?: number }
  ): Promise<void> {
    const agentBot = this.resolve(agentName);

    // Convert **bold** to Telegram *bold*
    text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");

    const MAX_LENGTH = 4000;
    const chunks = this.chunkText(text, MAX_LENGTH);

    for (const chunk of chunks) {
      const params: Record<string, any> = {
        parse_mode: "Markdown" as const,
      };
      if (options?.threadId) {
        params.message_thread_id = options.threadId;
      }
      try {
        await agentBot.api.sendMessage(chatId, chunk, params);
      } catch {
        // Retry without markdown on parse errors
        try {
          const plain = chunk.replace(/\*/g, "").replace(/_/g, "");
          const plainParams: Record<string, any> = {};
          if (options?.threadId) {
            plainParams.message_thread_id = options.threadId;
          }
          await agentBot.api.sendMessage(chatId, plain, plainParams);
        } catch (err) {
          console.error(
            `[BotRegistry] Failed to send as ${agentName}:`,
            err
          );
        }
      }
    }
  }

  /** Send typing indicator from agent's bot. */
  async sendTypingAsAgent(
    agentName: string,
    chatId: string | number,
    threadId?: number
  ): Promise<void> {
    const agentBot = this.resolve(agentName);
    try {
      const params: Record<string, any> = {
        action: "typing" as const,
      };
      if (threadId) {
        params.message_thread_id = threadId;
      }
      await agentBot.api.sendChatAction(chatId, "typing", params);
    } catch {
      // Typing indicator failures are non-critical
    }
  }

  /** Send a message with an inline keyboard as a specific agent. */
  async sendWithKeyboardAsAgent(
    agentName: string,
    chatId: string | number,
    text: string,
    keyboard: any,
    options?: { threadId?: number }
  ): Promise<void> {
    const agentBot = this.resolve(agentName);
    text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");

    const params: Record<string, any> = {
      reply_markup: keyboard,
      parse_mode: "Markdown" as const,
    };
    if (options?.threadId) {
      params.message_thread_id = options.threadId;
    }
    try {
      await agentBot.api.sendMessage(chatId, text, params);
    } catch {
      try {
        const plain = text.replace(/\*/g, "").replace(/_/g, "");
        params.parse_mode = undefined;
        await agentBot.api.sendMessage(chatId, plain, params);
      } catch (err) {
        console.error(
          `[BotRegistry] Failed to send keyboard as ${agentName}:`,
          err
        );
      }
    }
  }

  /** Split text into chunks at paragraph boundaries. */
  private chunkText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let current = "";
    for (const paragraph of text.split("\n\n")) {
      if ((current + "\n\n" + paragraph).length > maxLength) {
        if (current) chunks.push(current);
        current = paragraph;
      } else {
        current = current ? current + "\n\n" + paragraph : paragraph;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }
}
