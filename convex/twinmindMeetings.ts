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
      synced_at: Date.now(),
    });
  },
});

export const getUnprocessed = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("twinmindMeetings")
      .withIndex("by_processed", (q) => q.eq("processed", false))
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
