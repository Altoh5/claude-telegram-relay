#!/usr/bin/env bun
/**
 * Google Sheets CLI
 *
 * Usage:
 *   bun src/cli/gsheets.ts find "<query>"
 *   bun src/cli/gsheets.ts read <spreadsheetId>
 *   bun src/cli/gsheets.ts range <spreadsheetId> "<Sheet1!A1:B10>"
 */

import { init, getToken, output, error, run } from "./_google";

const DRIVE = "https://www.googleapis.com/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4";

async function findSheets(query: string): Promise<void> {
  const token = await getToken();

  const q = `mimeType='application/vnd.google-apps.spreadsheet' and name contains '${query.replace(/'/g, "\\'")}'`;
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

async function readSheet(spreadsheetId: string): Promise<void> {
  const token = await getToken();

  // Export as CSV for simple consumption
  const res = await fetch(`${DRIVE}/files/${spreadsheetId}/export?mimeType=text/csv`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) error(`Drive API ${res.status}: ${await res.text()}`);

  const csv = await res.text();
  output({ id: spreadsheetId, format: "csv", content: csv.substring(0, 50000) });
}

async function getRange(spreadsheetId: string, range: string): Promise<void> {
  const token = await getToken();

  const res = await fetch(
    `${SHEETS}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) error(`Sheets API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  output({ range: data.range, rows: data.values || [] });
}

// --- Main ---
run(async () => {
  await init();
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "find":
      if (!args[0]) error("Usage: find <query>");
      await findSheets(args[0]);
      break;
    case "read":
      if (!args[0]) error("Usage: read <spreadsheetId>");
      await readSheet(args[0]);
      break;
    case "range":
      if (args.length < 2) error("Usage: range <spreadsheetId> <range>");
      await getRange(args[0], args[1]);
      break;
    default:
      error(`Unknown command: ${cmd || "(none)"}. Available: find, read, range`);
  }
});
