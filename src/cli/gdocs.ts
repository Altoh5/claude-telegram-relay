#!/usr/bin/env bun
/**
 * Google Docs CLI
 *
 * Usage:
 *   bun src/cli/gdocs.ts find "<query>"
 *   bun src/cli/gdocs.ts read <docId>
 *   bun src/cli/gdocs.ts create "<title>"
 */

import { init, getToken, output, error, run } from "./_google";

const DRIVE = "https://www.googleapis.com/drive/v3";
const DOCS = "https://docs.googleapis.com/v1";

async function findDocs(query: string): Promise<void> {
  const token = await getToken();

  const q = `mimeType='application/vnd.google-apps.document' and name contains '${query.replace(/'/g, "\\'")}'`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,modifiedTime,owners)",
    orderBy: "modifiedTime desc",
    pageSize: "20",
  });

  const res = await fetch(`${DRIVE}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) error(`Drive API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const files = (data.files || []).map((f: any) => ({
    id: f.id,
    name: f.name,
    modified: f.modifiedTime,
    owner: f.owners?.[0]?.displayName || null,
  }));

  output(files);
}

async function readDoc(docId: string): Promise<void> {
  const token = await getToken();

  // Use Drive export for clean plain text (simpler than parsing Docs API JSON)
  const res = await fetch(`${DRIVE}/files/${docId}/export?mimeType=text/plain`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) error(`Drive API ${res.status}: ${await res.text()}`);

  const text = await res.text();
  output({ id: docId, content: text.substring(0, 50000) });
}

async function createDoc(title: string): Promise<void> {
  const token = await getToken();

  const res = await fetch(`${DOCS}/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });

  if (!res.ok) error(`Docs API ${res.status}: ${await res.text()}`);

  const doc = await res.json();
  output({ id: doc.documentId, title: doc.title, link: `https://docs.google.com/document/d/${doc.documentId}/edit` });
}

// --- Main ---
run(async () => {
  await init();
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "find":
      if (!args[0]) error("Usage: find <query>");
      await findDocs(args[0]);
      break;
    case "read":
      if (!args[0]) error("Usage: read <docId>");
      await readDoc(args[0]);
      break;
    case "create":
      if (!args[0]) error("Usage: create <title>");
      await createDoc(args[0]);
      break;
    default:
      error(`Unknown command: ${cmd || "(none)"}. Available: find, read, create`);
  }
});
