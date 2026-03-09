/**
 * Projects Library (Board Meetings v2)
 *
 * CRUD for named project containers and board session persistence.
 * Uses Convex via ConvexHttpClient (same pattern as convex-client.ts).
 *
 * After adding new Convex functions, run `npx convex dev` once to
 * regenerate the typed api object, then remove the `(api as any)` casts.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  created_at: string;
  updated_at: string;
  chat_id: string;
  name: string;
  description?: string;
  goals?: string;
  context_notes?: string;
  status: "active" | "archived";
  metadata?: Record<string, unknown>;
}

export interface BoardSession {
  id: string;
  created_at: string;
  chat_id: string;
  project_id?: string;
  project_name?: string;
  agent_outputs: Record<string, string>;
  synthesis?: string;
  decisions?: Array<{ label: string; value: string }>;
  task_id?: string;
  status: "running" | "completed" | "failed";
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _client: ConvexHttpClient | null = null;

function getClient(): ConvexHttpClient | null {
  if (_client) return _client;
  const url = process.env.CONVEX_URL;
  if (!url) return null;
  _client = new ConvexHttpClient(url);
  return _client;
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

function toProject(doc: any): Project {
  return {
    id: doc._id,
    created_at: new Date(doc._creationTime).toISOString(),
    updated_at: doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : new Date(doc._creationTime).toISOString(),
    chat_id: doc.chat_id,
    name: doc.name,
    description: doc.description,
    goals: doc.goals,
    context_notes: doc.context_notes,
    status: doc.status,
    metadata: doc.metadata,
  };
}

function toBoardSession(doc: any): BoardSession {
  return {
    id: doc._id,
    created_at: new Date(doc._creationTime).toISOString(),
    chat_id: doc.chat_id,
    project_id: doc.project_id,
    project_name: doc.project_name,
    agent_outputs: doc.agent_outputs ?? {},
    synthesis: doc.synthesis,
    decisions: doc.decisions,
    task_id: doc.task_id,
    status: doc.status,
    metadata: doc.metadata,
  };
}

// ---------------------------------------------------------------------------
// Projects CRUD
// ---------------------------------------------------------------------------

export async function createProject(
  chatId: string,
  name: string,
  description?: string
): Promise<Project | null> {
  const cx = getClient();
  if (!cx) return null;

  try {
    const id = await cx.mutation(api.projects.insert, {
      chat_id: chatId,
      name,
      description,
      status: "active",
    });
    const doc = await cx.query(api.projects.getById, { id });
    if (!doc) return null;
    return toProject(doc);
  } catch (err) {
    console.error("createProject error:", err);
    return null;
  }
}

/**
 * Get a project by UUID or fuzzy name match.
 * Tries UUID lookup first, then name search.
 */
export async function getProject(
  chatId: string,
  nameOrId: string
): Promise<Project | null> {
  const cx = getClient();
  if (!cx) return null;

  try {
    // Try UUID lookup
    if (nameOrId.length > 20 && !nameOrId.includes(" ")) {
      try {
        const doc = await cx.query(api.projects.getById, { id: nameOrId as any });
        if (doc && doc.chat_id === chatId) return toProject(doc);
      } catch {
        // Not a valid ID, fall through to name search
      }
    }

    // Fuzzy name search
    const doc = await cx.query(api.projects.findByName, {
      chat_id: chatId,
      name: nameOrId,
    });
    if (!doc) return null;
    return toProject(doc);
  } catch (err) {
    console.error("getProject error:", err);
    return null;
  }
}

export async function listProjects(
  chatId: string,
  status: "active" | "archived" = "active"
): Promise<Project[]> {
  const cx = getClient();
  if (!cx) return [];

  try {
    const docs = await cx.query(api.projects.getByChat, {
      chat_id: chatId,
      status,
    });
    return (docs ?? []).map(toProject);
  } catch {
    return [];
  }
}

export async function updateProject(
  projectId: string,
  updates: Partial<Pick<Project, "name" | "description" | "goals" | "context_notes" | "status">>
): Promise<boolean> {
  const cx = getClient();
  if (!cx) return false;

  try {
    await cx.mutation(api.projects.patch, {
      id: projectId as any,
      updates,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Append text to a project's context_notes field.
 * Fetches current value, appends, and saves.
 */
export async function appendProjectContext(
  projectId: string,
  text: string
): Promise<boolean> {
  const cx = getClient();
  if (!cx) return false;

  try {
    const doc = await cx.query(api.projects.getById, { id: projectId as any });
    if (!doc) return false;

    const existing = doc.context_notes || "";
    const timestamp = new Date().toISOString().split("T")[0];
    const newNotes = existing
      ? `${existing}\n\n[${timestamp}] ${text}`
      : `[${timestamp}] ${text}`;

    await cx.mutation(api.projects.patch, {
      id: projectId as any,
      updates: { context_notes: newNotes },
    });
    return true;
  } catch {
    return false;
  }
}

export async function archiveProject(
  chatId: string,
  nameOrId: string
): Promise<boolean> {
  const project = await getProject(chatId, nameOrId);
  if (!project) return false;
  return updateProject(project.id, { status: "archived" });
}

// ---------------------------------------------------------------------------
// Board Sessions CRUD
// ---------------------------------------------------------------------------

export async function createBoardSession(
  chatId: string,
  project: Project
): Promise<BoardSession | null> {
  const cx = getClient();
  if (!cx) return null;

  try {
    const id = await cx.mutation(api.boardSessions.insert, {
      chat_id: chatId,
      project_id: project.id as any,
      project_name: project.name,
      agent_outputs: {},
      status: "running",
    });
    const doc = await cx.query(api.boardSessions.getById, { id });
    if (!doc) return null;
    return toBoardSession(doc);
  } catch (err) {
    console.error("createBoardSession error:", err);
    return null;
  }
}

export async function updateBoardSession(
  sessionId: string,
  updates: Partial<Pick<BoardSession, "agent_outputs" | "synthesis" | "decisions" | "task_id" | "status" | "metadata">>
): Promise<boolean> {
  const cx = getClient();
  if (!cx) return false;

  try {
    await cx.mutation(api.boardSessions.patch, {
      id: sessionId as any,
      updates,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getLastBoardSession(
  chatId: string,
  projectId?: string
): Promise<BoardSession | null> {
  const cx = getClient();
  if (!cx) return null;

  try {
    if (projectId) {
      const doc = await cx.query(api.boardSessions.getLastByProject, {
        project_id: projectId as any,
      });
      return doc ? toBoardSession(doc) : null;
    }

    const docs = await cx.query(api.boardSessions.getByChat, {
      chat_id: chatId,
      limit: 1,
    });
    return docs && docs[0] ? toBoardSession(docs[0]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context Formatter
// ---------------------------------------------------------------------------

/**
 * Format a project into a markdown section for agent prompts.
 * Caps context_notes at 2000 chars to avoid blowing prompt budgets.
 */
export function formatProjectContext(project: Project): string {
  const lines: string[] = [
    `## PROJECT: ${project.name}`,
  ];

  if (project.description) {
    lines.push(`**Description:** ${project.description}`);
  }

  if (project.goals) {
    lines.push(`**Goals:** ${project.goals}`);
  }

  if (project.context_notes) {
    const notes = project.context_notes.length > 2000
      ? project.context_notes.slice(-2000) + "\n_(truncated — showing most recent 2000 chars)_"
      : project.context_notes;
    lines.push(`**Context Notes:**\n${notes}`);
  }

  lines.push(`**Status:** ${project.status} | **Created:** ${project.created_at.split("T")[0]}`);

  return lines.join("\n\n");
}
