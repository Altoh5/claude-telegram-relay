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

export const findByName = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("contacts")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
  },
});

export const searchByName = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const lower = args.name.toLowerCase();
    // Try exact match first via index
    const exact = await ctx.db
      .query("contacts")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
    if (exact) return exact;
    // Fallback: scan for partial/case-insensitive match (limited scan)
    const all = await ctx.db.query("contacts").take(5000);
    return all.find((c) => c.name.toLowerCase().includes(lower)) ?? null;
  },
});

// Returns all contacts whose name contains the search term (case-insensitive), up to 5 results.
// Used for contact confirmation flow when there may be multiple matches.
export const searchAllByName = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const lower = args.name.toLowerCase();
    const all = await ctx.db.query("contacts").take(5000);
    return all
      .filter((c) => c.name.toLowerCase().includes(lower))
      .slice(0, 5);
  },
});
