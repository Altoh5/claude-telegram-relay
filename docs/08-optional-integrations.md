# Module 8: Optional Integrations

> This module covers the optional features you can enable: voice replies,
> phone calls, audio transcription, fallback LLMs, and AI news.

---

## Overview

All integrations are optional and degrade gracefully. If an API key is
missing, the feature is simply skipped -- no errors, no crashes.

| Integration | API Key | Feature |
|-------------|---------|---------|
| ElevenLabs | `ELEVENLABS_API_KEY` | Voice replies (TTS) |
| ElevenLabs + Twilio | Multiple keys | Outbound phone calls |
| Gemini | `GEMINI_API_KEY` | Voice message transcription |
| OpenRouter | `OPENROUTER_API_KEY` | Cloud fallback LLM |
| Ollama | None (local) | Local fallback LLM |
| xAI (Grok) | `XAI_API_KEY` | AI news in morning briefing |

---

## Voice Replies (ElevenLabs TTS)

**File:** `src/lib/voice.ts` (lines 21-61)

When voice is enabled, the bot responds to voice messages with audio
instead of text. The flow:

1. User sends a voice message
2. Bot transcribes it (Gemini)
3. Bot processes it with Claude
4. Bot converts Claude's response to speech (ElevenLabs)
5. Bot sends the audio file back to Telegram

### Configuration

```bash
# .env
ELEVENLABS_API_KEY=your_key
ELEVENLABS_VOICE_ID=your_voice_id
```

### How to Get a Voice ID

1. Go to [elevenlabs.io](https://elevenlabs.io)
2. Navigate to "Voices" in the dashboard
3. Choose a pre-made voice or clone your own
4. Copy the Voice ID from the voice settings

### How It Works

```typescript
export async function textToSpeech(text: string): Promise<Buffer | null> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID()}`,
    {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "xi-api-key": ELEVENLABS_API_KEY(),
      },
      body: JSON.stringify({
        text: voiceText,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );
  return Buffer.from(await response.arrayBuffer());
}
```

Text is truncated to 4500 characters to stay within ElevenLabs limits.
The function returns a Buffer containing MP3 audio, which Grammy sends
as a voice message on Telegram.

### Check if Enabled

```typescript
export function isVoiceEnabled(): boolean {
  return !!(ELEVENLABS_API_KEY() && ELEVENLABS_VOICE_ID());
}
```

---

## Phone Calls (ElevenLabs + Twilio)

**File:** `src/lib/voice.ts` (lines 66-149)

The bot can initiate outbound phone calls using ElevenLabs' conversational
AI agents with Twilio for telephony.

### Configuration

```bash
# .env
ELEVENLABS_API_KEY=your_key
ELEVENLABS_AGENT_ID=your_agent_id
ELEVENLABS_PHONE_NUMBER_ID=your_phone_number_id
USER_PHONE_NUMBER=+1234567890
```

### Prerequisites

1. ElevenLabs account with Conversational AI enabled
2. Create an agent in the ElevenLabs dashboard
3. Connect a Twilio phone number to the agent
4. Note the Agent ID and Phone Number ID

### How It Works

When triggered by "call me" in a message or by the smart check-in:

```typescript
const response = await fetch(
  "https://api.elevenlabs.io/v1/convai/twilio/outbound-call",
  {
    method: "POST",
    body: JSON.stringify({
      agent_id: ELEVENLABS_AGENT_ID(),
      agent_phone_number_id: ELEVENLABS_PHONE_NUMBER_ID(),
      to_number: USER_PHONE_NUMBER(),
      conversation_initiation_client_data: {
        dynamic_variables: {
          user_name: userName,
          current_time: berlinTime,
          call_reason: context,
          memory: memoryContext,
          recent_telegram: conversationHistory,
        },
      },
    }),
  }
);
```

The agent receives context about your goals, recent conversations,
and the reason for the call, so it can have an informed conversation.

### Transcript Processing

After a call ends, the bot polls for the transcript:

```typescript
export async function waitForTranscript(conversationId: string): Promise<string | null> {
  const maxAttempts = 90; // ~15 minutes
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const transcript = await getCallTranscript(conversationId);
    if (transcript) return transcript;
  }
  return null;
}
```

The transcript is saved to Supabase as a message with metadata type
`call_transcript`.

---

## Audio Transcription (Gemini)

**File:** `src/lib/transcribe.ts`

When someone sends a voice message on Telegram, it arrives as an OGG file.
The bot uses Gemini to transcribe it to text before sending to Claude.

### Configuration

```bash
# .env
GEMINI_API_KEY=your_gemini_key
```

### How It Works

```typescript
export async function transcribeAudio(filePath: string): Promise<string> {
  const audioBuffer = await readFile(filePath);
  const base64Audio = audioBuffer.toString("base64");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY()}`,
    {
      method: "POST",
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: "Transcribe this audio message accurately. Only output the transcription." },
            { inline_data: { mime_type: mimeType, data: base64Audio } },
          ],
        }],
      }),
    }
  );
}
```

