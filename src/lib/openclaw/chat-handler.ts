/**
 * OpenClaw Chat Handler — Bridges OpenClaw chat.send to GoBot's Claude pipeline.
 *
 * Reuses the same prompt construction, streaming, memory, and intent processing
 * as the Telegram bot (bot.ts), but outputs OpenClaw delta/final events instead
 * of Telegram messages.
 */

import type { ServerWebSocket } from "bun";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";

import {
  callClaude,
  callClaudeStreaming,
  isClaudeErrorResponse,
} from "../claude";
import { classifyComplexity } from "../model-router";
import { getMemoryContext, processIntents } from "../memory";
import { saveMessage, getConversationContext } from "../supabase";
import { callFallbackLLM } from "../fallback-llm";
import { getAgentConfig, getUserProfile } from "../../agents/base";

import type { ConnectionData, ChatSendParams } from "./protocol";
import { sendResponse, sendEvent, sendError } from "./protocol";
import type { Session } from "./session-manager";
import { updateClaudeSessionId } from "./session-manager";

const TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const PROJECT_ROOT = process.cwd();

/**
 * Handle a chat.send request from the AR glasses.
 *
 * 1. Ack immediately with { status: "started", runId }
 * 2. Build prompt (same pattern as bot.ts)
 * 3. Call Claude (streaming for complex, standard for simple)
 * 4. Emit OpenClaw delta events during processing
 * 5. Emit final event with complete response
 * 6. Post-process: save to Supabase, process intents
 */
