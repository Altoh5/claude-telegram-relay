import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    chat_id: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    metadata: v.optional(v.any()),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_chat_id", ["chat_id"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["chat_id"],
    }),

  memory: defineTable({
    type: v.union(
      v.literal("fact"),
      v.literal("goal"),
      v.literal("completed_goal"),
      v.literal("preference")
    ),
    content: v.string(),
    deadline: v.optional(v.number()),
    completed_at: v.optional(v.number()),
    priority: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_type", ["type"]),

  logs: defineTable({
    level: v.union(
      v.literal("debug"),
      v.literal("info"),
      v.literal("warn"),
      v.literal("error")
    ),
    event: v.optional(v.string()),
    message: v.optional(v.string()),
    metadata: v.optional(v.any()),
    session_id: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
  })
    .index("by_level", ["level"])
    .index("by_event", ["event"]),

  callTranscripts: defineTable({
    conversation_id: v.string(),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    action_items: v.optional(v.array(v.string())),
    duration_seconds: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_conversation_id", ["conversation_id"]),

  asyncTasks: defineTable({
    chat_id: v.string(),
    original_prompt: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("needs_input"),
      v.literal("completed"),
      v.literal("failed")
    ),
    result: v.optional(v.string()),
    session_id: v.optional(v.string()),
    current_step: v.optional(v.string()),
    pending_question: v.optional(v.string()),
    pending_options: v.optional(v.any()),
    user_response: v.optional(v.string()),
    thread_id: v.optional(v.number()),
    processed_by: v.optional(v.string()),
    reminder_sent: v.optional(v.boolean()),
    updatedAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_chat_id", ["chat_id"])
    .index("by_status", ["status"]),

  nodeHeartbeat: defineTable({
    node_id: v.string(),
    last_heartbeat: v.number(),
    metadata: v.optional(v.any()),
  })
    .index("by_node_id", ["node_id"]),

  assets: defineTable({
    storage_path: v.string(),
    public_url: v.optional(v.string()),
    original_filename: v.optional(v.string()),
    file_type: v.string(),
    mime_type: v.optional(v.string()),
    file_size_bytes: v.optional(v.number()),
    description: v.string(),
    user_caption: v.optional(v.string()),
    conversation_context: v.optional(v.string()),
    related_project: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    channel: v.optional(v.string()),
    metadata: v.optional(v.any()),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_file_type", ["file_type"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: [],
    }),

  twinmindMeetings: defineTable({
    meeting_id: v.string(),
    meeting_title: v.string(),
    summary: v.string(),
    action_items: v.optional(v.string()),
    start_time: v.number(),
    end_time: v.optional(v.number()),
    processed: v.optional(v.boolean()),
    processed_at: v.optional(v.number()),
    synced_at: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_meeting_id", ["meeting_id"])
    .index("by_processed", ["processed"]),

  triageTasks: defineTable({
    meeting_id: v.string(),
    project: v.string(),
    description: v.string(),
    suggestion: v.string(),
    relevant_contact: v.optional(v.string()),
    relevant_contact_email: v.optional(v.string()),
    date: v.optional(v.number()),         // Unix ms, when to act
    confidence_score: v.number(),          // 0–100
    status: v.string(),                    // "backlog" | "in_progress" | "done"
    source_meeting_title: v.string(),
    created_at: v.number(),
  }).index("by_project", ["project"])
    .index("by_status", ["status"])
    .index("by_meeting", ["meeting_id"]),

  contacts: defineTable({
    google_id: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    organization: v.optional(v.string()),
    last_synced: v.number(),
  }).index("by_name", ["name"])
    .index("by_google_id", ["google_id"]),
});
