/**
 * Knowledge Base Module
 *
 * Structured knowledge storage with categories, semantic search,
 * archiving, and project linking. Builds on top of the simple
 * facts/goals system in memory.ts with richer categorization.
 *
 * Categories: project, person, preference, learning, process, decision, reference, tool
 *
 * Usage (Claude response tags):
 *   [KNOWLEDGE: category | title | content | project?]
 *   [REMEMBER: fact]  ← backward compat, still handled by memory.ts
 *
 * Requires:
 *   - Supabase with `knowledge` table (see db/schema.sql)
 *   - Optional: OpenAI API key for semantic search embeddings
 */

import { getSupabase, isSupabaseEnabled } from "./convex";

// ============================================================
// TYPES
// ============================================================

export type KnowledgeCategory =
  | "project"
  | "person"
  | "preference"
  | "learning"
  | "process"
  | "decision"
  | "reference"
  | "tool";

export interface KnowledgeEntry {
  id?: string;
  created_at?: string;
  updated_at?: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  source?: string;
  related_project?: string;
  related_entities?: string[];
  tags?: string[];
  confidence?: number;
  expires_at?: string;
  superseded_by?: string;
  status?: "active" | "archived";
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSearchResult extends KnowledgeEntry {
  similarity?: number;
}

const VALID_CATEGORIES: KnowledgeCategory[] = [
  "project",
  "person",
  "preference",
  "learning",
  "process",
  "decision",
  "reference",
  "tool",
];

// ============================================================
// CRUD OPERATIONS
// ============================================================

/**
 * Add a knowledge entry. If an entry with the same title + category
 * already exists, it updates the existing one instead of duplicating.
 * Generates an embedding async via edge function (if OpenAI key is set).
 */
export async function addKnowledge(entry: KnowledgeEntry): Promise<string> {
  const client = getSupabase();
  if (!client) return "⚠️ Supabase not configured";

  try {
    // Check for existing entry with same title + category (upsert)
    const { data: existing } = await client
      .from("knowledge")
      .select("id")
      .eq("category", entry.category)
      .eq("title", entry.title)
      .limit(1);

    if (existing && existing.length > 0) {
      const { error } = await client
        .from("knowledge")
        .update({
          content: entry.content,
          related_project: entry.related_project || null,
          related_entities: entry.related_entities || [],
          tags: entry.tags || [],
          confidence: entry.confidence ?? 1.0,
          updated_at: new Date().toISOString(),
          metadata: entry.metadata || {},
        })
        .eq("id", existing[0].id);

      if (error) {
        console.error("Knowledge update error:", error.message);
        return `⚠️ Failed to update knowledge: ${error.message}`;
      }

      // Generate embedding async (don't block response)
      generateEmbedding(existing[0].id, `${entry.title}: ${entry.content}`).catch(() => {});

      return `📚 Updated: [${entry.category}] ${entry.title}`;
    }

    // Insert new entry
    const { data, error } = await client
      .from("knowledge")
      .insert({
        category: entry.category,
        title: entry.title,
        content: entry.content,
        source: entry.source || "telegram",
        related_project: entry.related_project || null,
        related_entities: entry.related_entities || [],
        tags: entry.tags || [],
        confidence: entry.confidence ?? 1.0,
        expires_at: entry.expires_at || null,
        status: "active",
        metadata: entry.metadata || {},
      })
      .select("id")
      .single();

    if (error) {
      console.error("Knowledge insert error:", error.message);
      return `⚠️ Failed to save knowledge: ${error.message}`;
    }

    if (data?.id) {
      generateEmbedding(data.id, `${entry.title}: ${entry.content}`).catch(() => {});
    }

    return `📚 Learned: [${entry.category}] ${entry.title}`;
  } catch (err) {
    console.error("addKnowledge exception:", err);
    return "⚠️ Failed to save knowledge";
  }
}

/**
 * Generate and store an embedding for a knowledge entry.
 * Uses the embed-knowledge edge function (OpenAI text-embedding-3-small).
 * Silently skips if OpenAI key is not configured on the edge function.
 */
async function generateEmbedding(knowledgeId: string, text: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/embed-knowledge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({ knowledge_id: knowledgeId, text }),
      }
    );

    if (!response.ok) {
      // Edge function not deployed or OpenAI key missing — that's fine
      return;
    }
  } catch {
    // Edge function unavailable — knowledge still saved, just no embedding
  }
}

