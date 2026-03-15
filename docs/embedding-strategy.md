# Embedding Strategy

> Last reviewed: March 2026

This document covers the embedding setup in GoBot, evaluates Google's new `gemini-embedding-2-preview` model, and documents the decision to continue with OpenAI embeddings.

---

## Current Setup

| Component | Model | Dimensions | Location |
|-----------|-------|------------|----------|
| Supabase edge functions | `text-embedding-3-small` | 1536 | `supabase/functions/store-telegram-message/`, `search-memory/` |
| Convex client | `text-embedding-3-small` | 1536 | `src/lib/convex-client.ts` |
| Asset store (image descriptions) | `text-embedding-3-small` | 1536 | `src/lib/asset-store.ts` |
| Supabase schema | VECTOR(1536) | 1536 | `db/schema.sql` |
| Convex schema | dimensions: 1536 | 1536 | `convex/schema.ts` |

All embeddings use OpenAI's `text-embedding-3-small` model. The `OPENAI_API_KEY` env var enables semantic search — without it, the bot falls back to text-based `.ilike()` search.

### How embeddings are generated

**Text messages (Supabase path):**
```
Telegram message → store-telegram-message edge function → OpenAI embeddings API → messages.embedding
```

**Text messages (Convex path):**
```
Message inserted → fire-and-forget backfill → OpenAI embeddings API → convex messages.embedding
```

**Assets (images):**
```
Image uploaded → Claude generates description → OpenAI embeddings API → assets.embedding
```

The asset approach embeds Claude's text description, not the raw image bytes.

---

## Google Gemini Embedding 2 — Evaluation

**Model:** `gemini-embedding-2-preview` (released March 10, 2026)

### Feature Comparison

| Factor | Gemini Embedding 2 | OpenAI text-embedding-3-small |
|--------|-------------------|-----------------------------|
| **Price (text)** | $0.20 / 1M tokens | **$0.02 / 1M tokens** |
| **Dimensions** | 3,072 (MRL-adjustable: 128–3,072) | 1,536 (adjustable: 256–1,536) |
| **MTEB English** | **68.32** | ~62 |
| **MTEB Multilingual** | **69.9** (100+ languages) | Moderate |
| **Context window** | 8,192 tokens | 8,191 tokens |
| **Multimodal** | Text, Image, Audio, Video, PDF | Text only |
| **GA status** | **Preview only** | GA |
| **Image limit per request** | Max 6 images | N/A |
| **Vector space** | Incompatible with OpenAI | — |

### The Multimodal Advantage

`gemini-embedding-2-preview` is the first major API embedding model to embed all modalities (text, images, audio, video) into a **single unified vector space**. This means you can embed a raw image and a text query and retrieve them via cosine similarity — without needing an intermediate text description step.

For GoBot's asset pipeline, this would simplify:
```
Before: Image → Claude describes it → text-embedding-3-small → 1536-dim vector
After:  Image → gemini-embedding-2 → 3072-dim vector
```

---

## Decision: Stay with OpenAI (for now)

### Why NOT switching

**1. Cost — 10x more expensive for text**
The primary embedding workload is short Telegram messages. At $0.20/M vs $0.02/M, switching would increase embedding costs by 10x with no benefit for pure-text messages.

**2. Breaking migration required**
Vector spaces are incompatible between providers. Switching would require:
- Re-embedding all messages in Supabase (`messages.embedding`)
- Re-embedding all assets in Supabase (`assets.embedding`)
- Re-embedding all messages in Convex
- Schema changes: Convex vector indexes are immutable once created (requires table recreation)
- Dimension changes: from 1536 → chosen new size (e.g. 768 or 3072)

**3. Preview status**
No SLA, no Provisioned Throughput on Vertex AI, API shape could change before GA.

**4. Asset multimodal benefit is marginal here**
Claude's image descriptions already capture semantic meaning well. The direct image embedding path eliminates the description step but doesn't provide meaningfully better retrieval for GoBot's conversational search patterns.

**5. Short messages don't benefit from quality uplift**
The MTEB improvement (62 → 68) is measured on long-document benchmarks. Short Telegram messages (typically <100 tokens) won't see the same gains.

### When to reconsider

| Trigger | Why |
|---------|-----|
| Model reaches GA | Removes SLA risk |
| Cost parity with OpenAI | Removes the 10x cost penalty |
| ASEAN multilingual at scale | Gemini's multilingual lead matters at volume (Malay, Filipino, Chinese) |
| Direct video/audio retrieval needed | Only Gemini can embed these natively |
| Consolidating to a single Google AI API key | If already paying Gemini for LLM use, one less vendor |

---

## Migration Path (if/when the time comes)

If the decision changes, here's the migration checklist:

### 1. Choose target dimensions
Google recommends 768 dims as the sweet spot (quality vs cost). At 1536 (matching current schema) via MRL truncation, you avoid schema changes but sacrifice some quality.

### 2. Add Google AI SDK
```bash
bun add @google/generative-ai
```

### 3. Update embedding generator
Replace `src/lib/convex-client.ts` `generateEmbedding()` and `src/lib/asset-store.ts` `generateEmbedding()` with:
```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genai.getGenerativeModel({ model: "gemini-embedding-2-preview" });

async function generateEmbedding(text: string): Promise<number[]> {
  const result = await model.embedContent({
    content: { parts: [{ text }], role: "user" },
    taskType: "RETRIEVAL_DOCUMENT",
    outputDimensionality: 1536, // or 768 if changing schema
  });
  return result.embedding.values;
}
```

### 4. Update Supabase edge functions
Replace OpenAI calls in `supabase/functions/store-telegram-message/index.ts` and `search-memory/index.ts`.

### 5. Schema migration (if changing dimensions)
```sql
-- Only needed if changing from 1536 to a different size
ALTER TABLE messages DROP COLUMN embedding;
ALTER TABLE messages ADD COLUMN embedding VECTOR(768);

ALTER TABLE assets DROP COLUMN embedding;
ALTER TABLE assets ADD COLUMN embedding VECTOR(768);

-- Recreate match functions with new dimensions
```

For Convex: vector indexes cannot be modified. Requires creating new tables or a full data migration.

### 6. Re-embed existing data
Run a backfill script against all existing messages and assets. At typical GoBot usage volumes this is a one-time batch job.

### 7. Update `.env.example`
Replace `OPENAI_API_KEY` with `GEMINI_API_KEY` (or support both during transition).
