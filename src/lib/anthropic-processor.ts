/**
 * Anthropic API Processor — Direct API for VPS mode
 *
 * Uses Anthropic Messages API with client-side tool definitions.
 * VPS mode processes messages when the local machine is offline.
 *
 * Tools: Ask User (human-in-the-loop), Phone Call
 */

import Anthropic from "@anthropic-ai/sdk";
import * as supabase from "./supabase";
import { initiatePhoneCall } from "./voice";
import { buildTaskKeyboard } from "./task-queue";
import type { Context } from "grammy";

// ============================================================
// ASK USER SIGNAL -- thrown when Claude needs user input
// ============================================================

export class AskUserSignal {
  question: string;
  options: { label: string; value: string }[];
  toolUseId: string;
  messages: Anthropic.MessageParam[];
  assistantContent: Anthropic.ContentBlock[];

  constructor(
    question: string,
    options: { label: string; value: string }[],
    toolUseId: string,
    messages: Anthropic.MessageParam[],
    assistantContent: Anthropic.ContentBlock[]
  ) {
    this.question = question;
    this.options = options;
    this.toolUseId = toolUseId;
    this.messages = messages;
    this.assistantContent = assistantContent;
  }
}

// ============================================================
// RESUME STATE -- passed when continuing from ask_user pause
// ============================================================

export interface ResumeState {
  taskId: string;
  messagesSnapshot: Anthropic.MessageParam[];
  assistantContent: Anthropic.ContentBlock[];
  userChoice: string;
  toolUseId: string;
}

// ============================================================
// ANTHROPIC CLIENT
// ============================================================

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

// ============================================================
// TOOL DEFINITIONS
// ============================================================

function buildToolDefinitions(): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    {
      name: "phone_call",
      description:
        "Initiate a phone call via ElevenLabs voice agent. Use when user says 'call me', 'ring me', or wants a voice conversation. Provide context about what to discuss.",
      input_schema: {
        type: "object" as const,
        properties: {
          context: {
            type: "string",
            description:
              "Context/reason for the call. What should be discussed on the call.",
          },
        },
        required: ["context"],
      },
    },
    {
      name: "ask_user",
      description:
        "Ask the user a question and wait for their response before continuing. Use this when you need confirmation before taking a significant action or when you need the user to choose between options. The conversation will pause until the user responds via Telegram buttons.",
      input_schema: {
        type: "object" as const,
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Button label shown to user (max 64 chars)",
                },
                value: {
                  type: "string",
                  description:
                    "Value returned when user clicks this option",
                },
              },
              required: ["label", "value"],
            },
            description:
              "Array of options for the user to choose from. Defaults to Yes/No if not provided.",
          },
        },
        required: ["question"],
      },
    },
  ];

  // Only include tools that have their dependencies configured
  return tools.filter((tool) => {
    switch (tool.name) {
      case "phone_call":
        return !!(
          process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID
        );
      case "ask_user":
        return true; // Always available
      default:
        return true;
    }
  });
}

// ============================================================
// TOOL EXECUTOR
// ============================================================

