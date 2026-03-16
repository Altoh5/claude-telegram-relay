import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const insert = mutation({
  args: {
    level: v.union(
      v.literal("debug"),
      v.literal("info"),
      v.literal("warn"),
      v.literal("error")
    ),
    event: v.optional(v.string()),
    message: v.optional(v.string()),
    metadata: v.optional(v.any()),
    session_id: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("logs", { ...args });
  },
});

export const getRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 100 }) => {
    return await ctx.db
      .query("logs")
      .order("desc")
      .take(limit);
  },
});