export async function handleChatSend(
  ws: ServerWebSocket<ConnectionData>,
  requestId: string,
  params: ChatSendParams,
  sessions: Map<string, Session>
): Promise<void> {
  const { sessionKey, message, images } = params;
  const runId = crypto.randomUUID();
  const deviceToken = ws.data.deviceToken || "unknown";
  const chatId = `openclaw:${deviceToken}`;

  // Look up the session to find the agent
  const session = sessions.get(sessionKey);
  const agentName = session?.agentName || "general";

  // Ack immediately
  sendResponse(ws, requestId, true, { status: "started", runId });

  // Handle images — decode base64, write temp files
  const tempImagePaths: string[] = [];
  let imagePromptParts: string[] = [];

  if (images && images.length > 0) {
    const uploadDir = join(PROJECT_ROOT, "uploads");
    await mkdir(uploadDir, { recursive: true });

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        const buffer = Buffer.from(img.base64, "base64");
        const ext = img.mediaType?.includes("png") ? "png" : "jpg";
        const filename = `openclaw-${Date.now()}-${i}.${ext}`;
        const filepath = join(uploadDir, filename);
        await writeFile(filepath, buffer);
        tempImagePaths.push(filepath);
        imagePromptParts.push(`[Image attached: ${filepath}]`);
      } catch (err) {
        console.error(`[openclaw] Failed to write image ${i}:`, err);
      }
    }
  }

  try {
    // Build prompt — same pattern as bot.ts:1216-1267
    const agentConfig = getAgentConfig(agentName);
    const userProfile = await getUserProfile();
    const memoryCtx = await getMemoryContext();
    const conversationCtx = await getConversationContext(chatId, 10);

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

    const sections: string[] = [];

    if (agentConfig) {
      sections.push(agentConfig.systemPrompt);
    } else {
      sections.push(
        "You are Go, a personal AI assistant. Be concise, direct, and helpful."
      );
    }

    if (userProfile) sections.push(`## USER PROFILE\n${userProfile}`);
    sections.push(`## CURRENT TIME\n${now}`);
    if (memoryCtx) sections.push(`## MEMORY\n${memoryCtx}`);
    if (conversationCtx)
      sections.push(`## RECENT CONVERSATION\n${conversationCtx}`);

    sections.push(`## INTENT DETECTION
If the user sets a goal, include: [GOAL: description | DEADLINE: deadline]
If a goal is completed, include: [DONE: partial match]
If the user wants to cancel/abandon a goal, include: [CANCEL: partial match]
If you learn a fact worth remembering, include: [REMEMBER: fact]
If the user wants to forget a stored fact, include: [FORGET: partial match]
These tags will be parsed automatically. Include them naturally in your response.`);

    sections.push(`## IMAGE CATALOGUING
When you analyze an image, include this tag at the END of your response:
[ASSET_DESC: concise 1-2 sentence description | tag1, tag2, tag3]
This is used for search/recall of images later. Be descriptive but concise.
Example: [ASSET_DESC: Birthday invitation with pink bunny holding a cupcake | birthday, invitation, kids]`);

    // Build user message with any image references
    let userMsg = message;
    if (imagePromptParts.length > 0) {
      userMsg = `${imagePromptParts.join("\n")}\n\n${message}`;
    }
    sections.push(`## USER MESSAGE\n${userMsg}`);

    const fullPrompt = sections.join("\n\n---\n\n");

    // Save user message to Supabase
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: message,
      metadata: { channel: "openclaw", agent: agentName, sessionKey },
    });

    // Classify complexity and process
    const tier = classifyComplexity(message);
    console.log(
      `[openclaw] tier=${tier} agent=${agentName} msg="${message.substring(0, 60)}"`
    );

    let responseText: string;

    if (tier !== "haiku") {
      // Complex → streaming with delta events
      responseText = await processStreaming(
        ws,
        fullPrompt,
        runId,
        agentConfig?.allowedTools,
        session?.claudeSessionId
      );
    } else {
      // Simple → single call, single final event
      responseText = await processStandard(
        fullPrompt,
        agentConfig?.allowedTools,
        session?.claudeSessionId
      );
    }

    // Send final response
    sendEvent(ws, "chat", { state: "final", text: responseText, runId });

    // Update Claude session ID for resumption
    const result = await getLastSessionId();
    if (result && session) {
      updateClaudeSessionId(sessions, sessionKey, result);
    }

    // Save assistant response to Supabase
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: responseText,
      metadata: { channel: "openclaw", agent: agentName, sessionKey },
    });

    // Process intents (goals, facts, etc.)
    await processIntents(responseText);
  } catch (err) {
    console.error("[openclaw] Chat handler error:", err);
    sendEvent(ws, "chat", {
      state: "final",
      text: "Something went wrong processing your message. Please try again.",
      runId,
    });
  } finally {
    // Cleanup temp images
    for (const path of tempImagePaths) {
      unlink(path).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let _lastSessionId: string | undefined;

function getLastSessionId(): string | undefined {
  return _lastSessionId;
}

/**
 * Process with streaming subprocess — emits delta events for tool progress.
 */
async function processStreaming(
  ws: ServerWebSocket<ConnectionData>,
  prompt: string,
  runId: string,
  allowedTools?: string[],
  resumeSessionId?: string
): Promise<string> {
  let accumulatedText = "";
  let seq = 0;

  const result = await callClaudeStreaming({
    prompt,
    ...(allowedTools ? { allowedTools } : {}),
    resumeSessionId,
    timeoutMs: 1_800_000,
    cwd: PROJECT_ROOT,
    onToolStart: (displayName) => {
      accumulatedText += `[${displayName}]\n`;
      try {
        sendEvent(ws, "chat", {
          state: "delta",
          text: accumulatedText,
          runId,
        }, ++seq);
      } catch {
        // Connection may have closed
      }
    },
    onFirstText: (snippet) => {
      const clean = snippet.replace(/[_*`]/g, "").substring(0, 120);
      if (clean.length > 20) {
        accumulatedText += `${clean}...\n`;
        try {
          sendEvent(ws, "chat", {
            state: "delta",
            text: accumulatedText,
            runId,
          }, ++seq);
        } catch {}
      }
    },
  });

  _lastSessionId = result.sessionId;

  if (result.isError || !result.text) {
    console.error("[openclaw] Claude streaming failed, trying fallback...");
    try {
      return await callFallbackLLM(prompt);
    } catch {
      return "I'm having trouble processing right now. Please try again.";
    }
  }

  return result.text;
}

/**
 * Process with standard subprocess — no streaming, just returns text.
 */
async function processStandard(
  prompt: string,
  allowedTools?: string[],
  resumeSessionId?: string
): Promise<string> {
  const result = await callClaude({
    prompt,
    outputFormat: "json",
    ...(allowedTools ? { allowedTools } : {}),
    resumeSessionId,
    timeoutMs: 1_800_000,
    cwd: PROJECT_ROOT,
  });

  _lastSessionId = result.sessionId;

  if (result.isError || !result.text) {
    console.error("[openclaw] Claude failed, trying fallback...");
    try {
      return await callFallbackLLM(prompt);
    } catch {
      return "I'm having trouble processing right now. Please try again.";
    }
  }

  return result.text;
}
