/**
 * Asset Store — Persistent image/file storage with AI descriptions
 *
 * Uses Supabase Storage for files and `assets` table for metadata.
 *
 * Two flows depending on processing mode:
 *
 * MAC (Claude Code CLI / subscription auth):
 * 1. Image received → saved locally + uploaded to Supabase Storage
 * 2. File path passed to Claude Code (Opus reads image natively)
 * 3. AFTER response: parse [ASSET_DESC] tag → update description + embedding
 *
 * VPS (Anthropic API / no Claude Code):
 * 1. Image received → uploaded to Supabase Storage (no local save)
 * 2. Haiku vision generates description (VPS can't read local files)
 * 3. Description passed to Anthropic processor
 */

import { readFile } from "fs/promises";
import { basename } from "path";
import { getSupabase } from "./supabase";

// ============================================================
// TYPES
// ============================================================

export interface AssetMetadata {
  userCaption?: string;
  conversationContext?: string;
  relatedProject?: string;
  channel?: string;
  telegramFileId?: string;
}

export interface Asset {
  id: string;
  created_at: string;
  storage_path: string;
  public_url: string | null;
  original_filename: string | null;
  file_type: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  description: string;
  user_caption: string | null;
  conversation_context: string | null;
  related_project: string | null;
  tags: string[];
  channel: string;
  metadata: Record<string, any>;
}

interface VisionResult {
  description: string;
  tags: string[];
  suggestedProject: string | null;
}

// Storage bucket name
const BUCKET_NAME = "gobot-assets";

// ============================================================
// QUICK UPLOAD (Mac path — no vision call, Claude Code reads image)
// ============================================================

/**
 * Upload file to Supabase Storage with a placeholder description.
 * Used on Mac path where Claude Code (Opus) reads the image directly.
 * The description gets updated async AFTER Claude responds.
 */
export async function uploadAssetQuick(
  localPath: string,
  metadata: AssetMetadata & {
    originalFilename?: string;
    fileType?: string;
    mimeType?: string;
  }
): Promise<Asset | null> {
  return uploadAsset(localPath, {
    ...metadata,
    description: metadata.userCaption || "Image (pending description)",
    tags: [],
    suggestedProject: null,
  });
}

/**
 * Upload from a Buffer (VPS path — no local file).
 */
export async function uploadAssetFromBuffer(
  buffer: Buffer,
  filename: string,
  metadata: AssetMetadata & {
    description: string;
    tags?: string[];
    suggestedProject?: string | null;
    fileType?: string;
    mimeType?: string;
  }
): Promise<Asset | null> {
  const client = getSupabase();
  if (!client) {
    console.warn("⚠️ Supabase not configured — asset not uploaded");
    return null;
  }

  try {
    const ext = filename.split(".").pop()?.toLowerCase() || "bin";

    const imageExts = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"];
    const audioExts = ["mp3", "ogg", "wav", "m4a", "oga"];
    let fileType = metadata.fileType || "document";
    if (!metadata.fileType) {
      if (imageExts.includes(ext)) fileType = "image";
      else if (audioExts.includes(ext)) fileType = "audio";
    }

    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      pdf: "application/pdf",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      wav: "audio/wav",
    };
    const mimeType = metadata.mimeType || mimeMap[ext] || "application/octet-stream";

    const storagePath = `${fileType}s/${new Date().toISOString().split("T")[0]}/${filename}`;

    const { error: uploadError } = await client.storage
      .from(BUCKET_NAME)
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadError) {
      console.error("Storage upload error:", uploadError.message);
      return null;
    }

    const { data: urlData } = client.storage
      .from(BUCKET_NAME)
      .getPublicUrl(storagePath);

    const publicUrl = urlData?.publicUrl || null;

    const { data, error: insertError } = await client
      .from("assets")
      .insert({
        storage_path: storagePath,
        public_url: publicUrl,
        original_filename: filename,
        file_type: fileType,
        mime_type: mimeType,
        file_size_bytes: buffer.length,
        description: metadata.description,
        user_caption: metadata.userCaption || null,
        conversation_context: metadata.conversationContext || null,
        related_project: metadata.suggestedProject || metadata.relatedProject || null,
        tags: metadata.tags || [],
        channel: metadata.channel || "telegram",
        metadata: {
          telegramFileId: metadata.telegramFileId,
        },
      })
      .select()
      .single();

    if (insertError) {
      console.error("Asset insert error:", insertError.message);
      return null;
    }

    console.log(`📦 Asset stored: ${storagePath} (${fileType})`);
    return data as Asset;
  } catch (err) {
    console.error("uploadAssetFromBuffer error:", err);
    return null;
  }
}

/**
 * Update an existing asset's description after Claude has responded.
 * Called async (fire-and-forget) after the main response is sent.
 */
