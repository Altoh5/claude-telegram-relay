/**
 * Go - Claude Code Subprocess Spawner
 *
 * Spawns claude CLI as a subprocess for AI processing.
 * Handles session resumption, timeouts, cleanup, and streaming progress.
 */

import { spawn } from "bun";
import { optionalEnv } from "./env";

const IS_MACOS = process.platform === "darwin";
const IS_WINDOWS = process.platform === "win32";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";

export interface ClaudeOptions {
  prompt: string;
  outputFormat?: "json" | "text";
  allowedTools?: string[];
  resumeSessionId?: string;
  timeoutMs?: number;
  cwd?: string;
  maxTurns?: string;
}

export interface ClaudeStreamOptions extends ClaudeOptions {
  /** Called when a tool starts executing. Throttled to max 1 call per 2s. */
  onToolStart?: (displayName: string) => void;
  /** Called when the first meaningful text chunk arrives (plan/thinking). */
  onFirstText?: (snippet: string) => void;
}

export interface ClaudeResult {
  text: string;
  sessionId?: string;
  isError: boolean;
}

/**
 * Known error patterns in Claude output that indicate auth/API failures.
 */
export function isClaudeErrorResponse(text: string): boolean {
  const errorPatterns = [
    "authentication_error",
    "API Error: 400",
    "API Error: 401",
    "API Error: 403",
    "API Error: 429",
    "OAuth token has expired",
    "Failed to authenticate",
    "invalid_api_key",
    "invalidRequestError",
    "Could not process image",
    "overloaded_error",
    "rate_limit_error",
    "credit balance",
    "add funds",
    "billing",
    "insufficient_quota",
    "payment_required",
    "prompt is too long",
    "context_length_exceeded",
    "tokens > ",
  ];
  return errorPatterns.some((p) => text.includes(p));
}

/**
 * Strip markdown code fences and extract JSON from Claude output.
 * Claude subprocesses often wrap JSON in ```json``` fences.
 */
