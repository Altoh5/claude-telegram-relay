/**
 * Go - Audio Transcription (Optional)
 *
 * Uses Gemini for voice message transcription.
 * Falls back to a placeholder if not configured.
 */

import { readFile } from "fs/promises";

const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY || "";

/**
 * Transcribe an audio file using Gemini.
 * Supports OGG (Telegram voice), MP3, WAV, etc.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  if (!GEMINI_API_KEY()) {
    return "[Voice transcription unavailable - no Gemini API key configured]";
  }

  try {
    const audioBuffer = await readFile(filePath);
    const base64Audio = audioBuffer.toString("base64");

    // Detect MIME type from extension
    const ext = filePath.split(".").pop()?.toLowerCase() || "ogg";
    const mimeMap: Record<string, string> = {
      ogg: "audio/ogg",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      m4a: "audio/mp4",
      webm: "audio/webm",
    };
    const mimeType = mimeMap[ext] || "audio/ogg";

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: "Transcribe this audio message accurately. Only output the transcription, nothing else.",
                },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Audio,
                  },
                },
              ],
            },
          ],
        }),
      }
    );

    const result = await response.json();
    return (
      result.candidates?.[0]?.content?.parts?.[0]?.text ||
      "[Could not transcribe audio]"
    );
  } catch (error) {
    console.error("Transcription error:", error);
    return "[Transcription failed]";
  }
}

/**
 * Check if transcription is configured.
 */
export function isTranscriptionEnabled(): boolean {
  return !!GEMINI_API_KEY();
}
