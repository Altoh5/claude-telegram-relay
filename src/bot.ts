/**
 * Go - Telegram Bot Daemon
 *
 * Core relay that connects Telegram to Claude Code.
 * Handles text, voice, photo, and document messages with
 * multi-agent routing, persistent memory, and fallback LLM chain.
 *
 * Usage: bun run src/bot.ts
 */

import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { join } from "path";
import { readFile, writeFile, mkdir, unlink, stat } from "fs/promises";
import { createWriteStream, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Local Modules
// ---------------------------------------------------------------------------

import { loadEnv } from "./lib/env";
import { sanitizeForTelegram, sendResponse, createTypingIndicator } from "./lib/telegram";
import { callClaude as callClaudeSubprocess, isClaudeErrorResponse } from "./lib/claude";
import {
  processIntents,
  getMemoryContext,
  addFact,
  addGoal,
  completeGoal,
  listGoals,
  listFacts,
} from "./lib/memory";
import { callFallbackLLM } from "./lib/fallback-llm";
import { textToSpeech, initiatePhoneCall, isVoiceEnabled, isCallEnabled, waitForTranscript } from "./lib/voice";
import { transcribeAudio, isTranscriptionEnabled } from "./lib/transcribe";
import {
  saveMessage,
  getConversationContext,
  searchMessages,
  getRecentMessages,
  log as sbLog,
  createTask,
  updateTask,
} from "./lib/supabase";

// Task Queue (Human-in-the-Loop)
import {
  parseClaudeResponse,
  buildTaskKeyboard,
  handleTaskCallback,
  formatTaskStatus,
  checkStaleTasks,
} from "./lib/task-queue";

// VPS Anthropic Processor (for resuming VPS tasks)
import {
  processWithAnthropic,
  type ResumeState,
} from "./lib/anthropic-processor";

// Agents
import {
  getAgentConfig,
  getAgentByTopicId,
  formatCrossAgentContext,
  getUserProfile,
} from "./agents";

// ---------------------------------------------------------------------------
// 1. Load Environment
// ---------------------------------------------------------------------------

await loadEnv(join(process.cwd(), ".env"));

// ---------------------------------------------------------------------------
// 2. Configuration
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID;
const PROJECT_ROOT = process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3000", 10);

if (!BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN is required. Set it in .env");
  process.exit(1);
}

if (!ALLOWED_USER_ID) {
  console.error("FATAL: TELEGRAM_USER_ID is required. Set it in .env");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ---------------------------------------------------------------------------
// 3. Session State Management
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string | null;
  pendingFiles: string[];
}

const SESSION_STATE_PATH = join(PROJECT_ROOT, "session-state.json");

let sessionState: SessionState = {
  sessionId: null,
  pendingFiles: [],
};

async function loadSessionState(): Promise<void> {
  try {
    const raw = await readFile(SESSION_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    sessionState = {
      sessionId: parsed.sessionId || null,
      pendingFiles: Array.isArray(parsed.pendingFiles) ? parsed.pendingFiles : [],
    };
  } catch {
    // No saved state, use defaults
  }
}

async function saveSessionState(): Promise<void> {
  try {
    await writeFile(SESSION_STATE_PATH, JSON.stringify(sessionState, null, 2), "utf-8");
  } catch {
    // Silent failure
  }
}

await loadSessionState();

// ---------------------------------------------------------------------------
// 4. Process Lock (Prevent Multiple Instances)
// ---------------------------------------------------------------------------

const LOCK_FILE = join(PROJECT_ROOT, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    // Check if lock file exists and is fresh (heartbeat within last 90s)
    const lockStat = await stat(LOCK_FILE).catch(() => null);
    if (lockStat) {
      const lockAge = Date.now() - lockStat.mtimeMs;
      if (lockAge < 90_000) {
        console.error("FATAL: Another instance is running (bot.lock is fresh). Exiting.");
        return false;
      }
      console.log("Stale lock file found, taking over...");
    }

    // Write our PID as the lock
    await writeFile(LOCK_FILE, String(process.pid), "utf-8");
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await unlink(LOCK_FILE);
  } catch {
    // Lock file may already be gone
  }
}

// Heartbeat: touch lock file every 60s to signal we're alive
const heartbeatInterval = setInterval(async () => {
  try {
    await writeFile(LOCK_FILE, String(process.pid), "utf-8");
  } catch {
    // Non-critical
  }
}, 60_000);

// Stale task reminders: check every 15 minutes
const staleTaskInterval = setInterval(async () => {
  try {
    if (BOT_TOKEN && ALLOWED_USER_ID) {
      const reminded = await checkStaleTasks(BOT_TOKEN, ALLOWED_USER_ID);
      if (reminded > 0) {
        console.log(`Sent ${reminded} stale task reminder(s)`);
      }
    }
  } catch (err) {
    console.error("Stale task check error:", err);
  }
}, 15 * 60 * 1000);

if (!(await acquireLock())) {
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5. Graceful Shutdown
// ---------------------------------------------------------------------------

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  clearInterval(heartbeatInterval);
  clearInterval(staleTaskInterval);

  try {
    bot.stop();
  } catch {
    // Bot may not have started
  }

  await saveSessionState();
  await releaseLock();
  await sbLog("info", "bot", `Shutdown: ${signal}`);

  console.log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);
  await sbLog("error", "bot", `Uncaught exception: ${error.message}`, {
    stack: error.stack,
  });
  await shutdown("uncaughtException");
});

