/**
 * Model Router — Tiered Model Selection
 *
 * Extracts complexity classification from anthropic-processor.ts
 * into a standalone module. Used by both the legacy processor
 * and the new Agent SDK session manager.
 *
 * Distribution target: ~60% Haiku, ~30% Sonnet, ~10% Opus
 */

// ============================================================
// TYPES
// ============================================================

export type ModelTier = "haiku" | "sonnet" | "opus";

export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-6",
};

// Cost per million tokens (input / output)
export const MODEL_COSTS: Record<ModelTier, { input: number; output: number }> =
  {
    haiku: { input: 0.8, output: 4.0 },
    sonnet: { input: 3.0, output: 15.0 },
    opus: { input: 15.0, output: 75.0 },
  };

// ============================================================
// PATTERNS
// ============================================================

// Patterns that indicate simple requests (→ Haiku)
const SIMPLE_PATTERNS = [
  /^(hi|hey|hello|morning|good morning|gm|thanks|ok|yes|no|sure|got it)/i,
  /what('s| is) (the )?(time|date|day)/i,
  /^(check|show|list|get|find|search|look up)\b/i,
  /^(status|how many|count)\b/i,
  /unread email/i,
  /calendar today/i,
  /what('s| is) on my (plate|calendar|schedule)/i,
  /^remind me/i,
];

// Patterns that indicate complex requests (→ Opus)
const COMPLEX_PATTERNS = [
  /\b(analyze|analysis|evaluate|compare|contrast)\b/i,
  /\b(strategy|strategic|plan|roadmap|architecture)\b/i,
  /\b(write|draft|compose) .{50,}/i, // long writing requests
  /\b(research|investigate|deep dive)\b/i,
  /\b(decide|decision|should I|pros and cons)\b/i,
  /\b(explain|why|how does .{30,})\b/i, // complex explanations
  /\b(refactor|redesign|optimize|improve)\b/i,
  /\b(sponsor|partnership|brand deal|negotiate)\b/i,
  /\b(content strategy|video idea|script)\b/i,
];

// ============================================================
// CLASSIFIER
// ============================================================

/**
 * Classify message complexity to select the right model tier.
 * Zero overhead — pure regex matching, no API calls.
 */
export function classifyComplexity(message: string): ModelTier {
  // Check complex patterns first (Opus)
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(message)) return "opus";
  }

  // Check simple patterns (Haiku)
  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(message)) return "haiku";
  }

  // Short messages (< 40 chars) → Haiku
  if (message.length < 40) return "haiku";

  // Medium-length or unclear → Sonnet (good default)
  return "sonnet";
}

/**
 * Select model ID for a message, with optional budget-based downgrade.
 */
export function selectModelForMessage(
  message: string,
  budgetRemaining?: number
): { tier: ModelTier; model: string } {
  const tier = classifyComplexity(message);

  // Downgrade Opus → Sonnet if budget is running low (< $1 remaining)
  const effectiveTier =
    tier === "opus" && budgetRemaining !== undefined && budgetRemaining < 1.0
      ? "sonnet"
      : tier;

  return {
    tier: effectiveTier,
    model: MODEL_IDS[effectiveTier],
  };
}
