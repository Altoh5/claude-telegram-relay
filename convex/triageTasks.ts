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

export const updateContact = mutation({
  args: {
    id: v.id("triageTasks"),
    relevant_contact: v.optional(v.string()),
    relevant_contact_email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      relevant_contact: args.relevant_contact,
      relevant_contact_email: args.relevant_contact_email,
    });
  },
});

export const updateNotes = mutation({
  args: {
    id: v.id("triageTasks"),
    notes: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { notes: args.notes });
  },
});

export const deleteTask = mutation({
  args: { id: v.id("triageTasks") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
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

export const listUnsynced = query({
  args: {},
  handler: async (ctx) => {
    // Tasks not yet pushed to StartInfinity
    const all = await ctx.db.query("triageTasks").collect();
    return all.filter((t) => !t.startinfinity_item_id);
  },
});

export const markSynced = mutation({
  args: {
    id: v.id("triageTasks"),
    startinfinity_item_id: v.string(),
    startinfinity_folder_id: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      startinfinity_item_id: args.startinfinity_item_id,
      startinfinity_folder_id: args.startinfinity_folder_id,
    });
  },
});