// ---------------------------------------------------------------------------
// 6. Security Middleware
// ---------------------------------------------------------------------------

bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id || "");
  if (userId !== ALLOWED_USER_ID) {
    // Silently ignore messages from unauthorized users
    return;
  }
  await next();
});

// ---------------------------------------------------------------------------
// 7. Message Handlers
// ---------------------------------------------------------------------------

// --- Text Messages ---

bot.on("message:text", (ctx) => {
  // Fire-and-forget: don't block Grammy's update loop
  handleTextMessage(ctx).catch((err) => {
    console.error("Text handler error:", err);
  });
});

async function handleTextMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const chatId = String(ctx.chat?.id || "");
  const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
  const lowerText = text.toLowerCase();

  // Persist user message
  await saveMessage({
    chat_id: chatId,
    role: "user",
    content: text,
    metadata: { topicId, messageId: ctx.message?.message_id },
  });

  // ----- Memory Commands -----

  // remember: <fact>
  if (lowerText.startsWith("remember:")) {
    const fact = text.slice("remember:".length).trim();
    if (fact) {
      const success = await addFact(fact);
      const reply = success ? `Noted. I'll remember that.` : `Failed to save that. Try again?`;
      await ctx.reply(reply);
      return;
    }
  }

  // track: <goal> [| deadline: <deadline>]
  if (lowerText.startsWith("track:")) {
    const raw = text.slice("track:".length).trim();
    const deadlineMatch = raw.match(/\|\s*deadline:\s*(.+)$/i);
    const goalText = deadlineMatch ? raw.slice(0, deadlineMatch.index).trim() : raw;
    const deadline = deadlineMatch ? deadlineMatch[1].trim() : undefined;

    if (goalText) {
      const success = await addGoal(goalText, deadline);
      const deadlineNote = deadline ? ` (deadline: ${deadline})` : "";
      const reply = success
        ? `Goal tracked: "${goalText}"${deadlineNote}`
        : `Failed to track that goal.`;
      await ctx.reply(reply);
      return;
    }
  }

  // done: <partial goal match>
  if (lowerText.startsWith("done:")) {
    const search = text.slice("done:".length).trim();
    if (search) {
      const success = await completeGoal(search);
      const reply = success
        ? `Goal completed! Nice work.`
        : `Couldn't find an active goal matching "${search}".`;
      await ctx.reply(reply);
      return;
    }
  }

  // goals
  if (lowerText === "goals" || lowerText === "/goals") {
    const goals = await listGoals();
    await ctx.reply(`**Active Goals:**\n${goals}`, { parse_mode: "Markdown" }).catch(() =>
      ctx.reply(`Active Goals:\n${goals}`)
    );
    return;
  }

  // memory / facts
  if (lowerText === "memory" || lowerText === "facts" || lowerText === "/memory") {
    const facts = await listFacts();
    await ctx.reply(`**Stored Facts:**\n${facts}`, { parse_mode: "Markdown" }).catch(() =>
      ctx.reply(`Stored Facts:\n${facts}`)
    );
    return;
  }

  // /tasks — show active async tasks
  if (lowerText === "/tasks" || lowerText === "tasks") {
    const status = await formatTaskStatus(chatId);
    await ctx.reply(status, { parse_mode: "Markdown" }).catch(() => ctx.reply(status));
    return;
  }

  // ----- Semantic Search -----

  if (
    lowerText.startsWith("recall ") ||
    lowerText.startsWith("search ") ||
    lowerText.startsWith("find ")
  ) {
    const query = text.split(/\s+/).slice(1).join(" ");
    if (query) {
      const typing = createTypingIndicator(ctx);
      typing.start();
      try {
        const results = await searchMessages(chatId, query, 5);
        if (results.length === 0) {
          await ctx.reply(`No results found for "${query}".`);
        } else {
          const formatted = results
            .map((msg, i) => {
              const time = msg.created_at
                ? new Date(msg.created_at).toLocaleDateString()
                : "unknown";
              const speaker = msg.role === "user" ? "User" : "Bot";
              const snippet = msg.content.length > 200
                ? msg.content.substring(0, 200) + "..."
                : msg.content;
              return `${i + 1}. [${time}] ${speaker}: ${snippet}`;
            })
            .join("\n\n");
          await ctx.reply(`**Search results for "${query}":**\n\n${formatted}`, {
            parse_mode: "Markdown",
          }).catch(() => ctx.reply(`Search results for "${query}":\n\n${formatted}`));
        }
      } finally {
        typing.stop();
      }
      return;
    }
  }

  // ----- Critic Mode -----

  if (lowerText.startsWith("/critic ") || lowerText.startsWith("/critic\n")) {
    const idea = text.slice("/critic".length).trim();
    if (idea) {
      await callClaudeAndReply(ctx, chatId, idea, "critic", topicId);
      return;
    }
  }

  // ----- Board Meeting -----

  if (
    lowerText === "/board" ||
    lowerText === "board meeting" ||
    lowerText.startsWith("/board ")
  ) {
    const extraContext = text.replace(/^\/board\s*/i, "").replace(/^board meeting\s*/i, "").trim();
    const boardPrompt = extraContext
      ? `Board meeting requested. Additional context: ${extraContext}`
      : "Board meeting requested. Review all recent activity and provide a synthesis.";

    await callClaudeAndReply(ctx, chatId, boardPrompt, "general", topicId);
    return;
  }

  // ----- Phone Call -----

  if (lowerText.includes("call me") && isCallEnabled()) {
    const context = text.replace(/call me/i, "").trim();
    const profile = await getUserProfile();
    const userName = extractUserName(profile);
    await ctx.reply("Initiating call...");
    const result = await initiatePhoneCall(context, userName);

    if (result.success) {
      await ctx.reply(`Call started! ${result.message}`);

      // Wait for transcript in the background
      if (result.conversationId) {
        waitForTranscript(result.conversationId).then(async (transcript) => {
          if (transcript) {
            // Save transcript to memory
            await saveMessage({
              chat_id: chatId,
              role: "assistant",
              content: `[Phone call transcript]\n${transcript}`,
              metadata: { type: "call_transcript", conversationId: result.conversationId },
            });
            await ctx.reply(`Call transcript saved.`);
          }
        }).catch(() => {
          // Transcript polling failed silently
        });
      }
    } else {
      await ctx.reply(`Could not start call: ${result.message}`);
    }
    return;
  }

  // ----- Default: Claude Processing -----

  // Determine agent from topic (if forum mode)
  const agentName = topicId ? getAgentByTopicId(topicId) || "general" : "general";
  await callClaudeAndReply(ctx, chatId, text, agentName, topicId);
}

