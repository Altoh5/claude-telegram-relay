/**
 * Google Drive API helpers for Docs comment bot.
 *
 * All calls use the bot account (altoh.bot@gmail.com) via google-bot-auth.ts.
 * The bot must have at least Commenter access on any doc it replies to.
 */

import { getBotAccessToken } from "./google-bot-auth";

export interface DocReply {
  id: string;
  content: string;
  author: string;
  createdTime: string;
}

export interface DocComment {
  id: string;
  content: string;
  author: string;
  resolved: boolean;
  createdTime: string;
  replies: DocReply[];
}

/**
 * Export a Google Doc as plain text for Claude context.
 */
export async function fetchDocAsText(docId: string): Promise<string> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    throw new Error(`Drive export failed (${response.status}): ${await response.text()}`);
  }
  const text = await response.text();
  // Truncate to ~8000 chars to stay within Claude context
  return text.length > 8000 ? text.slice(0, 8000) + "\n\n[...truncated]" : text;
}

/**
 * Fetch doc metadata (title).
 */
export async function fetchDocTitle(docId: string): Promise<string> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}?fields=name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) return "Untitled Document";
  const data = await response.json();
  return data.name || "Untitled Document";
}

/**
 * List all unresolved comments on a doc.
 */
export async function listComments(docId: string): Promise<DocComment[]> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/comments?fields=comments(id,content,author,resolved,createdTime,replies(id,content,author,createdTime))&includeDeleted=false&pageSize=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    throw new Error(`Drive comments failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  const comments: DocComment[] = (data.comments || []).map((c: any) => ({
    id: c.id,
    content: c.content || "",
    author: c.author?.displayName || "Unknown",
    resolved: c.resolved || false,
    createdTime: c.createdTime || "",
    replies: (c.replies || []).map((r: any) => ({
      id: r.id,
      content: r.content || "",
      author: r.author?.displayName || "Unknown",
      createdTime: r.createdTime || "",
    })),
  }));
  return comments.filter((c) => !c.resolved);
}

/**
 * Post a reply to a comment thread. Returns the new reply ID.
 */
export async function postCommentReply(
  docId: string,
  commentId: string,
  text: string
): Promise<string> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/comments/${commentId}/replies?fields=id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    }
  );
  if (!response.ok) {
    throw new Error(`Post reply failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  return data.id as string;
}

/**
 * Update an existing reply in a comment thread.
 */
export async function updateCommentReply(
  docId: string,
  commentId: string,
  replyId: string,
  text: string
): Promise<void> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/comments/${commentId}/replies/${replyId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    }
  );
  if (!response.ok) {
    throw new Error(`Update reply failed (${response.status}): ${await response.text()}`);
  }
}

/**
 * Append text to the end of a Google Doc body.
 * Requires the bot account to have Editor access on the doc.
 */
export async function appendToDoc(docId: string, text: string): Promise<void> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [{
          insertText: {
            endOfSegmentLocation: { segmentId: "" },
            text: text.endsWith("\n") ? text : text + "\n",
          },
        }],
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`Append to doc failed (${response.status}): ${await response.text()}`);
  }
}

/**
 * Replace all occurrences of oldText with newText in a Google Doc body.
 * Returns the number of replacements made.
 * Requires the bot account to have Editor access on the doc.
 */
export async function replaceTextInDoc(
  docId: string,
  oldText: string,
  newText: string
): Promise<number> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [{
          replaceAllText: {
            containsText: { text: oldText, matchCase: false },
            replaceText: newText,
          },
        }],
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`Replace in doc failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  return data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
}

/**
 * Delete a reply from a comment thread.
 */
export async function deleteCommentReply(
  docId: string,
  commentId: string,
  replyId: string
): Promise<void> {
  const token = await getBotAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/comments/${commentId}/replies/${replyId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Delete reply failed (${response.status}): ${await response.text()}`);
  }
}
