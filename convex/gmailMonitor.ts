import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const getLastRun = query({
  args: { inbox: v.string() },
  handler: async (ctx, { inbox }) => {
    const row = await ctx.db
      .query("gmailMonitor")
      .withIndex("by_inbox", (q) => q.eq("inbox", inbox))
      .first();
    return row?.last_run ?? null;
  },
});

export const setLastRun = mutation({
  args: { inbox: v.string(), timestamp: v.number() },
  handler: async (ctx, { inbox, timestamp }) => {
    const existing = await ctx.db
      .query("gmailMonitor")
      .withIndex("by_inbox", (q) => q.eq("inbox", inbox))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { last_run: timestamp });
    } else {
      await ctx.db.insert("gmailMonitor", { inbox, last_run: timestamp });
    }
  },
});

export const isProcessed = query({
  args: { message_id: v.string() },
  handler: async (ctx, { message_id }) => {
    const row = await ctx.db
      .query("gmailProcessed")
      .withIndex("by_message_id", (q) => q.eq("message_id", message_id))
      .first();
    return row !== null;
  },
});

export const markProcessed = mutation({
  args: { message_id: v.string(), classified_as: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("gmailProcessed")
      .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
      .first();
    if (existing) return; // already recorded, skip
    await ctx.db.insert("gmailProcessed", {
      ...args,
      processed_at: Date.now(),
    });
  },
});
