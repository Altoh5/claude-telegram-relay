import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const upsert = mutation({
  args: {
    node_id: v.string(),
    last_heartbeat: v.number(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("nodeHeartbeat")
      .withIndex("by_node_id", (q) => q.eq("node_id", args.node_id))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        last_heartbeat: args.last_heartbeat,
        metadata: args.metadata,
      });
    } else {
      await ctx.db.insert("nodeHeartbeat", { ...args });
    }
  },
});

export const getByNodeId = query({
  args: { node_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("nodeHeartbeat")
      .withIndex("by_node_id", (q) => q.eq("node_id", args.node_id))
      .first();
  },
});
