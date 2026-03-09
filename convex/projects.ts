import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ---------------------------------------------------------------------------
// Projects (Board Meetings v2 — named project containers)
// ---------------------------------------------------------------------------

export const insert = mutation({
  args: {
    chat_id: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    goals: v.optional(v.string()),
    context_notes: v.optional(v.string()),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("projects", {
      chat_id: args.chat_id,
      name: args.name,
      description: args.description,
      goals: args.goals,
      context_notes: args.context_notes,
      status: args.status ?? "active",
      updatedAt: Date.now(),
      metadata: args.metadata ?? {},
    });
  },
});

export const patch = mutation({
  args: {
    id: v.id("projects"),
    updates: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { ...args.updates, updatedAt: Date.now() });
  },
});

export const getById = query({
  args: { id: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByChat = query({
  args: {
    chat_id: v.string(),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_chat_status", (q) => {
        const base = q.eq("chat_id", args.chat_id);
        return args.status ? base.eq("status", args.status) : base;
      })
      .order("desc")
      .collect();
    return rows;
  },
});

/** Find a project by exact name (case-insensitive) within a chat. */
export const findByName = query({
  args: { chat_id: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chat_id))
      .collect();
    const lower = args.name.toLowerCase();
    // Exact match first, then prefix, then contains
    const exact = rows.find((r) => r.name.toLowerCase() === lower && r.status === "active");
    if (exact) return exact;
    const prefix = rows.find(
      (r) => r.name.toLowerCase().startsWith(lower) && r.status === "active"
    );
    if (prefix) return prefix;
    return rows.find(
      (r) => r.name.toLowerCase().includes(lower) && r.status === "active"
    ) ?? null;
  },
});
