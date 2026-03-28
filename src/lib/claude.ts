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

// Base env for all Claude subprocesses — strip CLAUDECODE so nested
// invocations aren't blocked by Claude Code's "nested session" guard.
function safeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "CLAUDECODE" && v !== undefined) env[k] = v;
  }
  env.HOME = HOME_DIR;
  env.PATH = process.env.PATH || "";
  return extra ? { ...env, ...extra } : env;
}

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
    "hit your limit",
    "usage limit",
    "usage cap",
    "message limit",
    "reached your limit",
    "out of messages",
    "no messages remaining",
    "upgrade to",
    "exceeds your plan",
    "plan limit",
    "token limit reached",
    "conversation limit",
    "prompt is too long",
    "context_length_exceeded",
    "tokens > ",
  ];
  const lower = text.toLowerCase();
  return errorPatterns.some((p) => lower.includes(p.toLowerCase()));
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

  const args = ["-p", prompt, "--output-format", outputFormat, "--dangerously-skip-permissions"];

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
    env: safeEnv(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : undefined),
    stdin: null, // Prevent subprocess from waiting on stdin (launchd has no tty)
    stdout: "pipe",
    stderr: "pipe",
  });

  console.log(`[claude] Subprocess spawned. pid=${proc.pid}, resume=${resumeSessionId ? "yes" : "no"}, timeout=${timeoutMs}ms`);

  // Timeout with proper process kill
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    console.error(`[claude] Subprocess timed out after ${timeoutMs}ms. Killing pid=${proc.pid}`);
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);

  try {
    const [output, stderrOutput] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timeoutId);

    // Log stderr for debugging
    if (stderrOutput.trim()) {
      console.error(`[claude] stderr: ${stderrOutput.trim().substring(0, 500)}`);
    }

    if (timedOut) {
      console.error("[claude] Subprocess timed out");
      // Timeout with a resume ID likely means stale/expired session — retry fresh
      if (resumeSessionId) {
        console.warn("[claude] Timed out with resume ID — likely stale session, retrying without resume...");
        return callClaude({ ...options, resumeSessionId: undefined });
      }
      return { text: "", isError: true };
    }

    // Log empty output for debugging
    if (!output.trim()) {
      console.error(`[claude] Empty stdout from subprocess. exitCode=${proc.exitCode}`);
      // Empty output with a resume ID likely means stale/expired session — retry fresh
      if (resumeSessionId) {
        console.warn("[claude] Empty output with resume ID — likely stale session, retrying without resume...");
        return callClaude({ ...options, resumeSessionId: undefined });
      }
      return { text: "", isError: true };
    }

    // Check for errors
    if (isClaudeErrorResponse(output)) {
      console.error(`[claude] Error response detected: ${output.substring(0, 200)}`);
      return { text: output, isError: true };
    }

    // Parse JSON output format
    if (outputFormat === "json") {
      try {
        const result = JSON.parse(output);

        // Detect stale session error — retry without resume
        if (result.subtype === "error_during_execution" && result.errors?.some((e: string) => e.includes("No conversation found with session ID"))) {
          console.warn("[claude] Stale session detected, retrying without resume...");
          if (resumeSessionId) {
            return callClaude({ ...options, resumeSessionId: undefined });
          }
        }

        // Log any error subtypes for debugging
        if (result.is_error || result.subtype?.startsWith("error")) {
          console.error(`[claude] Error result: subtype=${result.subtype}, errors=${JSON.stringify(result.errors || [])}`);
        }

        const hasError = result.subtype === "error_max_turns" || result.is_error || isClaudeErrorResponse(result.result || "");
        return {
          text: result.result || "",
          sessionId: result.session_id,
          isError: hasError,
        };
      } catch (parseErr) {
        console.error(`[claude] JSON parse failed: ${parseErr}. Raw output: ${output.substring(0, 300)}`);
        return { text: output, isError: isClaudeErrorResponse(output) };
      }
    }

    return { text: output.trim(), isError: false };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[claude] Exception in callClaude: ${err}`);
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
    extraArgs?: string[];
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
    ...(options?.extraArgs ?? []),
  ];
  const cmd = IS_MACOS
    ? ["/usr/bin/caffeinate", "-i", ...baseCmd]
    : baseCmd;

  const proc = spawn({
    cmd,
    cwd: options?.cwd || process.cwd(),
    env: safeEnv(),
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
    const [output, errOutput] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);
    if (killed) throw new Error("Timeout");
    if (!output && errOutput) throw new Error(errOutput.trim());
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
    env: safeEnv(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : undefined),
    stdin: null, // Prevent subprocess from waiting on stdin (launchd has no tty)
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

          // Detect stale session error — retry without resume
          if (event.subtype === "error_during_execution" && event.errors?.some((e: string) => e.includes("No conversation found with session ID"))) {
            console.warn("[streaming] Stale session detected, retrying without resume...");
            clearTimeout(timeoutId);
            if (resumeSessionId) {
              return callClaudeStreaming({ ...options, resumeSessionId: undefined });
            }
          }
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

    // Capture stderr for debugging
    let stderrText = "";
    try { stderrText = await new Response(proc.stderr).text(); } catch {}
    if (stderrText.trim()) {
      console.error(`[streaming] stderr: ${stderrText.trim().substring(0, 500)}`);
    }

    console.log(`[streaming] Stream ended. timedOut=${timedOut}, resultLen=${resultText.length}, accumulatorLen=${textAccumulator.length}`);

    if (timedOut) {
      // Timeout with a resume ID likely means stale/expired session — retry fresh
      if (resumeSessionId) {
        console.warn("[streaming] Timed out with resume ID — likely stale session, retrying without resume...");
        return callClaudeStreaming({ ...options, resumeSessionId: undefined });
      }
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
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[streaming] Exception: ${err}`);
    return { text: "", isError: true };
  }
}