async function executeTool(
  name: string,
  input: Record<string, any>,
  toolUseId: string,
  messages: Anthropic.MessageParam[],
  assistantContent: Anthropic.ContentBlock[],
  onCallInitiated?: (conversationId: string) => void
): Promise<string> {
  try {
    switch (name) {
      case "phone_call": {
        const result = await initiatePhoneCall(input.context);
        if (result.success && result.conversationId && onCallInitiated) {
          onCallInitiated(result.conversationId);
        }
        return JSON.stringify(result);
      }

      case "ask_user": {
        const options: { label: string; value: string }[] = input.options || [
          { label: "Yes, go ahead", value: "yes" },
          { label: "No, skip", value: "no" },
        ];
        // Throw signal to pause the loop
        throw new AskUserSignal(
          input.question,
          options,
          toolUseId,
          messages,
          assistantContent
        );
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    // Re-throw AskUserSignal -- it's not an error
    if (err instanceof AskUserSignal) throw err;

    console.error(`Tool ${name} error:`, err.message);
    return JSON.stringify({ error: err.message });
  }
}

// ============================================================
// MESSAGE COMPRESSION -- truncate tool results before storing
// ============================================================

function compressMessages(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { ...msg, content: msg.content.substring(0, 2000) };
    }
    if (Array.isArray(msg.content)) {
      const compressed = msg.content.map((block: any) => {
        if (
          block.type === "tool_result" &&
          typeof block.content === "string"
        ) {
          return { ...block, content: block.content.substring(0, 500) };
        }
        if (block.type === "text" && typeof block.text === "string") {
          return { ...block, text: block.text.substring(0, 2000) };
        }
        return block;
      });
      return { ...msg, content: compressed };
    }
    return msg;
  });
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(): string {
  const userName = process.env.USER_NAME || "User";
  const userTimezone = process.env.USER_TIMEZONE || "UTC";
  const botName = process.env.BOT_NAME || "Assistant";

  const now = new Date();
  const localTime = now.toLocaleString("en-US", {
    timeZone: userTimezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `You are ${botName}, ${userName}'s AI assistant, responding via Telegram.

Current time: ${localTime} (${userTimezone})
Processing node: VPS (local machine may be offline)

AVAILABLE TOOLS:
- ask_user: Ask the user a question via inline buttons. Use BEFORE any irreversible action.
${process.env.ELEVENLABS_API_KEY ? "- phone_call: Initiate a voice call via ElevenLabs" : ""}

HUMAN-IN-THE-LOOP (CRITICAL):
- Use ask_user tool BEFORE taking irreversible actions
- ask_user pauses the conversation and sends buttons to Telegram
- The user will tap a button, and the conversation resumes with their choice
- Always provide clear options (e.g. "Should I proceed?" with Yes/No)

IMPORTANT BEHAVIORS:
- Keep responses concise (Telegram-friendly, max 2-3 paragraphs)
- Use ask_user tool for confirmations instead of just asking in text
- When user sends a short reply (like "1", "yes", "no"), check conversation context
- Be helpful and proactive with what you CAN do (reasoning, planning, advice)

INTENT DETECTION - Include at END of response when relevant:
- [GOAL: goal text | DEADLINE: optional] -- for goals/tasks
- [DONE: what completed] -- for completions
- [CANCEL: partial match] -- for cancelling/abandoning a goal
- [REMEMBER: fact] -- for important facts to remember
- [FORGET: partial match] -- for removing a stored fact`;
}

// ============================================================
// MAIN PROCESSOR
// ============================================================

export async function processWithAnthropic(
  userMessage: string,
  chatId: string,
  ctx: Context,
  resumeState?: ResumeState,
  onCallInitiated?: (conversationId: string) => void,
  model?: string
): Promise<string> {
  const anthropic = getClient();
  const startTime = Date.now();
  const effectiveModel = model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

  // Get conversation context from Supabase
  let contextStr = "";
  try {
    const conversationHistory = await supabase.getConversationContext(
      chatId,
      10
    );
    const persistentMemory = await supabase.getMemoryContext();
    contextStr = persistentMemory + conversationHistory;
  } catch (err) {
    console.error("Failed to load conversation context:", err);
  }

  const systemPrompt = buildSystemPrompt() + contextStr;
  const tools = buildToolDefinitions();

  let messages: Anthropic.MessageParam[];

  if (resumeState) {
    // Resume from ask_user pause -- restore messages + inject user's choice
    console.log(
      `Resuming from ask_user (task ${resumeState.taskId}): "${resumeState.userChoice}"`
    );
    messages = [
      ...resumeState.messagesSnapshot,
      // Re-add the assistant message that contained the ask_user tool_use
      { role: "assistant" as const, content: resumeState.assistantContent },
      // Add the tool result with user's choice
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: resumeState.toolUseId,
            content: `User chose: ${resumeState.userChoice}`,
          },
        ],
      },
    ];
  } else {
    messages = [{ role: "user", content: userMessage }];
  }

  const MAX_ITERATIONS = 15;
  let iterations = 0;
  let totalToolCalls = 0;

  // Send typing indicator
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);
  ctx.replyWithChatAction("typing").catch(() => {});

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await anthropic.messages.create({
        model: effectiveModel,
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      });

      // Check if we're done (no more tool calls)
      if (
        response.stop_reason === "end_turn" ||
        response.stop_reason === "stop_sequence"
      ) {
        const textBlocks = response.content.filter(
          (b): b is Anthropic.TextBlock => b.type === "text"
        );
        const result = textBlocks.map((b) => b.text).join("\n");

        const elapsed = Date.now() - startTime;
        console.log(
          `Anthropic API: ${iterations} iterations, ${totalToolCalls} tool calls, ${elapsed}ms`
        );

        return result || "Processed but no response generated.";
      }

      // Handle tool calls
      if (response.stop_reason === "tool_use") {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of response.content) {
          if (block.type === "tool_use") {
            totalToolCalls++;
            console.log(
              `Tool call: ${block.name}(${JSON.stringify(block.input).substring(0, 100)})`
            );

            try {
              const result = await executeTool(
                block.name,
                block.input as Record<string, any>,
                block.id,
                messages,
                response.content,
                onCallInitiated
              );

              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: result,
              });
            } catch (signal) {
              if (signal instanceof AskUserSignal) {
                // Pause the loop -- save state and send buttons
                const task = await supabase.createTask(
                  chatId,
                  userMessage || "resumed task",
                  ctx.message?.message_thread_id,
                  "vps"
                );

                if (task) {
                  // Save compressed messages snapshot + assistant content
                  await supabase.updateTask(task.id, {
                    status: "needs_input",
                    pending_question: signal.question,
                    pending_options: signal.options,
                    current_step: `ask_user: ${signal.question}`,
                    metadata: {
                      messages_snapshot: compressMessages(messages),
                      assistant_content: response.content,
                      tool_use_id: signal.toolUseId,
                    },
                  });

                  // Send inline keyboard to Telegram
                  const keyboard = buildTaskKeyboard(
                    task.id,
                    signal.options
                  );
                  await ctx
                    .reply(signal.question, {
                      reply_markup: keyboard,
                      parse_mode: "Markdown",
                    })
                    .catch(() =>
                      ctx.reply(signal.question, { reply_markup: keyboard })
                    );
                } else {
                  // Fallback: can't save state, just show the question as text
                  return signal.question;
                }

                const elapsed = Date.now() - startTime;
                console.log(
                  `Anthropic API paused (ask_user): ${iterations} iterations, ${totalToolCalls} tool calls, ${elapsed}ms`
                );

                // Return empty -- the response was already sent via buttons
                return "";
              }
              throw signal; // Re-throw unknown errors
            }
          }
        }

        // Add assistant response + tool results to messages
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
      }
    }

    return "Reached maximum iterations. Try a simpler request.";
  } catch (err: any) {
    console.error("Anthropic API error:", err.message);

    if (err.status === 401) {
      return "API authentication error. Check ANTHROPIC_API_KEY.";
    }
    if (err.status === 429) {
      return "Rate limited. Please try again in a moment.";
    }

    return `Error: ${err.message}`;
  } finally {
    clearInterval(typingInterval);
  }
}
