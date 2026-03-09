import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ---------------------------------------------------------------------------
// Board Sessions (Board Meetings v2 — saved session reports)
// ---------------------------------------------------------------------------

export const insert = mutation({
  args: {
    chat_id: v.string(),
    project_id: v.optional(v.id("projects")),
    project_name: v.optional(v.string()),
    agent_outputs: v.any(),
    synthesis: v.optional(v.string()),
    decisions: v.optional(v.any()),
    task_id: v.optional(v.id("asyncTasks")),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("boardSessions", {
      chat_id: args.chat_id,
      project_id: args.project_id,
      project_name: args.project_name,
      agent_outputs: args.agent_outputs ?? {},
      synthesis: args.synthesis,
      decisions: args.decisions,
      task_id: args.task_id,
      status: args.status,
      metadata: args.metadata ?? {},
    });
  },
});

export const patch = mutation({
  args: {
    id: v.id("boardSessions"),
    updates: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, args.updates);
  },
});

export const getById = query({
  args: { id: v.id("boardSessions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByChat = query({
  args: {
    chat_id: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("boardSessions")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chat_id))
      .order("desc")
      .take(args.limit ?? 10);
    return rows;
  },
});

export const getLastByProject = query({
  args: { project_id: v.id("projects") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("boardSessions")
      .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id))
      .order("desc")
      .take(1);
    return rows[0] ?? null;
  },
});