// ============================================================
// ARCHIVING
// ============================================================

/**
 * Archive a knowledge entry by ID. Keeps the row for history but
 * excludes it from all active searches.
 */
export async function archiveKnowledge(
  id: string,
  reason?: string
): Promise<string> {
  const client = getSupabase();
  if (!client) return "⚠️ Supabase not configured";

  try {
    const { data: entry } = await client
      .from("knowledge")
      .select("title, category")
      .eq("id", id)
      .single();

    if (!entry) return `⚠️ Knowledge entry not found: ${id}`;

    const update: Record<string, unknown> = {
      status: "archived",
      updated_at: new Date().toISOString(),
    };

    if (reason) {
      update.metadata = { archive_reason: reason };
    }

    const { error } = await client
      .from("knowledge")
      .update(update)
      .eq("id", id);

    if (error) {
      console.error("archiveKnowledge error:", error.message);
      return `⚠️ Failed to archive: ${error.message}`;
    }

    return `🗄️ Archived: [${entry.category}] ${entry.title}${reason ? ` (${reason})` : ""}`;
  } catch (err) {
    console.error("archiveKnowledge exception:", err);
    return "⚠️ Failed to archive knowledge";
  }
}

/**
 * Search archived knowledge explicitly (for historical context).
 */
export async function searchArchived(
  query: string,
  limit: number = 10
): Promise<KnowledgeSearchResult[]> {
  const client = getSupabase();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from("knowledge")
      .select("*")
      .eq("status", "archived")
      .or(`title.ilike.%${query}%,content.ilike.%${query}%,tags.cs.{${query}}`)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("searchArchived error:", error.message);
      return [];
    }

    return (data || []) as KnowledgeSearchResult[];
  } catch (err) {
    console.error("searchArchived exception:", err);
    return [];
  }
}

// ============================================================
// SEARCH & RETRIEVAL
// ============================================================

/**
 * Search active knowledge by text query, optionally filtered by category.
 * Uses text matching (ilike). For semantic search, the match_knowledge()
 * SQL function can be called via the search-memory edge function.
 */
export async function searchKnowledge(
  query: string,
  category?: KnowledgeCategory,
  limit: number = 10
): Promise<KnowledgeSearchResult[]> {
  const client = getSupabase();
  if (!client) return [];

  try {
    let q = client
      .from("knowledge")
      .select("*")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (category) {
      q = q.eq("category", category);
    }

    // Text search across title, content, tags
    q = q.or(`title.ilike.%${query}%,content.ilike.%${query}%,tags.cs.{${query}}`);

    // Exclude expired entries
    q = q.or("expires_at.is.null,expires_at.gt." + new Date().toISOString());

    // Exclude superseded entries
    q = q.is("superseded_by", null);

    const { data, error } = await q;

    if (error) {
      console.error("searchKnowledge error:", error.message);
      return [];
    }

    return (data || []) as KnowledgeSearchResult[];
  } catch (err) {
    console.error("searchKnowledge exception:", err);
    return [];
  }
}

/**
 * Get all knowledge linked to a specific project.
 */
export async function getKnowledgeByProject(
  project: string,
  limit: number = 20
): Promise<KnowledgeEntry[]> {
  const client = getSupabase();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from("knowledge")
      .select("*")
      .eq("status", "active")
      .ilike("related_project", `%${project}%`)
      .is("superseded_by", null)
      .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("getKnowledgeByProject error:", error.message);
      return [];
    }

    return (data || []) as KnowledgeEntry[];
  } catch (err) {
    console.error("getKnowledgeByProject exception:", err);
    return [];
  }
}