export async function updateAssetDescription(
  assetId: string,
  description: string,
  tags?: string[],
  relatedProject?: string | null
): Promise<void> {
  const client = getSupabase();
  if (!client) return;

  try {
    const updateData: Record<string, any> = { description };
    if (tags && tags.length > 0) updateData.tags = tags;
    if (relatedProject) updateData.related_project = relatedProject;

    // Generate embedding for semantic search
    const embedding = await generateEmbedding(
      `${description} ${(tags || []).join(" ")}`
    );
    if (embedding) updateData.embedding = embedding;

    const { error } = await client
      .from("assets")
      .update(updateData)
      .eq("id", assetId);

    if (error) {
      console.error("updateAssetDescription error:", error.message);
    } else {
      console.log(
        `📝 Asset ${assetId.substring(0, 8)} description updated${embedding ? " (with embedding)" : ""}`
      );
    }
  } catch (err) {
    console.error("updateAssetDescription exception:", err);
  }
}

/**
 * Generate an embedding vector via OpenAI API.
 * Gracefully returns null if OPENAI_API_KEY is not set.
 */
async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
        dimensions: 1536,
      }),
    });

    if (!response.ok) {
      console.error("Embedding API error:", await response.text());
      return null;
    }

    const result = await response.json();
    return result.data?.[0]?.embedding || null;
  } catch (err) {
    console.error("generateEmbedding error:", err);
    return null;
  }
}

// ============================================================
// IMAGE DESCRIPTION (Haiku Vision — for VPS path)
// ============================================================

/**
 * Use Anthropic Haiku to describe an image.
 * Used on VPS path where Claude Code can't read local files.
 */
export async function describeImage(
  localPath: string,
  caption?: string,
  recentContext?: string
): Promise<VisionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ No ANTHROPIC_API_KEY — skipping vision description");
    return {
      description: caption || "Image (no description available)",
      tags: [],
      suggestedProject: null,
    };
  }

  try {
    const imageBuffer = await readFile(localPath);
    return describeImageFromBuffer(imageBuffer, localPath, caption, recentContext);
  } catch (err) {
    console.error("describeImage error:", err);
    return {
      description: caption || "Image (description failed)",
      tags: [],
      suggestedProject: null,
    };
  }
}

/**
 * Describe an image from a Buffer (VPS path — no local file).
 */
export async function describeImageFromBuffer(
  imageBuffer: Buffer,
  filename: string,
  caption?: string,
  recentContext?: string
): Promise<VisionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ No ANTHROPIC_API_KEY — skipping vision description");
    return {
      description: caption || "Image (no description available)",
      tags: [],
      suggestedProject: null,
    };
  }

  try {
    if (!imageBuffer || imageBuffer.length === 0) {
      console.error("describeImageFromBuffer: empty buffer, skipping vision call");
      return {
        description: caption || "Image (empty buffer)",
        tags: [],
        suggestedProject: null,
      };
    }

    // Anthropic API limit: 5MB per image
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    if (imageBuffer.length > MAX_IMAGE_BYTES) {
      console.warn(`[vision] Image too large (${imageBuffer.length}b > 5MB), skipping vision call`);
      return {
        description: caption || "Image (too large for vision analysis)",
        tags: [],
        suggestedProject: null,
      };
    }

    const ext = filename.split(".").pop()?.toLowerCase() || "jpg";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
    };
    // Telegram photos are always JPEG; fall back to jpeg if extension unrecognized
    const mediaType = (mimeMap[ext] as "image/jpeg" | "image/png" | "image/gif" | "image/webp") || "image/jpeg";

    // Detect actual format from magic bytes to avoid sending wrong media_type
    let detectedMediaType = mediaType;
    if (imageBuffer.length >= 4) {
      if (imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8) {
        detectedMediaType = "image/jpeg";
      } else if (
        imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 &&
        imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47
      ) {
        detectedMediaType = "image/png";
      } else if (
        imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49 &&
        imageBuffer[2] === 0x46
      ) {
        detectedMediaType = "image/gif";
      } else if (
        imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49 &&
        imageBuffer[2] === 0x46 && imageBuffer[3] === 0x46
      ) {
        detectedMediaType = "image/webp";
      }
    }

    // Validate it's a supported format
    const supportedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!supportedTypes.includes(detectedMediaType)) {
      console.warn(`[vision] Unsupported image format ${detectedMediaType}, skipping vision call`);
      return {
        description: caption || "Image (unsupported format)",
        tags: [],
        suggestedProject: null,
      };
    }

    const base64 = imageBuffer.toString("base64");
    console.log(`[vision] buffer=${imageBuffer.length}b ext=${ext} mediaType=${detectedMediaType} filename=${filename}`);

    let promptParts: string[] = [];

    if (caption) {
      promptParts.push(
        `The user sent this image with the message: "${caption}"\nAnalyze the image with this context in mind.`
      );
    }
    if (recentContext) {
      promptParts.push(`Recent conversation for context:\n${recentContext}`);
    }
    promptParts.push(`Describe this image concisely for future reference. Include:
1. What the image shows (objects, text, UI elements, people, etc.)
2. Any text visible in the image
3. The apparent purpose/context${caption ? " — especially in relation to the user's message" : ""}

Respond in JSON only:
{
  "description": "A concise 1-2 sentence description",
  "tags": ["tag1", "tag2", "tag3"],
  "suggestedProject": "project name or null"
}`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: promptParts.join("\n\n"),
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: detectedMediaType,
                  data: base64,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`Vision API error (${response.status}): ${err} | buffer=${imageBuffer.length}b mediaType=${mediaType}`);
      return {
        description: caption || "Image (vision API error)",
        tags: [],
        suggestedProject: null,
      };
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || "";

    // Parse JSON from response (handle markdown fences)
    const jsonStr = text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(jsonStr);

    return {
      description: parsed.description || caption || "Image",
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      suggestedProject: parsed.suggestedProject || null,
    };
  } catch (err) {
    console.error("describeImageFromBuffer error:", err);
    return {
      description: caption || "Image (description failed)",
      tags: [],
      suggestedProject: null,
    };
  }
}

