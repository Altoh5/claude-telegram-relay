import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: {
    meeting_id: v.string(),
    project: v.string(),
    description: v.string(),
    suggestion: v.string(),
    relevant_contact: v.optional(v.string()),
    relevant_contact_email: v.optional(v.string()),
    date: v.optional(v.number()),
    confidence_score: v.number(),
    status: v.string(),
    source_meeting_title: v.string(),
    created_at: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("triageTasks", args);
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("triageTasks"),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: args.status });
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("triageTasks").order("desc").collect();
  },
});

export const listByProject = query({
  args: { project: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("triageTasks")
      .withIndex("by_project", (q) => q.eq("project", args.project))
      .order("desc")
      .collect();
  },
});

export const listByStatus = query({
  args: { status: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("triageTasks")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .collect();
  },
});

export const listByMeeting = query({
  args: { meeting_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("triageTasks")
      .withIndex("by_meeting", (q) => q.eq("meeting_id", args.meeting_id))
      .collect();
  },
});
