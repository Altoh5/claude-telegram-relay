import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const memoryType = v.union(
  v.literal("fact"),
  v.literal("goal"),
  v.literal("completed_goal"),
  v.literal("preference")
);

export const insert = mutation({
  args: {
    type: memoryType,
    content: v.string(),
    deadline: v.optional(v.number()),
    priority: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("memory", { ...args });
  },
});

export const patch = mutation({
  args: {
    id: v.id("memory"),
    updates: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { ...args.updates, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { id: v.id("memory") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const getByType = query({
  args: { type: memoryType },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("memory")
      .withIndex("by_type", (q) => q.eq("type", args.type))
      .collect();
  },
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("memory").collect();
  },
});

export const findByContent = query({
  args: { type: memoryType, search: v.string() },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query("memory")
      .withIndex("by_type", (q) => q.eq("type", args.type))
      .collect();
    const lower = args.search.toLowerCase();
    return items.filter((i) => i.content.toLowerCase().includes(lower));
  },
});
