#!/usr/bin/env bun
/**
 * Google Drive CLI
 *
 * Usage:
 *   bun src/cli/gdrive.ts search "<query>"
 *   bun src/cli/gdrive.ts download <fileId> <localPath>
 */

import { init, getToken, output, error, run } from "./_google";
import { writeFile } from "fs/promises";

const DRIVE = "https://www.googleapis.com/drive/v3";

async function searchFiles(query: string): Promise<void> {
  const token = await getToken();

  const q = `name contains '${query.replace(/'/g, "\\'")}'`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,modifiedTime,size,owners)",
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
    mimeType: f.mimeType,
    modified: f.modifiedTime,
    size: f.size ? parseInt(f.size) : null,
    owner: f.owners?.[0]?.displayName || null,
  }));

  output(files);
}

async function downloadFile(fileId: string, localPath: string): Promise<void> {
  const token = await getToken();

  const res = await fetch(`${DRIVE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) error(`Drive API ${res.status}: ${await res.text()}`);

  const buffer = await res.arrayBuffer();
  await writeFile(localPath, Buffer.from(buffer));

  output({ fileId, path: localPath, bytes: buffer.byteLength });
}

// --- Main ---
run(async () => {
  await init();
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "search":
      if (!args[0]) error("Usage: search <query>");
      await searchFiles(args[0]);
      break;
    case "download":
      if (args.length < 2) error("Usage: download <fileId> <localPath>");
      await downloadFile(args[0], args[1]);
      break;
    default:
      error(`Unknown command: ${cmd || "(none)"}. Available: search, download`);
  }
});
