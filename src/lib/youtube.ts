/**
 * Go - YouTube Transcript Fetcher
 *
 * Detects YouTube URLs in messages and fetches transcripts via Supadata API.
 * Used as context enrichment before sending messages to Claude.
 */

const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY || "";
const SUPADATA_BASE = "https://api.supadata.ai/v1";

/** Regex that matches YouTube URLs and extracts the video ID */
const YOUTUBE_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/gi;

export interface YouTubeTranscript {
  videoId: string;
  url: string;
  transcript: string;
  lang: string;
}

/**
 * Check if Supadata is configured.
 */
export function isSupadataEnabled(): boolean {
  return !!SUPADATA_API_KEY;
}

/**
 * Extract all YouTube video IDs from a text string.
 */
export function extractYouTubeIds(text: string): { videoId: string; url: string }[] {
  const results: { videoId: string; url: string }[] = [];
  const seen = new Set<string>();

  let match;
  YOUTUBE_RE.lastIndex = 0;
  while ((match = YOUTUBE_RE.exec(text)) !== null) {
    const videoId = match[1];
    if (!seen.has(videoId)) {
      seen.add(videoId);
      results.push({ videoId, url: match[0] });
    }
  }
  return results;
}

/**
 * Fetch a YouTube transcript via Supadata API.
 * Returns plain text transcript or null on failure.
 */
async function fetchTranscript(videoId: string): Promise<{ text: string; lang: string } | null> {
  try {
    const url = `${SUPADATA_BASE}/youtube/transcript?videoId=${videoId}&text=true`;
    const res = await fetch(url, {
      headers: { "x-api-key": SUPADATA_API_KEY },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[youtube] Supadata transcript failed for ${videoId}: HTTP ${res.status} ${body.substring(0, 200)}`);
      return null;
    }

    const data = await res.json() as { content: string; lang: string };
    if (!data.content || typeof data.content !== "string") {
      console.warn(`[youtube] Empty transcript for ${videoId}`);
      return null;
    }

    return { text: data.content, lang: data.lang || "unknown" };
  } catch (err: any) {
    console.error(`[youtube] Transcript fetch error for ${videoId}:`, err?.message || err);
    return null;
  }
}

/**
 * Given a message, detect YouTube URLs and fetch their transcripts.
 * Returns an array of successfully fetched transcripts.
 */
export async function getYouTubeTranscripts(message: string): Promise<YouTubeTranscript[]> {
  if (!SUPADATA_API_KEY) return [];

  const videos = extractYouTubeIds(message);
  if (videos.length === 0) return [];

  console.log(`[youtube] Found ${videos.length} YouTube URL(s), fetching transcripts...`);

  const results = await Promise.all(
    videos.map(async ({ videoId, url }) => {
      const result = await fetchTranscript(videoId);
      if (!result) return null;
      console.log(`[youtube] Got transcript for ${videoId} (${result.text.length} chars, lang=${result.lang})`);
      return { videoId, url, transcript: result.text, lang: result.lang } as YouTubeTranscript;
    })
  );

  return results.filter((r): r is YouTubeTranscript => r !== null);
}

/**
 * Enrich a user message with YouTube transcripts.
 * Prepends transcript context if YouTube URLs are found.
 * Returns the original message unchanged if no transcripts found.
 */
export async function enrichWithTranscripts(message: string): Promise<string> {
  const transcripts = await getYouTubeTranscripts(message);
  if (transcripts.length === 0) return message;

  const sections = transcripts.map((t) => {
    // Truncate very long transcripts to avoid blowing up the prompt
    const MAX_CHARS = 30_000;
    const text = t.transcript.length > MAX_CHARS
      ? t.transcript.substring(0, MAX_CHARS) + "\n\n[Transcript truncated...]"
      : t.transcript;
    return `[YouTube Transcript — ${t.url} (${t.lang})]\n${text}`;
  });

  return `${sections.join("\n\n")}\n\n${message}`;
}
