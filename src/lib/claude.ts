/**
 * Go - Claude Code Subprocess Spawner
 *
 * Spawns claude CLI as a subprocess for AI processing.
 * Handles session resumption, timeouts, and cleanup.
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
    "API Error: 401",
    "API Error: 403",
    "API Error: 429",
    "OAuth token has expired",
    "Failed to authenticate",
    "invalid_api_key",
    "overloaded_error",
    "rate_limit_error",
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
        return {
          text: result.result || output,
          sessionId: result.session_id,
          isError: isClaudeErrorResponse(result.result || ""),
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
    "--dangerously-skip-permissions",
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
