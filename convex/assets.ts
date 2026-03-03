import { v } from "convex/values";
import { mutation, query, action } from "./_generated/server";
import { api } from "./_generated/api";

export const insert = mutation({
  args: {
    storage_path: v.string(),
    public_url: v.optional(v.string()),
    original_filename: v.optional(v.string()),
    file_type: v.string(),
    mime_type: v.optional(v.string()),
    file_size_bytes: v.optional(v.number()),
    description: v.string(),
    user_caption: v.optional(v.string()),
    conversation_context: v.optional(v.string()),
    related_project: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    channel: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("assets", { ...args });
  },
});

export const backfillEmbedding = mutation({
  args: { id: v.id("assets"), embedding: v.array(v.float64()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { embedding: args.embedding });
  },
});

export const getById = query({
  args: { id: v.id("assets") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByFileType = query({
  args: { file_type: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("assets")
      .withIndex("by_file_type", (q) => q.eq("file_type", args.file_type))
      .order("desc")
      .take(args.limit ?? 20);
  },
});

export const searchByVector = action({
  args: {
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any[]> => {
    const results = await ctx.vectorSearch("assets", "by_embedding", {
      vector: args.embedding,
      limit: args.limit ?? 5,
    });
    const docs: any[] = [];
    for (const r of results) {
      const doc = await ctx.runQuery(api.assets.getById, { id: r._id });
      if (doc) docs.push({ ...doc, _score: r._score });
    }
    return docs;
  },
});
