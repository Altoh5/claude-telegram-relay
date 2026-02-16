/**
 * Go - Fallback LLM Chain
 *
 * When Claude Code auth fails or times out, fall back to:
 * 1. OpenRouter (cloud - any model) — skipped if FALLBACK_OFFLINE_ONLY=true
 * 2. Ollama (local)
 *
 * This ensures the bot always responds, even during outages.
 *
 * Set FALLBACK_OFFLINE_ONLY=true in .env to skip OpenRouter and go
 * straight to Ollama for fully offline operation.
 */

const OPENROUTER_API_KEY = () => process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = () =>
  process.env.OPENROUTER_MODEL || "moonshotai/kimi-k2.5";
const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL || "qwen3-coder";
const FALLBACK_OFFLINE_ONLY = () =>
  process.env.FALLBACK_OFFLINE_ONLY === "true";

export type FallbackSource = "openrouter" | "ollama" | "none";

export interface FallbackResult {
  text: string;
  source: FallbackSource;
}

/**
 * Try fallback LLMs and return response with source tag appended.
 * The tag tells the user which backend actually responded.
 */
export async function callFallbackLLM(prompt: string): Promise<string> {
  const result = await callFallbackLLMWithSource(prompt);
  if (result.source !== "none") {
    return `${result.text}\n\n_(responded via ${result.source})_`;
  }
  return result.text;
}

/**
 * Try fallback LLMs and return both the response text and which backend responded.
 * Useful when callers need to log or route differently based on the source.
 */
export async function callFallbackLLMWithSource(
  prompt: string
): Promise<FallbackResult> {
  // Tier 1: OpenRouter (cloud) — skip if FALLBACK_OFFLINE_ONLY is set
  if (OPENROUTER_API_KEY() && !FALLBACK_OFFLINE_ONLY()) {
    try {
      console.log(
        `🔄 Fallback: trying OpenRouter (${OPENROUTER_MODEL()})...`
      );
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENROUTER_API_KEY()}`,
            "HTTP-Referer": "https://go-telegram-bot.local",
            "X-Title": "Go Telegram Bot",
          },
          body: JSON.stringify({
            model: OPENROUTER_MODEL(),
            messages: [{ role: "user", content: prompt }],
            max_tokens: 2048,
          }),
        }
      );

      if (response.ok) {
        const data = (await response.json()) as any;
        const msg = data.choices?.[0]?.message;
        const text = msg?.content || msg?.reasoning || "";
        if (text) {
          console.log(`✅ OpenRouter responded (${OPENROUTER_MODEL()})`);
          return { text, source: "openrouter" };
        }
      } else {
        console.error(
          `❌ OpenRouter error: ${response.status} ${await response.text()}`
        );
      }
    } catch (err) {
      console.error("❌ OpenRouter failed:", err);
    }
  } else if (FALLBACK_OFFLINE_ONLY()) {
    console.log("⏭️ Skipping OpenRouter (FALLBACK_OFFLINE_ONLY=true)");
  }

  // Tier 2: Ollama (local)
  try {
    console.log(`🔄 Fallback: trying Ollama (${OLLAMA_MODEL()})...`);
    const response = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL(),
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as any;
      const text = data.message?.content;
      if (text) {
        console.log(`✅ Ollama responded (${OLLAMA_MODEL()})`);
        return { text, source: "ollama" };
      }
    } else {
      console.error(`❌ Ollama error: ${response.status}`);
    }
  } catch (err) {
    console.error("❌ Ollama failed (is it running?):", err);
  }

  return {
    text: "I'm having trouble connecting to all my backends right now. Please try again in a few minutes.",
    source: "none",
  };
}
