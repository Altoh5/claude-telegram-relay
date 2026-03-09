import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const upsert = mutation({
  args: {
    conversation_id: v.string(),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    action_items: v.optional(v.array(v.string())),
    duration_seconds: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("callTranscripts")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args });
      return existing._id;
    }
    return await ctx.db.insert("callTranscripts", { ...args });
  },
});

export const getByConversationId = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("callTranscripts")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .first();
  },
});
