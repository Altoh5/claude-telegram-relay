# Voice Integration: ElevenLabs + Twilio vs Vapi

> **TL;DR:** Keep ElevenLabs + Twilio for now — it works and voice quality is excellent. Evaluate Vapi if you want Claude as the live call brain, inbound calls, or WebRTC.

---

## Current Architecture

```
GoBot triggers phone call
       ↓
ElevenLabs Conversational AI
  ├── STT: ElevenLabs built-in
  ├── LLM: ElevenLabs' own model (context primed via /context endpoint)
  └── TTS: ElevenLabs voices (best in class)
       ↓
Twilio (carrier layer only)
  └── Connects the call to your phone number
       ↓
Your phone (outbound only)
       ↓
Call ends → ElevenLabs webhook → GoBot receives transcript
  └── summarizeTranscript() + extractTaskFromTranscript()
```

### Key files

| File | Role |
|------|------|
| `src/lib/voice.ts` | `initiatePhoneCall()`, `getCallTranscript()`, `buildVoiceAgentContext()` |
| `src/vps-gateway.ts` | ElevenLabs webhook handler, `/context` endpoint |
| `src/lib/anthropic-processor.ts` | `phone_call` tool registration |

### Required env vars

```
ELEVENLABS_API_KEY
ELEVENLABS_AGENT_ID
ELEVENLABS_PHONE_NUMBER_ID
USER_PHONE_NUMBER
```

Twilio is configured **inside ElevenLabs dashboard**, not in GoBot's `.env`. GoBot only calls `https://api.elevenlabs.io/v1/convai/twilio/outbound-call`.

---

## What Vapi Is

Vapi is an all-in-one voice AI platform that manages the entire STT → LLM → TTS pipeline. Unlike ElevenLabs (which bundles its own LLM), Vapi lets you supply **any LLM** including Claude. Vapi handles PSTN via Twilio/Vonage under the hood — you don't configure Twilio separately.

**The Skills/MCP announcement** (what prompted this comparison) is a *developer tooling* release: a structured Claude Code package that helps you call Vapi APIs correctly. It's better DX for *building* Vapi integrations, not a new voice product.

---

## Side-by-Side Comparison

| Dimension | Current (ElevenLabs + Twilio) | Vapi |
|---|---|---|
| **Architecture** | ElevenLabs handles voice agent; Twilio is carrier only | Single platform handles everything end-to-end |
| **Voice quality (TTS)** | ElevenLabs voices (best in class) | Pluggable — ElevenLabs, Azure, Deepgram, etc. |
| **STT** | ElevenLabs built-in | Pluggable (Deepgram, AssemblyAI, Gladia) |
| **LLM during call** | ElevenLabs' own model | Any LLM you choose, including Claude |
| **Claude as live call brain** | ❌ Only pre-call context via `/context` endpoint | ✅ Claude can be the live LLM during the call |
| **Latency** | ~800ms–1.5s | ~600ms–1s (comparable) |
| **Outbound calls** | ✅ via ElevenLabs → Twilio | ✅ native |
| **Inbound calls** | ❌ not in GoBot currently | ✅ native |
| **WebRTC (browser/app)** | ❌ | ✅ |
| **Call transfer / squads** | ❌ | ✅ multi-agent routing |
| **Webhook on call end** | ✅ ElevenLabs webhook | ✅ Vapi webhook |
| **Post-call task extraction** | ✅ `extractTaskFromTranscript()` | ✅ same approach works |
| **MCP integration** | ❌ would need custom tool | ✅ Vapi MCP lets Claude call Vapi APIs directly |
| **Setup complexity** | Medium — two dashboards to configure | Low — one dashboard, Vapi handles PSTN |
| **Bring your own Twilio** | Required | Optional |
| **Cost** | ElevenLabs ~$0.10/min + Twilio ~$0.013/min | Vapi ~$0.05–0.10/min + LLM token costs |
| **GoBot integration effort** | ✅ Already done | ~2–4 hours to swap `voice.ts` |
| **Status in GoBot** | ✅ Production | ❌ Not implemented |

---

## The MCP Angle Explained

