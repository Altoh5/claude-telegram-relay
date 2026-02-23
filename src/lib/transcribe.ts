/**
 * Go - Audio Transcription (Optional)
 *
 * Uses Groq Whisper (cloud) for voice message transcription.
 * Falls back to a placeholder if not configured.
 */

import { readFile } from "fs/promises";

/**
 * Transcribe an audio file using Groq Whisper.
 * Supports OGG (Telegram voice), MP3, WAV, etc.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  if (!process.env.GROQ_API_KEY) {
    return "[Voice transcription unavailable - no GROQ_API_KEY configured]";
  }

  try {
    const audioBuffer = await readFile(filePath);
    return transcribeWithGroq(audioBuffer, filePath.split("/").pop() || "voice.ogg");
  } catch (error) {
    console.error("Transcription error:", error);
    return "[Transcription failed]";
  }
}

/**
 * Transcribe audio from an in-memory buffer using Groq Whisper.
 * Used by the VPS gateway where files aren't written to disk.
 */
export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  _mimeType: string = "audio/ogg"
): Promise<string> {
  if (!process.env.GROQ_API_KEY) {
    return "[Voice transcription unavailable - no GROQ_API_KEY configured]";
  }

  try {
    return transcribeWithGroq(audioBuffer, "voice.ogg");
  } catch (error) {
    console.error("Buffer transcription error:", error);
    return "[Transcription failed]";
  }
}

/**
 * Core Groq Whisper transcription.
 */
async function transcribeWithGroq(audioBuffer: Buffer, filename: string): Promise<string> {
  const Groq = (await import("groq-sdk")).default;
  const groq = new Groq(); // reads GROQ_API_KEY from env

  const file = new File([audioBuffer], filename, { type: "audio/ogg" });

  const result = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3-turbo",
  });

  return result.text.trim();
}

/**
 * Check if transcription is configured.
 */
export function isTranscriptionEnabled(): boolean {
  return !!process.env.GROQ_API_KEY;
}