/**
 * Get recent knowledge entries, optionally filtered by category.
 */
export async function getRecentKnowledge(
  limit: number = 10,
  category?: KnowledgeCategory
): Promise<KnowledgeEntry[]> {
  const client = getSupabase();
  if (!client) return [];

  try {
    let q = client
      .from("knowledge")
      .select("*")
      .eq("status", "active")
      .is("superseded_by", null)
      .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (category) {
      q = q.eq("category", category);
    }

    const { data, error } = await q;

    if (error) {
      console.error("getRecentKnowledge error:", error.message);
      return [];
    }

    return (data || []) as KnowledgeEntry[];
  } catch (err) {
    console.error("getRecentKnowledge exception:", err);
    return [];
  }
}

/**
 * Build context string from knowledge entries relevant to the current message.
 * Includes recent high-priority knowledge (projects, decisions, preferences)
 * plus keyword-matched entries from the user's message.
 */
export async function getKnowledgeContext(
  userMessage?: string
): Promise<string> {
  if (!isSupabaseEnabled()) return "";

  try {
    const entries: KnowledgeEntry[] = [];

    // Always include recent high-value knowledge
    const priorityCategories: KnowledgeCategory[] = [
      "project",
      "decision",
      "preference",
    ];
    for (const cat of priorityCategories) {
      const recent = await getRecentKnowledge(3, cat);
      entries.push(...recent);
    }

    // If we have a user message, search for relevant knowledge
    if (userMessage && userMessage.length > 5) {
      const words = userMessage
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 3);

      for (const word of words) {
        const matches = await searchKnowledge(word, undefined, 3);
        for (const m of matches) {
          if (!entries.find((e) => e.id === m.id)) {
            entries.push(m);
          }
        }
      }
    }

    if (entries.length === 0) return "";

    const lines = entries.map((e) => {
      const project = e.related_project ? ` (${e.related_project})` : "";
      return `- [${e.category}] ${e.title}: ${e.content.substring(0, 200)}${project}`;
    });

    return `**Knowledge Base:**\n${lines.join("\n")}`;
  } catch (err) {
    console.error("getKnowledgeContext exception:", err);
    return "";
  }
}

// ============================================================
// INTENT TAG PARSING
// ============================================================

/**
 * Parse [KNOWLEDGE: category | title | content | project?] tag from Claude response.
 * Returns parsed entry or null if no tag found.
 */
export function parseKnowledgeTag(
  response: string
): { entry: KnowledgeEntry; rawTag: string } | null {
  const match = response.match(
    /\[KNOWLEDGE:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?\]/i
  );
  if (!match) return null;

  const category = match[1].trim().toLowerCase() as KnowledgeCategory;

  if (!VALID_CATEGORIES.includes(category)) {
    console.warn(`Invalid knowledge category: ${category}`);
    return null;
  }

  return {
    entry: {
      category,
      title: match[2].trim(),
      content: match[3].trim(),
      related_project: match[4]?.trim() || undefined,
      source: "telegram",
    },
    rawTag: match[0],
  };
}

/**
 * Parse ALL [KNOWLEDGE:] tags from a response (there may be multiple).
 */
export function parseAllKnowledgeTags(
  response: string
): { entry: KnowledgeEntry; rawTag: string }[] {
  const results: { entry: KnowledgeEntry; rawTag: string }[] = [];
  const regex =
    /\[KNOWLEDGE:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?\]/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(response)) !== null) {
    const category = match[1].trim().toLowerCase() as KnowledgeCategory;
    if (!VALID_CATEGORIES.includes(category)) continue;

    results.push({
      entry: {
        category,
        title: match[2].trim(),
        content: match[3].trim(),
        related_project: match[4]?.trim() || undefined,
        source: "telegram",
      },
      rawTag: match[0],
    });
  }

  return results;
}
