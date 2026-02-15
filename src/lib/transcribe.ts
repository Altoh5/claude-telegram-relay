/**
 * Voice Transcription Module
 *
 * Routes to Groq (cloud), Gemini (cloud), or whisper.cpp (local)
 * based on VOICE_PROVIDER env var.
 *
 * Providers:
 * - groq: Groq Cloud API (Whisper v3 Turbo, free tier: 2000/day)
 * - gemini: Google Gemini API (Gemini 2.0 Flash)
 * - local: Local whisper.cpp (offline, requires ffmpeg + whisper-cpp)
 */

import { spawn } from "bun";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";

const VOICE_PROVIDER = () => process.env.VOICE_PROVIDER || "";
const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY || "";

/**
 * Transcribe an audio buffer to text.
 * Returns empty string if no provider is configured.
 */
export async function transcribe(audioBuffer: Buffer): Promise<string> {
  const provider = VOICE_PROVIDER();

  if (!provider) return "";

  if (provider === "groq") {
    return transcribeGroq(audioBuffer);
  }

  if (provider === "gemini") {
    return transcribeGeminiBuffer(audioBuffer);
  }

  if (provider === "local") {
    return transcribeLocal(audioBuffer);
  }

  console.error(`Unknown VOICE_PROVIDER: ${provider}`);
  return "";
}

/**
 * Transcribe an audio file from a file path.
 * Auto-detects provider. Supports Groq, Gemini, and local whisper.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const provider = VOICE_PROVIDER();

  // Try Gemini if configured (even without VOICE_PROVIDER)
  if (provider === "gemini" || (!provider && GEMINI_API_KEY())) {
    return transcribeGeminiFile(filePath);
  }

  if (provider === "groq") {
    const buffer = await readFile(filePath);
    return transcribeGroq(buffer);
  }

  if (provider === "local") {
    const buffer = await readFile(filePath);
    return transcribeLocal(buffer);
  }

  if (!provider) return "";

  console.error(`Unknown VOICE_PROVIDER: ${provider}`);
  return "";
}

/**
 * Transcribe audio from an in-memory buffer using Gemini.
 * Used by the VPS gateway where files aren't written to disk.
 */
export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  mimeType: string = "audio/ogg"
): Promise<string> {
  if (!GEMINI_API_KEY()) {
    // Fall back to general transcribe
    return transcribe(audioBuffer);
  }

  try {
    const base64Audio = audioBuffer.toString("base64");

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
    console.error("Buffer transcription error:", error);
    return "[Transcription failed]";
  }
}

/**
 * Check if transcription is configured.
 */
export function isTranscriptionEnabled(): boolean {
  return !!(VOICE_PROVIDER() || GEMINI_API_KEY());
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function transcribeGroq(audioBuffer: Buffer): Promise<string> {
  const Groq = (await import("groq-sdk")).default;
  const groq = new Groq(); // reads GROQ_API_KEY from env

  const file = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

  const result = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3-turbo",
  });

  return result.text.trim();
}

async function transcribeGeminiFile(filePath: string): Promise<string> {
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

async function transcribeGeminiBuffer(audioBuffer: Buffer): Promise<string> {
  return transcribeAudioBuffer(audioBuffer, "audio/ogg");
}

async function transcribeLocal(audioBuffer: Buffer): Promise<string> {
  const whisperBinary = process.env.WHISPER_BINARY || "whisper-cpp";
  const modelPath = process.env.WHISPER_MODEL_PATH || "";

  if (!modelPath) {
    throw new Error("WHISPER_MODEL_PATH not set");
  }

  const timestamp = Date.now();
  const tmpDir = process.env.TMPDIR || "/tmp";
  const oggPath = join(tmpDir, `voice_${timestamp}.ogg`);
  const wavPath = join(tmpDir, `voice_${timestamp}.wav`);
  const txtPath = join(tmpDir, `voice_${timestamp}.txt`);

  try {
    // Write OGG to temp file
    await writeFile(oggPath, audioBuffer);

    // Convert OGG -> WAV via ffmpeg
    const ffmpeg = spawn(
      ["ffmpeg", "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath, "-y"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const ffmpegExit = await ffmpeg.exited;
    if (ffmpegExit !== 0) {
      const stderr = await new Response(ffmpeg.stderr).text();
      throw new Error(`ffmpeg failed (code ${ffmpegExit}): ${stderr}`);
    }

    // Transcribe via whisper.cpp
    const whisper = spawn(
      [whisperBinary, "--model", modelPath, "--file", wavPath, "--output-txt", "--output-file", join(tmpDir, `voice_${timestamp}`), "--no-prints"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const whisperExit = await whisper.exited;
    if (whisperExit !== 0) {
      const stderr = await new Response(whisper.stderr).text();
      throw new Error(`whisper-cpp failed (code ${whisperExit}): ${stderr}`);
    }

    // Read the output text file
    const text = await readFile(txtPath, "utf-8");
    return text.trim();
  } finally {
    // Cleanup temp files
    await unlink(oggPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
    await unlink(txtPath).catch(() => {});
  }
}
