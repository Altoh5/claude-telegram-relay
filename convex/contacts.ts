import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const upsert = mutation({
  args: {
    google_id: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    organization: v.optional(v.string()),
    last_synced: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("contacts")
      .withIndex("by_google_id", (q) => q.eq("google_id", args.google_id))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        email: args.email,
        phone: args.phone,
        organization: args.organization,
        last_synced: args.last_synced,
      });
      return existing._id;
    }
    return await ctx.db.insert("contacts", args);
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("contacts").collect();
  },
});
