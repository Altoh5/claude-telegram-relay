import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const upsert = mutation({
  args: {
    meeting_id: v.string(),
    meeting_title: v.string(),
    summary: v.string(),
    action_items: v.optional(v.string()),
    start_time: v.number(),
    end_time: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("twinmindMeetings")
      .withIndex("by_meeting_id", (q) =>
        q.eq("meeting_id", args.meeting_id)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        meeting_title: args.meeting_title,
        summary: args.summary,
        action_items: args.action_items,
        synced_at: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("twinmindMeetings", {
      ...args,
      processed: false,
      synced_at: Date.now(),
    });
  },
});

export const getUnprocessed = query({
  args: {},
  handler: async (ctx) => {
    // Catch records where processed is false OR not set (older synced records)
    return await ctx.db
      .query("twinmindMeetings")
      .filter((q) => q.neq(q.field("processed"), true))
      .order("asc")
      .collect();
  },
});

export const markProcessed = mutation({
  args: { id: v.id("twinmindMeetings"), metadata: v.optional(v.any()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      processed: true,
      processed_at: Date.now(),
      metadata: args.metadata,
    });
  },
});

export const getRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 20 }) => {
    return await ctx.db
      .query("twinmindMeetings")
      .order("desc")
      .take(limit);
  },
});

export const getByMeetingId = query({
  args: { meeting_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("twinmindMeetings")
      .withIndex("by_meeting_id", (q) =>
        q.eq("meeting_id", args.meeting_id)
      )
      .first();
  },
});

export const resetProcessed = mutation({
  args: { meeting_id: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("twinmindMeetings")
      .withIndex("by_meeting_id", (q) => q.eq("meeting_id", args.meeting_id))
      .first();
    if (!existing) return null;
    await ctx.db.patch(existing._id, { processed: false, processed_at: undefined });
    return existing._id;
  },
});

export const getLastSyncTime = query({
  args: {},
  handler: async (ctx) => {
    const latest = await ctx.db
      .query("twinmindMeetings")
      .order("desc")
      .first();
    return latest?.synced_at ?? null;
  },
});

export const updateMetadata = mutation({
  args: { meeting_id: v.string(), metadata: v.any() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("twinmindMeetings")
      .withIndex("by_meeting_id", (q) => q.eq("meeting_id", args.meeting_id))
      .first();
    if (!existing) return;
    const merged = { ...(existing.metadata || {}), ...args.metadata };
    await ctx.db.patch(existing._id, { metadata: merged });
  },
});
