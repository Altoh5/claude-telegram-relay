import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const memoryType = v.union(
  v.literal("fact"),
  v.literal("goal"),
  v.literal("completed_goal"),
  v.literal("preference")
);

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export const insert = mutation({
  args: {
    type: memoryType,
    content: v.string(),
    deadline: v.optional(v.number()),
    priority: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("memory", {
      ...args,
      updatedAt: Date.now(),
    });
  },
});

export const patch = mutation({
  args: {
    id: v.id("memory"),
    updates: v.any(),
  },
  handler: async (ctx, { id, updates }) => {
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { id: v.id("memory") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const getByType = query({
  args: { type: memoryType },
  handler: async (ctx, { type }) => {
    return await ctx.db
      .query("memory")
      .withIndex("by_type", (q) => q.eq("type", type))
      .order("asc")
      .collect();
  },
});

export const findByContent = query({
  args: { type: memoryType, search: v.string() },
  handler: async (ctx, { type, search }) => {
    const lower = search.toLowerCase();
    const rows = await ctx.db
      .query("memory")
      .withIndex("by_type", (q) => q.eq("type", type))
      .collect();
    return rows.filter((r) => r.content.toLowerCase().includes(lower));
  },
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("memory").order("desc").collect();
  },
});