// --- Voice Messages ---

bot.on("message:voice", (ctx) => {
  handleVoiceMessage(ctx).catch((err) => {
    console.error("Voice handler error:", err);
  });
});

async function handleVoiceMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id || "");
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    // Download voice file
    const file = await ctx.getFile();
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Could not download voice message.");
      return;
    }

    const uploadsDir = join(PROJECT_ROOT, "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const localPath = join(uploadsDir, `voice_${Date.now()}.ogg`);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(localPath, buffer);

    // Transcribe
    const transcript = await transcribeAudio(localPath);

    // Persist user message (transcribed)
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: `[Voice message] ${transcript}`,
      metadata: { type: "voice", originalFile: localPath },
    });

    // Process with Claude
    const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
    const agentName = topicId ? getAgentByTopicId(topicId) || "general" : "general";

    const claudeResponse = await callClaude(
      `[Voice message transcription]: ${transcript}`,
      chatId,
      agentName,
      topicId
    );

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: claudeResponse,
      metadata: { type: "voice_reply" },
    });

    // Process intents
    await processIntents(claudeResponse);

    // Reply with voice if voice is enabled, otherwise text
    await sendResponse(ctx, claudeResponse, isVoiceEnabled(), textToSpeech);

    // Cleanup temp file
    await unlink(localPath).catch(() => {});
  } catch (error) {
    console.error("Voice processing error:", error);
    await ctx.reply("Sorry, I couldn't process that voice message. Please try again.");
  } finally {
    typing.stop();
  }
}

