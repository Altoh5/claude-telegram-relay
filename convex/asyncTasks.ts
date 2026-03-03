import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const statusType = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("needs_input"),
  v.literal("completed"),
  v.literal("failed")
);

export const insert = mutation({
  args: {
    chat_id: v.string(),
    original_prompt: v.string(),
    status: statusType,
    thread_id: v.optional(v.number()),
    processed_by: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("asyncTasks", {
      ...args,
      updatedAt: Date.now(),
    });
  },
});

export const patch = mutation({
  args: {
    id: v.id("asyncTasks"),
    updates: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { ...args.updates, updatedAt: Date.now() });
  },
});

export const getById = query({
  args: { id: v.id("asyncTasks") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByChat = query({
  args: { chat_id: v.string(), status: v.optional(statusType) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("asyncTasks")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chat_id))
      .order("desc")
      .collect();
    if (args.status) return rows.filter((r) => r.status === args.status);
    return rows;
  },
});

export const getByStatus = query({
  args: { status: statusType },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("asyncTasks")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .collect();
  },
});

export const getStalePending = query({
  args: { cutoff: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("asyncTasks")
      .withIndex("by_status", (q) => q.eq("status", "needs_input"))
      .collect();
    return rows.filter(
      (r) => !r.reminder_sent && (r.updatedAt ?? r._creationTime) < args.cutoff
    );
  },
});
