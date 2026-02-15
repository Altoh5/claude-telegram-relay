/**
 * Fallback LLM Chain
 *
 * When Claude Code auth fails or times out, fall back to:
 * 1. OpenRouter (cloud - any model)
 * 2. Ollama (local)
 *
 * This ensures the bot always responds, even during outages.
 */

const OPENROUTER_API_KEY = () => process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = () =>
  process.env.OPENROUTER_MODEL || "moonshotai/kimi-k2.5";
const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL || "qwen3-coder";

/**
 * Try OpenRouter first, then Ollama. Returns response text.
 */
export async function callFallbackLLM(prompt: string): Promise<string> {
  // Tier 1: OpenRouter
  if (OPENROUTER_API_KEY()) {
    try {
      console.log(`Fallback: trying OpenRouter (${OPENROUTER_MODEL()})...`);
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENROUTER_API_KEY()}`,
            "HTTP-Referer": "https://claude-telegram-relay.local",
            "X-Title": "Claude Telegram Relay",
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
          console.log(`OpenRouter responded (${OPENROUTER_MODEL()})`);
          return text;
        }
      } else {
        console.error(
          `OpenRouter error: ${response.status} ${await response.text()}`
        );
      }
    } catch (err) {
      console.error("OpenRouter failed:", err);
    }
  }

  // Tier 2: Ollama (local)
  try {
    console.log(`Fallback: trying Ollama (${OLLAMA_MODEL()})...`);
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
        console.log(`Ollama responded (${OLLAMA_MODEL()})`);
        return text;
      }
    } else {
      console.error(`Ollama error: ${response.status}`);
    }
  } catch (err) {
    console.error("Ollama failed (is it running?):", err);
  }

  return "I'm having trouble connecting to all my backends right now. Please try again in a few minutes.";
}
