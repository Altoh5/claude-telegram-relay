/**
 * Resilient Anthropic Client — Auto Anthropic→OpenRouter Failover
 *
 * v2.7.0: Wraps the Anthropic SDK with automatic failover to OpenRouter
 * when Anthropic credits are exhausted or the API is unavailable.
 *
 * Features:
 * - Tries Anthropic first; falls back to OpenRouter on credit errors
 * - Re-checks Anthropic availability every 15 minutes
 * - OpenRouter is fully optional (degrades gracefully if key not set)
 * - Model name mapping between Anthropic and OpenRouter formats
 * - Shared state so all processors coordinate on availability
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODEL_IDS, type ModelTier } from "./model-router";

// ============================================================
// STATE
// ============================================================

let _client: Anthropic | null = null;
let _anthropicDown = false;
let _anthropicDownSince = 0;
const RECHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// ============================================================
// AVAILABILITY MANAGEMENT
// ============================================================

/**
 * Mark Anthropic as unavailable (credit exhausted, persistent error).
 * Will automatically re-check after RECHECK_INTERVAL_MS.
 */
export function markAnthropicDown(): void {
  if (!_anthropicDown) {
    console.warn("[resilient] Anthropic marked as unavailable — routing to OpenRouter");
    _anthropicDown = true;
    _anthropicDownSince = Date.now();
  }
}

/**
 * Mark Anthropic as available again.
 */
export function markAnthropicUp(): void {
  if (_anthropicDown) {
    console.log("[resilient] Anthropic marked as available again");
    _anthropicDown = false;
    _anthropicDownSince = 0;
  }
}

/**
 * Check if Anthropic is currently considered available.
 * Automatically resets after RECHECK_INTERVAL_MS.
 */
export function isAnthropicAvailable(): boolean {
  if (!_anthropicDown) return true;

  // Auto-reset after recheck interval
  if (Date.now() - _anthropicDownSince >= RECHECK_INTERVAL_MS) {
    console.log("[resilient] Re-checking Anthropic availability...");
    markAnthropicUp();
    return true;
  }

  return false;
}

// ============================================================
// CREDIT ERROR DETECTION
// ============================================================

/**
 * Check if an error indicates credit exhaustion or billing issue.
 */
export function isCreditError(err: any): boolean {
  const msg = String(err?.message || err || "").toLowerCase();
  const status = err?.status;

  // HTTP 402 Payment Required
  if (status === 402) return true;

  const creditPatterns = [
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
  ];

  return creditPatterns.some((p) => msg.includes(p));
}

// ============================================================
// CLIENT FACTORY
// ============================================================

/**
 * Get (or create) the Anthropic client.
 * Throws if ANTHROPIC_API_KEY is not set.
 */
export function getResilientClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// ============================================================
// OPENROUTER HELPERS
// ============================================================

/**
 * Get OpenRouter environment configuration for subprocess injection.
 * Returns env overrides needed to route Claude Code subprocess via OpenRouter.
 */
export function getOpenRouterEnv(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return {};

  return {
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
  };
}

/**
 * Map an Anthropic model ID to its OpenRouter equivalent.
 * OpenRouter uses the same model IDs under the `anthropic/` namespace.
 */
export function getModelForProvider(
  model: string,
  useOpenRouter: boolean
): string {
  if (!useOpenRouter) return model;

  // OpenRouter uses anthropic/ prefix for Anthropic models
  if (!model.startsWith("anthropic/")) {
    return `anthropic/${model}`;
  }
  return model;
}

// ============================================================
// MODEL MAPPING
// ============================================================

/**
 * Convert a MODEL_IDS tier value to its OpenRouter equivalent.
 * Used by agent-session when routing via OpenRouter.
 */
export function toOpenRouterModel(model: string): string {
  return getModelForProvider(model, true);
}

// ============================================================
// RESILIENT MESSAGE CREATE
// ============================================================

/**
 * Create an Anthropic message with automatic OpenRouter failover.
 *
 * 1. If Anthropic is marked down, go straight to OpenRouter
 * 2. Try Anthropic first
 * 3. On credit error: mark Anthropic down, retry via OpenRouter
 * 4. Other errors: re-throw (caller decides how to handle)
 */
export async function createResilientMessage(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const hasOpenRouter = !!openRouterKey;

  // If Anthropic is down and we have OpenRouter, go straight there
  if (!isAnthropicAvailable() && hasOpenRouter) {
    console.log("[resilient] Anthropic down — routing to OpenRouter");
    return createViaOpenRouter(params, openRouterKey!);
  }

  // Try Anthropic first
  try {
    const client = getResilientClient();
    const result = await client.messages.create(params);
    // Success — ensure Anthropic is marked as available
    markAnthropicUp();
    return result;
  } catch (err: any) {
    if (isCreditError(err)) {
      console.warn("[resilient] Anthropic credit error:", err.message);
      markAnthropicDown();

      if (hasOpenRouter) {
        console.log("[resilient] Retrying via OpenRouter...");
        return createViaOpenRouter(params, openRouterKey!);
      }
    }
    // Re-throw for caller to handle
    throw err;
  }
}

/**
 * Create a message via OpenRouter using Anthropic-compatible API.
 * OpenRouter accepts the same request format as Anthropic.
 */
async function createViaOpenRouter(
  params: Anthropic.MessageCreateParamsNonStreaming,
  apiKey: string
): Promise<Anthropic.Message> {
  const openRouterModel = getModelForProvider(params.model, true);

  const orClient = new Anthropic({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://go-telegram-bot.local",
      "X-Title": "Go Telegram Bot",
    },
  });

  return orClient.messages.create({
    ...params,
    model: openRouterModel,
  }) as Promise<Anthropic.Message>;
}