// --- Photo Messages ---

bot.on("message:photo", (ctx) => {
  handlePhotoMessage(ctx).catch((err) => {
    console.error("Photo handler error:", err);
  });
});

async function handlePhotoMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id || "");
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    // Get highest resolution photo
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) {
      await ctx.reply("Could not process photo.");
      return;
    }

    const largest = photos[photos.length - 1];
    const file = await ctx.api.getFile(largest.file_id);
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Could not download photo.");
      return;
    }

    const uploadsDir = join(PROJECT_ROOT, "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const ext = filePath.split(".").pop() || "jpg";
    const localPath = join(uploadsDir, `photo_${Date.now()}.${ext}`);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(localPath, buffer);

    const caption = ctx.message?.caption || "User sent a photo. Describe and respond to it.";

    // Persist user message
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: `[Photo] ${caption}`,
      metadata: { type: "photo", filePath: localPath },
    });

    // Process with Claude (include image path in prompt)
    const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
    const agentName = topicId ? getAgentByTopicId(topicId) || "general" : "general";

    const claudeResponse = await callClaude(
      `[User sent an image saved at: ${localPath}]\n\n${caption}`,
      chatId,
      agentName,
      topicId
    );

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: claudeResponse,
      metadata: { type: "photo_reply" },
    });

    await processIntents(claudeResponse);
    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Photo processing error:", error);
    await ctx.reply("Sorry, I couldn't process that image. Please try again.");
  } finally {
    typing.stop();
  }
}

// --- Document Messages ---

bot.on("message:document", (ctx) => {
  handleDocumentMessage(ctx).catch((err) => {
    console.error("Document handler error:", err);
  });
});