// ============================================================
// UPLOAD & STORAGE
// ============================================================

/**
 * Upload a file from local path to Supabase Storage and insert metadata.
 */
export async function uploadAsset(
  localPath: string,
  metadata: AssetMetadata & {
    description: string;
    tags?: string[];
    suggestedProject?: string | null;
    originalFilename?: string;
    fileType?: string;
    mimeType?: string;
  }
): Promise<Asset | null> {
  const client = getSupabase();
  if (!client) {
    console.warn("⚠️ Supabase not configured — asset not uploaded");
    return null;
  }

  try {
    const fileBuffer = await readFile(localPath);
    const filename = metadata.originalFilename || basename(localPath);

    return uploadAssetFromBuffer(fileBuffer, filename, {
      ...metadata,
      fileType: metadata.fileType,
      mimeType: metadata.mimeType,
    });
  } catch (err) {
    console.error("uploadAsset error:", err);
    return null;
  }
}

// ============================================================
// RETRIEVAL
// ============================================================

/**
 * Get recent assets, optionally filtered by file type.
 */
export async function getRecentAssets(
  limit: number = 5,
  fileType?: string
): Promise<Asset[]> {
  const client = getSupabase();
  if (!client) return [];

  try {
    let query = client
      .from("assets")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (fileType) {
      query = query.eq("file_type", fileType);
    }

    const { data, error } = await query;
    if (error) {
      console.error("getRecentAssets error:", error.message);
      return [];
    }
    return (data || []) as Asset[];
  } catch (err) {
    console.error("getRecentAssets exception:", err);
    return [];
  }
}

/**
 * Search assets by text query (description + tags).
 */
export async function searchAssets(
  query: string,
  limit: number = 5
): Promise<Asset[]> {
  const client = getSupabase();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from("assets")
      .select("*")
      .or(`description.ilike.%${query}%,tags.cs.{${query}}`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("searchAssets error:", error.message);
      return [];
    }
    return (data || []) as Asset[];
  } catch (err) {
    console.error("searchAssets exception:", err);
    return [];
  }
}

/**
 * Get a single asset by ID.
 */
export async function getAssetById(assetId: string): Promise<Asset | null> {
  const client = getSupabase();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from("assets")
      .select("*")
      .eq("id", assetId)
      .single();

    if (error) return null;
    return data as Asset;
  } catch {
    return null;
  }
}

/**
 * Format recent assets as context string for prompt injection.
 */
export async function getAssetContext(limit: number = 5): Promise<string> {
  const assets = await getRecentAssets(limit);
  if (assets.length === 0) return "";

  const lines = assets.map((a) => {
    const age = getTimeAgo(a.created_at);
    const tags = a.tags.length > 0 ? ` [${a.tags.join(", ")}]` : "";
    return `- ${a.description}${tags} (${age}, id: ${a.id.substring(0, 8)})`;
  });

  return `\n\nRECENT IMAGES/FILES:\n${lines.join("\n")}`;
}

// ============================================================
// PARSE HELPERS
// ============================================================

/**
 * Parse [ASSET_DESC: description | tag1, tag2] from Claude's response.
 * Returns null if no tag found.
 */
export function parseAssetDescTag(
  response: string
): { description: string; tags: string[] } | null {
  const match = response.match(
    /\[ASSET_DESC:\s*(.+?)(?:\s*\|\s*(.+?))?\s*\]/
  );
  if (!match) return null;

  const description = match[1].trim();
  const tags = match[2]
    ? match[2].split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return { description, tags };
}

/**
 * Strip [ASSET_DESC: ...] tag from response before sending to user.
 */
export function stripAssetDescTag(response: string): string {
  return response.replace(/\s*\[ASSET_DESC:[^\]]+\]\s*/g, "").trim();
}

// ============================================================
// HELPERS
// ============================================================

function getTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}min ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}

// Updated February 2026: Clarified deployment modes and authentication following Anthropic's January 2026 ToS enforcement.