Supported formats: OGG, MP3, WAV, M4A, WebM.

If Gemini is not configured, the bot returns a placeholder:
`[Voice transcription unavailable - no Gemini API key configured]`

---

## Fallback LLM Chain

**File:** `src/lib/fallback-llm.ts`

When Claude Code fails (auth error, rate limit, timeout), the bot
falls back to alternative LLMs:

### Tier 1: OpenRouter (Cloud)

```bash
# .env
OPENROUTER_API_KEY=your_key
OPENROUTER_MODEL=moonshotai/kimi-k2.5  # Optional, this is the default
```

OpenRouter proxies requests to many models. The default is Moonshot Kimi K2.5
but you can use any model available on OpenRouter.

```typescript
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  headers: {
    Authorization: `Bearer ${OPENROUTER_API_KEY()}`,
  },
  body: JSON.stringify({
    model: OPENROUTER_MODEL(),
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2048,
  }),
});
```

### Tier 2: Ollama (Local)

```bash
# .env (optional -- defaults shown)
OLLAMA_MODEL=qwen3-coder
```

Ollama runs models locally. No API key needed, but you must have
Ollama installed and running:

```bash
brew install ollama
ollama serve
ollama pull qwen3-coder
```

```typescript
const response = await fetch("http://localhost:11434/api/chat", {
  body: JSON.stringify({
    model: OLLAMA_MODEL(),
    messages: [{ role: "user", content: prompt }],
    stream: false,
  }),
});
```

### Fallback Chain Order

1. **Claude Code** (primary) -- full agentic capability
2. **OpenRouter** (cloud fallback) -- simpler but reliable
3. **Ollama** (local fallback) -- works offline
4. **Error message** -- "I'm having trouble connecting..."

Responses from fallback LLMs include a note: `_(responded via fallback)_`

---

## AI News (Grok/xAI)

**File:** `src/morning-briefing.ts` (lines 110-160)

Used in the morning briefing to include the latest AI news.

### Configuration

```bash
# .env
XAI_API_KEY=your_xai_key
```

### How It Works

Uses Grok's real-time search capability to find AI news from X/Twitter
and the web within the last 24 hours. Returns a concise summary of
up to 5 notable items.

The search configuration enables both X/Twitter and web sources:

```typescript
search: {
  mode: "auto",
  sources: [{ type: "x" }, { type: "web" }],
  recency_filter: "day",
},
```

---

## Adding Your Own Integrations

To add a new integration:

### 1. Create the Module

Add a new file in `src/lib/` (e.g., `src/lib/weather.ts`):

```typescript
const API_KEY = () => process.env.WEATHER_API_KEY || "";

export function isWeatherEnabled(): boolean {
  return !!API_KEY();
}

export async function getWeather(location: string): Promise<string> {
  if (!API_KEY()) return "";
  // Call your weather API
}
```

### 2. Add the Environment Variable

Add it to `.env.example`:

```bash
# WEATHER_API_KEY=your_key
```

### 3. Wire It Up

Import and use it where needed (bot.ts, morning-briefing.ts, etc.).

### 4. Update the Verify Script

Add a check in `setup/verify.ts` so the health check reports its status.

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/lib/voice.ts` | ElevenLabs TTS and phone calls |
| `src/lib/transcribe.ts` | Gemini audio transcription |
| `src/lib/fallback-llm.ts` | OpenRouter and Ollama fallback chain |
| `src/morning-briefing.ts` | xAI/Grok AI news integration |
| `.env.example` | All available environment variables |
| `setup/verify.ts` | Health check for optional integrations |

---

**Next module:** [09 - Hooks and Security](./09-hooks-security.md)