async function handleDocumentMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id || "");
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    const doc = ctx.message?.document;
    if (!doc) {
      await ctx.reply("Could not process document.");
      return;
    }

    const file = await ctx.api.getFile(doc.file_id);
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Could not download document.");
      return;
    }

    const uploadsDir = join(PROJECT_ROOT, "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const fileName = doc.file_name || `document_${Date.now()}`;
    const localPath = join(uploadsDir, fileName);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(localPath, buffer);

    const caption = ctx.message?.caption || `User sent a document: ${fileName}`;

    // Persist user message
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: `[Document: ${fileName}] ${caption}`,
      metadata: { type: "document", filePath: localPath, fileName },
    });

    // Process with Claude
    const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
    const agentName = topicId ? getAgentByTopicId(topicId) || "general" : "general";

    const claudeResponse = await callClaude(
      `[User sent a document saved at: ${localPath}, filename: ${fileName}]\n\n${caption}`,
      chatId,
      agentName,
      topicId
    );

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: claudeResponse,
      metadata: { type: "document_reply" },
    });

    await processIntents(claudeResponse);
    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Document processing error:", error);
    await ctx.reply("Sorry, I couldn't process that document. Please try again.");
  } finally {
    typing.stop();
  }
}

// --- Callback Queries (Human-in-the-Loop Buttons) ---

bot.on("callback_query:data", (ctx) => {
  handleCallbackQuery(ctx).catch((err) => {
    console.error("Callback query error:", err);
  });
});

async function handleCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  // Acknowledge the button press immediately
  await ctx.answerCallbackQuery().catch(() => {});

  if (!data.startsWith("atask:")) return;

  const result = await handleTaskCallback(data);
  if (!result) {
    await ctx.editMessageText("Task not found or expired.").catch(() => {});
    return;
  }

  if (result.cancelled) {
    await ctx.editMessageText("Task cancelled.").catch(() => {});
    return;
  }

  const chatId = String(ctx.chat?.id || "");
  const task = result.task!;

  // Edit the button message to show the user's choice
  await ctx
    .editMessageText(
      `${task.pending_question || "Question"}\n\n✅ You chose: ${result.choice}`
    )
    .catch(() => {});

  // --- VPS mode resume: task has messages_snapshot from Anthropic API ---
  if (task.metadata?.messages_snapshot) {
    const typing = createTypingIndicator(ctx);
    typing.start();

    try {
      const resumeState: ResumeState = {
        taskId: result.taskId,
        messagesSnapshot: task.metadata.messages_snapshot,
        assistantContent: task.metadata.assistant_content,
        userChoice: result.choice,
        toolUseId: task.metadata.tool_use_id,
      };

      const response = await processWithAnthropic(
        task.original_prompt,
        chatId,
        ctx,
        resumeState
      );

      // processWithAnthropic returns "" if another ask_user was triggered (new task created)
      if (response) {
        await saveMessage({
          chat_id: chatId,
          role: "assistant",
          content: response,
          metadata: { type: "task_resume", taskId: result.taskId },
        });
        await processIntents(response);
        await sendResponse(ctx, response);
      }

      // Mark the original task as completed (new task was created if another ask_user fired)
      await updateTask(result.taskId, {
        status: "completed",
        result: response ? response.substring(0, 10000) : "Continued in new task",
      });
    } catch (err) {
      console.error("VPS resume error:", err);
      await ctx.reply("Error resuming task. Please try again.");
      await updateTask(result.taskId, { status: "failed", result: String(err) });
    } finally {
      typing.stop();
    }
    return;
  }

  // --- Mac mode resume: task has session_id from Claude Code subprocess ---
  if (task.session_id) {
    const typing = createTypingIndicator(ctx);
    typing.start();

    try {
      const claudeResult = await callClaudeSubprocess({
        prompt: `User responded: ${result.choice}`,
        outputFormat: "json",
        resumeSessionId: task.session_id,
        timeoutMs: 1_800_000,
        cwd: PROJECT_ROOT,
      });

      const response = claudeResult.text || "Task completed.";

      await saveMessage({
        chat_id: chatId,
        role: "assistant",
        content: response,
        metadata: { type: "task_resume", taskId: result.taskId },
      });
      await processIntents(response);

      // Check if the resumed response also contains questions
      const parsed = parseClaudeResponse(response);
      if (parsed.needsInput && parsed.options.length > 0) {
        await updateTask(result.taskId, {
          status: "needs_input",
          session_id: claudeResult.sessionId || task.session_id,
          pending_question: parsed.question || undefined,
          pending_options: parsed.options,
          current_step: parsed.text.substring(0, 500),
        });
        const keyboard = buildTaskKeyboard(result.taskId, parsed.options);
        await ctx
          .reply(response, { reply_markup: keyboard, parse_mode: "Markdown" })
          .catch(() => ctx.reply(response, { reply_markup: keyboard }));
      } else {
        await updateTask(result.taskId, {
          status: "completed",
          result: response.substring(0, 10000),
        });
        await sendResponse(ctx, response);
      }
    } catch (err) {
      console.error("Mac resume error:", err);
      await ctx.reply("Error resuming task. Please try again.");
      await updateTask(result.taskId, { status: "failed", result: String(err) });
    } finally {
      typing.stop();
    }
    return;
  }

  // --- No resume context: just acknowledge ---
  await ctx.reply(`Noted: ${result.choice}. Task marked complete.`);
  await updateTask(result.taskId, { status: "completed" });
}

