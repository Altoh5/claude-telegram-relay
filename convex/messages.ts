import { v } from "convex/values";
import { mutation, query, action } from "./_generated/server";
import { api } from "./_generated/api";

export const insert = mutation({
  args: {
    chat_id: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      chat_id: args.chat_id,
      role: args.role,
      content: args.content,
      metadata: args.metadata ?? {},
    });
  },
});

export const getById = query({
  args: { id: v.id("messages") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getRecent = query({
  args: { chat_id: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chat_id))
      .order("desc")
      .take(args.limit ?? 20);
    return rows.reverse();
  },
});

export const backfillEmbedding = mutation({
  args: { id: v.id("messages"), embedding: v.array(v.float64()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { embedding: args.embedding });
  },
});

export const searchByVector = action({
  args: {
    chat_id: v.string(),
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any[]> => {
    const results = await ctx.vectorSearch("messages", "by_embedding", {
      vector: args.embedding,
      limit: args.limit ?? 10,
      filter: (q) => q.eq("chat_id", args.chat_id),
    });
    const docs: any[] = [];
    for (const r of results) {
      const doc = await ctx.runQuery(api.messages.getById, { id: r._id });
      if (doc) docs.push({ ...doc, _score: r._score });
    }
    return docs;
  },
});