With Vapi's MCP server installed in Claude Code, GoBot could let Claude *during a session* call `vapi.create-call` or `vapi.create-assistant` directly — dynamically building and launching a call with a custom prompt on-the-fly.

**Current ElevenLabs approach:** Agent is pre-configured in the ElevenLabs dashboard. GoBot triggers it by sending dynamic variables (memory, context, recent chat) to a fixed agent.

**Vapi + MCP approach:** Claude could build a brand-new voice assistant with a custom system prompt, then immediately place a call — all in one tool call, no dashboard required.

**However:** For GoBot's *runtime* use case (bot receives Telegram message → triggers call), you still need server-side API calls, not MCP. MCP is most useful for the *developer* setting up Vapi or for sessions where Claude is actively working. The running bot daemon cannot use MCP servers at runtime.

---

## Recommendation

### Short term: Keep ElevenLabs + Twilio

- Integration is complete and tested
- ElevenLabs voice quality is excellent
- Pre-call context injection via `/context` endpoint works well for most check-in use cases
- Switching adds ~2–4 hours of work without clear gain for the current Telegram → phone flow

### Evaluate Vapi if you want any of the following

1. **Claude as the live call brain** — Vapi lets Claude reason *during* the call, not just receive pre-baked context. This enables dynamic responses, tool use during calls, and real memory updates mid-conversation.

2. **Inbound calls** — User calls a dedicated number, bot picks up. ElevenLabs + Twilio in GoBot is outbound-only.

3. **WebRTC** — Voice chat in a web UI or mobile app, no phone number required.

4. **Dynamic agent creation** — Build a different agent per call based on context, without touching the dashboard.

5. **Simplified setup for new users** — One service vs two reduces onboarding friction for community members.

---

## Migration Guide (if you decide to switch)

### Step 1 — Sign up and get credentials

```
VAPI_API_KEY=your_vapi_api_key
VAPI_PHONE_NUMBER_ID=your_vapi_phone_number_id   # or use Vapi's number
USER_PHONE_NUMBER=+1234567890
```

### Step 2 — Create a Vapi assistant

Either via the Vapi dashboard or dynamically via API. For GoBot's use case, create a persistent assistant with Claude as the LLM and your preferred TTS voice.

```typescript
// Example Vapi assistant config
const assistant = {
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    systemPrompt: "You are Go, a personal AI assistant...",
  },
  voice: {
    provider: "elevenlabs",
    voiceId: "your_elevenlabs_voice_id",
  },
  firstMessage: "Hey! What's on your mind?",
};
```

### Step 3 — Replace `initiatePhoneCall()` in `src/lib/voice.ts`

```typescript
// Replace the ElevenLabs call with:
const response = await fetch("https://api.vapi.ai/call/phone", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${VAPI_API_KEY()}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    assistantId: VAPI_ASSISTANT_ID(),
    phoneNumberId: VAPI_PHONE_NUMBER_ID(),
    customer: { number: USER_PHONE_NUMBER() },
    assistantOverrides: {
      model: {
        messages: [
          {
            role: "system",
            content: `Context: ${context}\nMemory: ${memoryContext}`,
          },
        ],
      },
    },
  }),
});
```

### Step 4 — Update webhook handler in `src/vps-gateway.ts`

Replace the ElevenLabs webhook handler with Vapi's webhook format. Vapi sends `call.ended` events with the transcript.

### Step 5 — Remove ElevenLabs env vars

```
# Remove from .env:
ELEVENLABS_AGENT_ID
ELEVENLABS_PHONE_NUMBER_ID

# Keep (if using ElevenLabs voice via Vapi):
ELEVENLABS_API_KEY

# Add:
VAPI_API_KEY
VAPI_ASSISTANT_ID
VAPI_PHONE_NUMBER_ID
```

---

## Related Files

- `src/lib/voice.ts` — Current ElevenLabs implementation
- `src/vps-gateway.ts` — Webhook handler (lines handling `elevenlabs-webhook` route)
- `src/lib/anthropic-processor.ts` — `phone_call` tool definition
- `docs/architecture.md` — Overall system architecture