// ---------------------------------------------------------------------------
// 8. callClaude() - Core AI Processing
// ---------------------------------------------------------------------------

/**
 * Call Claude Code subprocess with agent config, memory, and conversation context.
 * Claude Code has access to all configured MCP servers (Calendar, Gmail, Notion, etc.)
 * Falls back to secondary LLMs on error.
 */
async function callClaude(
  userMessage: string,
  chatId: string,
  agentName: string = "general",
  topicId?: number
): Promise<string> {
  const agentConfig = getAgentConfig(agentName);
  const userProfile = await getUserProfile();

  // Build memory context
  const memoryCtx = await getMemoryContext();

  // Build conversation context (recent messages)
  const conversationCtx = await getConversationContext(chatId, 10);

  // Current time in user's timezone
  const now = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  // Build the full prompt
  const sections: string[] = [];

  // Agent system prompt (or default)
  if (agentConfig) {
    sections.push(agentConfig.systemPrompt);
  } else {
    sections.push("You are Go, a personal AI assistant. Be concise, direct, and helpful.");
  }

  // User profile context
  if (userProfile) {
    sections.push(`## USER PROFILE\n${userProfile}`);
  }

  // Time context
  sections.push(`## CURRENT TIME\n${now}`);

  // Memory context
  if (memoryCtx) {
    sections.push(`## MEMORY\n${memoryCtx}`);
  }

  // Recent conversation
  if (conversationCtx) {
    sections.push(`## RECENT CONVERSATION\n${conversationCtx}`);
  }

  // Session resumption note
  if (sessionState.sessionId) {
    sections.push(`## SESSION\nResuming session: ${sessionState.sessionId}`);
  }

  // Intent detection instructions
  sections.push(`## INTENT DETECTION
If the user sets a goal, include: [GOAL: description | DEADLINE: deadline]
If a goal is completed, include: [DONE: partial match]
If you learn a fact worth remembering, include: [REMEMBER: fact]
These tags will be parsed automatically. Include them naturally in your response.`);

  // The actual user message
  sections.push(`## USER MESSAGE\n${userMessage}`);

  const fullPrompt = sections.join("\n\n---\n\n");

  // Call Claude subprocess
  // When allowedTools is omitted, Claude Code gets full access to all tools,
  // MCP servers, skills, and hooks configured in your Claude Code settings.
  const result = await callClaudeSubprocess({
    prompt: fullPrompt,
    outputFormat: "json",
    ...(agentConfig?.allowedTools ? { allowedTools: agentConfig.allowedTools } : {}),
    resumeSessionId: sessionState.sessionId || undefined,
    timeoutMs: 1_800_000, // 30 minutes
    cwd: PROJECT_ROOT,
  });

  // Update session ID
  if (result.sessionId) {
    sessionState.sessionId = result.sessionId;
    await saveSessionState();
  }

  // Handle errors with fallback
  if (result.isError || !result.text) {
    console.error("Claude error, falling back to secondary LLM...");
    await sbLog("warn", "bot", "Claude failed, using fallback LLM", {
      error: result.text?.substring(0, 200),
    });

    try {
      const fallbackResponse = await callFallbackLLM(userMessage);
      return `${fallbackResponse}\n\n_(responded via fallback)_`;
    } catch (fallbackError) {
      console.error("Fallback LLM also failed:", fallbackError);
      return "I'm having trouble processing right now. Please try again in a moment.";
    }
  }

  return result.text;
}

