/**
 * Go - Voice Module (Optional)
 *
 * ElevenLabs text-to-speech and phone call integration.
 * All functions gracefully skip if API keys aren't configured.
 */

import * as supabase from "./supabase";

const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = () => process.env.ELEVENLABS_VOICE_ID || "";
const ELEVENLABS_AGENT_ID = () => process.env.ELEVENLABS_AGENT_ID || "";
const ELEVENLABS_PHONE_NUMBER_ID = () =>
  process.env.ELEVENLABS_PHONE_NUMBER_ID || "";
const USER_PHONE_NUMBER = () => process.env.USER_PHONE_NUMBER || "";

/**
 * Convert text to speech using ElevenLabs.
 * Returns audio buffer (mp3) or null if not configured.
 */
export async function textToSpeech(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY() || !ELEVENLABS_VOICE_ID()) {
    return null;
  }

  try {
    const voiceText =
      text.length > 4500 ? text.substring(0, 4500) + "..." : text;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID()}`,
      {
        method: "POST",
        headers: {
          Accept: "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY(),
        },
        body: JSON.stringify({
          text: voiceText,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!response.ok) {
      console.error(`ElevenLabs TTS error: ${response.status}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error("TTS error:", error);
    return null;
  }
}

/**
 * Initiate a phone call via ElevenLabs + Twilio.
 */
export async function initiatePhoneCall(
  context: string,
  userName: string = "User"
): Promise<{
  success: boolean;
  message: string;
  conversationId?: string;
}> {
  if (
    !ELEVENLABS_API_KEY() ||
    !ELEVENLABS_AGENT_ID() ||
    !ELEVENLABS_PHONE_NUMBER_ID() ||
    !USER_PHONE_NUMBER()
  ) {
    return { success: false, message: "Phone call not configured" };
  }

  try {
    console.log("📞 Initiating phone call...");

    // Get context for the call
    const memoryContext = await supabase.getMemoryContext();
    const chatId = process.env.TELEGRAM_USER_ID || "";
    const recentMessages = await supabase.getRecentMessages(chatId, 10);
    const conversationHistory = recentMessages
      .map((m) => {
        const role = m.role === "user" ? userName : "Bot";
        return `${role}: ${m.content.substring(0, 200)}`;
      })
      .join("\n");

    const berlinTime = new Date().toLocaleString("en-US", {
      timeZone: process.env.USER_TIMEZONE || "UTC",
      weekday: "long",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const response = await fetch(
      "https://api.elevenlabs.io/v1/convai/twilio/outbound-call",
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: ELEVENLABS_AGENT_ID(),
          agent_phone_number_id: ELEVENLABS_PHONE_NUMBER_ID(),
          to_number: USER_PHONE_NUMBER(),
          conversation_initiation_client_data: {
            dynamic_variables: {
              user_name: userName,
              current_time: berlinTime,
              call_reason: context || "general check-in",
              memory: memoryContext.substring(0, 1000),
              recent_telegram: conversationHistory.substring(0, 2000),
            },
          },
          first_message: context
            ? `Hey ${userName}! ${context.substring(0, 100)}. What do you think?`
            : `Hey ${userName}! Just checking in. What's on your mind?`,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("Call error:", response.status, error);
      return { success: false, message: error };
    }

    const result = await response.json();
    return {
      success: true,
      message: result.message || "Call started!",
      conversationId: result.conversation_id,
    };
  } catch (error) {
    console.error("Phone call error:", error);
    return { success: false, message: String(error) };
  }
}

/**
 * Fetch call transcript from ElevenLabs API.
 */
export async function getCallTranscript(
  conversationId: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
      { headers: { "xi-api-key": ELEVENLABS_API_KEY() } }
    );

    if (!response.ok) return null;

    const data = await response.json();
    if (data.status !== "done") return null;

    return (
      data.transcript
        ?.map(
          (msg: any) =>
            `${msg.role === "agent" ? "Bot" : "User"}: ${msg.message}`
        )
        .join("\n") || ""
    );
  } catch {
    return null;
  }
}

/**
 * Poll for call transcript completion (up to 15 min).
 */
export async function waitForTranscript(
  conversationId: string
): Promise<string | null> {
  const maxAttempts = 90;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const transcript = await getCallTranscript(conversationId);
    if (transcript) return transcript;
  }
  return null;
}

/**
 * Check if voice features are configured.
 */
export function isVoiceEnabled(): boolean {
  return !!(ELEVENLABS_API_KEY() && ELEVENLABS_VOICE_ID());
}

/**
 * Check if phone calls are configured.
 */
export function isCallEnabled(): boolean {
  return !!(
    ELEVENLABS_API_KEY() &&
    ELEVENLABS_AGENT_ID() &&
    ELEVENLABS_PHONE_NUMBER_ID() &&
    USER_PHONE_NUMBER()
  );
}