export function extractJSON(output: string, key: string): any | null {
  const cleaned = output.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
  const jsonMatch = cleaned.match(
    new RegExp(`\\{[\\s\\S]*"${key}"[\\s\\S]*\\}`)
  );
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Spawn a Claude Code subprocess with proper timeout and cleanup.
 */
export async function callClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const {
    prompt,
    outputFormat = "text",
    allowedTools,
    resumeSessionId,
    timeoutMs = 300_000, // 5 minutes default
    cwd,
    maxTurns,
  } = options;

  const args = ["-p", prompt, "--output-format", outputFormat];

  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  if (maxTurns) {
    args.push("--max-turns", maxTurns);
  }

  // On macOS, wrap with caffeinate -i to prevent idle sleep during active tasks
  const cmd = IS_MACOS
    ? ["/usr/bin/caffeinate", "-i", CLAUDE_PATH, ...args]
    : [CLAUDE_PATH, ...args];

  const proc = spawn({
    cmd,
    cwd: cwd || process.cwd(),
    env: {
      ...process.env,
      HOME: HOME_DIR,
      PATH: process.env.PATH || "",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Timeout with proper process kill
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);

  try {
    const output = await new Response(proc.stdout).text();
    clearTimeout(timeoutId);

    if (timedOut) {
      return { text: "", isError: true };
    }

    // Check for errors
    if (isClaudeErrorResponse(output)) {
      return { text: output, isError: true };
    }

    // Parse JSON output format
    if (outputFormat === "json") {
      try {
        const result = JSON.parse(output);
        const hasError = result.subtype === "error_max_turns" || isClaudeErrorResponse(result.result || "");
        return {
          text: result.result || "",
          sessionId: result.session_id,
          isError: hasError,
        };
      } catch {
        return { text: output, isError: isClaudeErrorResponse(output) };
      }
    }

    return { text: output.trim(), isError: false };
  } catch {
    clearTimeout(timeoutId);
    return { text: "", isError: true };
  }
}

/**
 * Run a Claude subprocess with timeout (simpler API for services).
 * Returns the raw output text. Kills process on timeout.
 */
export async function runClaudeWithTimeout(
  prompt: string,
  timeoutMs: number,
  options?: {
    allowedTools?: string[];
    cwd?: string;
  }
): Promise<string> {
  const baseCmd = [
    CLAUDE_PATH,
    "-p",
    prompt,
    "--output-format",
    "text",
    ...(options?.allowedTools
      ? ["--allowedTools", options.allowedTools.join(",")]
      : []),
  ];
  const cmd = IS_MACOS
    ? ["/usr/bin/caffeinate", "-i", ...baseCmd]
    : baseCmd;

  const proc = spawn({
    cmd,
    cwd: options?.cwd || process.cwd(),
    env: {
      ...process.env,
      HOME: HOME_DIR,
      PATH: process.env.PATH || "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);

  try {
    const output = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if (killed) throw new Error("Timeout");
    return output;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Friendly tool name mapping for progress updates
// ---------------------------------------------------------------------------

/**
 * Build a concise, informative progress string from tool name + input.
 * E.g. "Reading src/bot.ts" instead of just "Reading file".
 */
function friendlyToolName(toolName: string, input?: Record<string, any>): string {
  const shorten = (p: string, max = 40) => {
    // Strip common prefixes, keep just the meaningful part
    const short = p.replace(/^\/Users\/[^/]+\/[^/]+\/[^/]+\//, "");
    return short.length > max ? "..." + short.slice(-max) : short;
  };

  switch (toolName) {
    case "Read":
      return input?.file_path ? `Reading ${shorten(input.file_path)}` : "Reading file";
    case "Write":
      return input?.file_path ? `Writing ${shorten(input.file_path)}` : "Writing file";
    case "Edit":
      return input?.file_path ? `Editing ${shorten(input.file_path)}` : "Editing file";
    case "Glob":
      return input?.pattern ? `Finding ${input.pattern}` : "Searching files";
    case "Grep":
      return input?.pattern ? `Searching for "${input.pattern}"` : "Searching code";
    case "Bash": {
      const cmd = input?.command || "";
      // Extract the first meaningful word/command
      const first = cmd.split(/\s+/)[0]?.replace(/^.*\//, "") || "command";
      const desc = input?.description;
      if (desc) return desc.length > 50 ? desc.substring(0, 50) + "..." : desc;
      return `Running ${first}`;
    }
    case "WebSearch":
      return input?.query ? `Searching: ${input.query.substring(0, 40)}` : "Searching the web";
    case "WebFetch":
      return "Fetching web page";
    case "Task":
      return input?.description ? `${input.description}` : "Delegating task";
    case "AskUserQuestion":
      return "Asking a question";
    default:
      break;
  }

  // MCP tool: mcp__server__action → "Using server: action"
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const server = (parts[1] || "tool").replace(/-/g, " ");
    const action = parts[2] || "";
    const actionClean = action.replace(/_/g, " ");
    return actionClean ? `${server}: ${actionClean}` : `Using ${server}`;
  }

  return `Using ${toolName}`;
}

/**
 * Spawn Claude Code subprocess with streaming JSONL output.
 * Parses events in real time and fires callbacks for progress updates.
 * Returns the same ClaudeResult as callClaude() but with live progress.
 */
export async function callClaudeStreaming(options: ClaudeStreamOptions): Promise<ClaudeResult> {
  const {
    prompt,
    allowedTools,
    resumeSessionId,
    timeoutMs = 300_000,
    cwd,
    maxTurns,
    onToolStart,
    onFirstText,
  } = options;

  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];

  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  if (maxTurns) {
    args.push("--max-turns", maxTurns);
  }

  const cmd = IS_MACOS
    ? ["/usr/bin/caffeinate", "-i", CLAUDE_PATH, ...args]
    : [CLAUDE_PATH, ...args];

  const proc = spawn({
    cmd,
    cwd: cwd || process.cwd(),
    env: {
      ...process.env,
      HOME: HOME_DIR,
      PATH: process.env.PATH || "",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Timeout with proper process kill
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, timeoutMs);

  // Throttle tool progress (max 1 per 2s)
  let lastToolProgressAt = 0;
  const TOOL_THROTTLE_MS = 2_000;

  let sessionId: string | undefined;
  let resultText = "";
  let firstTextSent = false;
  let textAccumulator = "";

  try {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of proc.stdout) {
      if (timedOut) break;

      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // skip malformed lines
        }

        // Capture session_id from any event that has it
        if (event.session_id && !sessionId) {
          sessionId = event.session_id;
        }

        // Final result event
        if (event.type === "result") {
          resultText = event.result || "";
          sessionId = event.session_id || sessionId;
          console.log(`[streaming] Result received (${resultText.length} chars)`);
          continue;
        }

        // Assistant message → check for tool_use and text blocks
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            // Tool use → progress callback
            if (block.type === "tool_use") {
              const name = block.name || "tool";
              const display = friendlyToolName(name, block.input);
              console.log(`[streaming] Tool: ${display}`);
              if (onToolStart) {
                const now = Date.now();
                if (now - lastToolProgressAt >= TOOL_THROTTLE_MS) {
                  lastToolProgressAt = now;
                  onToolStart(display);
                }
              }
            }

            // Text block → accumulate for first-text callback
            if (block.type === "text" && block.text) {
              textAccumulator += block.text;

              if (!firstTextSent && onFirstText && textAccumulator.length > 30) {
                firstTextSent = true;
                const match = textAccumulator.match(/^.{30,150}?[.!?\n]/);
                const snippet = match ? match[0].trim() : textAccumulator.substring(0, 150).trim();
                console.log(`[streaming] First text: ${snippet.substring(0, 80)}`);
                onFirstText(snippet);
              }
            }
          }
        } else if (event.type !== "result" && event.type !== "system" && event.type !== "user" && event.type !== "rate_limit_event" && event.type !== "tool_use_summary") {
          console.log(`[streaming] Unknown event type: ${event.type}`);
        }
      }
    }

    clearTimeout(timeoutId);
    console.log(`[streaming] Stream ended. timedOut=${timedOut}, resultLen=${resultText.length}, accumulatorLen=${textAccumulator.length}`);

    if (timedOut) {
      return { text: "", isError: true };
    }

    // If no result event (shouldn't happen), use accumulated text
    if (!resultText && textAccumulator) {
      resultText = textAccumulator;
    }

    if (isClaudeErrorResponse(resultText)) {
      return { text: resultText, sessionId, isError: true };
    }

    return { text: resultText, sessionId, isError: false };
  } catch {
    clearTimeout(timeoutId);
    return { text: "", isError: true };
  }
}