/**
 * Full flow: call Claude, persist response, process intents, send reply.
 * Used by text message handler for all Claude-routed messages.
 */
async function callClaudeAndReply(
  ctx: Context,
  chatId: string,
  userMessage: string,
  agentName: string,
  topicId?: number
): Promise<void> {
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    const response = await callClaude(userMessage, chatId, agentName, topicId);

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: response,
      metadata: { agent: agentName, topicId },
    });

    // Process intents (goals, facts, etc.)
    await processIntents(response);

    // Check if Claude is asking a question that needs inline button response
    const parsed = parseClaudeResponse(response);
    if (parsed.needsInput && parsed.options.length > 0) {
      // Create task for human-in-the-loop
      const task = await createTask(chatId, userMessage, topicId, "mac");
      if (task) {
        await updateTask(task.id, {
          status: "needs_input",
          session_id: sessionState.sessionId || undefined,
          pending_question: parsed.question || undefined,
          pending_options: parsed.options,
          current_step: parsed.text.substring(0, 500),
        });
        const keyboard = buildTaskKeyboard(task.id, parsed.options);
        await ctx
          .reply(response, { reply_markup: keyboard, parse_mode: "Markdown" })
          .catch(() => ctx.reply(response, { reply_markup: keyboard }));
        return;
      }
    }

    // Normal response (no question or task creation failed)
    await sendResponse(ctx, response);
  } catch (error) {
    console.error("callClaudeAndReply error:", error);
    await ctx.reply("Something went wrong. Please try again.");
  } finally {
    typing.stop();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a display name from the user profile markdown.
 * Falls back to "User" if no name is found.
 */
function extractUserName(profile: string): string {
  if (!profile) return "User";
  // Try to find a name in common profile patterns
  const nameMatch = profile.match(/(?:^#\s+(.+)|name:\s*(.+)|Name:\s*(.+))/m);
  if (nameMatch) {
    return (nameMatch[1] || nameMatch[2] || nameMatch[3]).trim();
  }
  return "User";
}

// ---------------------------------------------------------------------------
// 10. Health Check HTTP Server
// ---------------------------------------------------------------------------

const healthServer = Bun.serve({
  port: HEALTH_PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "go-telegram-bot",
          uptime: process.uptime(),
          pid: process.pid,
          sessionId: sessionState.sessionId,
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
});

// ---------------------------------------------------------------------------
// 11. Bot Startup
// ---------------------------------------------------------------------------

console.log("=".repeat(50));
console.log("Go Telegram Bot - Starting");
console.log("=".repeat(50));
console.log(`PID:         ${process.pid}`);
console.log(`Project:     ${PROJECT_ROOT}`);
console.log(`Timezone:    ${TIMEZONE}`);
console.log(`Health:      http://localhost:${HEALTH_PORT}/health`);
console.log(`Claude:      ${CLAUDE_PATH}`);
console.log(`Voice:       ${isVoiceEnabled() ? "enabled" : "disabled"}`);
console.log(`Phone:       ${isCallEnabled() ? "enabled" : "disabled"}`);
console.log(`Transcribe:  ${isTranscriptionEnabled() ? "enabled" : "disabled"}`);
console.log(`Session:     ${sessionState.sessionId || "new"}`);
console.log(`HITL:        enabled (inline buttons + task queue)`);
console.log("=".repeat(50));

await sbLog("info", "bot", "Bot started", {
  pid: process.pid,
  timezone: TIMEZONE,
});

// Start polling
bot.start({
  onStart: (botInfo) => {
    console.log(`Bot online as @${botInfo.username}`);
  },
});
