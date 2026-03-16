/**
 * StartInfinity Board Setup
 *
 * One-time script that creates the "Task Triage" board, 3 status folders,
 * and 5 custom attributes. Saves IDs to .env.
 *
 * Run: bun run setup:startinfinity
 * Idempotent — skips creation if names already exist.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import * as readline from "readline";
import { loadEnv } from "./lib/env";
import { StartInfinityClient } from "./lib/startinfinity";

await loadEnv();

const API_KEY = process.env.STARTINFINITY_API_KEY;
if (!API_KEY) {
  console.error("❌ STARTINFINITY_API_KEY not set in .env");
  process.exit(1);
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

const FOLDER_NAMES = ["Backlog", "In Progress", "Done"];
const ATTRIBUTES = [
  { name: "Confidence", type: "number" as const },
  { name: "Contact", type: "text" as const },
  { name: "Source Meeting", type: "text" as const },
  { name: "Project", type: "text" as const },
  { name: "AI Suggestion", type: "longtext" as const },
];

const client = new StartInfinityClient(API_KEY);

// ---- Helpers ----

function findOrUndefined<T extends { name: string }>(items: T[], name: string): T | undefined {
  return items.find((x) => x.name === name);
}

function updateEnvFile(updates: Record<string, string>): void {
  const envPath = ".env";
  if (!existsSync(envPath)) {
    writeFileSync(envPath, "");
  }
  let content = readFileSync(envPath, "utf-8");
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content += `\n${line}`;
    }
  }
  writeFileSync(envPath, content);
}

// ---- Main ----

console.log("StartInfinity Board Setup");
console.log("=========================\n");

// 1. List workspaces and let user choose
console.log("Fetching workspaces...");
const workspaces = await client.getWorkspaces();
if (workspaces.length === 0) {
  console.error("❌ No workspaces found. Check your API key.");
  process.exit(1);
}

let workspace;
if (workspaces.length === 1) {
  workspace = workspaces[0];
  console.log(`✅ Workspace: ${workspace.name} (${workspace.id})\n`);
} else {
  console.log("Available workspaces:");
  workspaces.forEach((w, i) => console.log(`  ${i + 1}. ${w.name} (${w.id})`));
  const choice = await prompt(`Choose workspace [1-${workspaces.length}] (default: 1): `);
  const idx = Math.max(0, parseInt(choice || "1", 10) - 1);
  workspace = workspaces[Math.min(idx, workspaces.length - 1)];
  console.log(`✅ Workspace: ${workspace.name} (${workspace.id})\n`);
}

// 2. Ask for board name, then find or create
const defaultBoard = "Task Triage";
const boardNameInput = await prompt(`Board name [default: "${defaultBoard}"]: `);
const BOARD_NAME = boardNameInput || defaultBoard;

console.log(`Looking for board "${BOARD_NAME}"...`);
const boards = await client.getBoards(workspace.id);
let board = findOrUndefined(boards, BOARD_NAME);
if (board) {
  console.log(`✅ Board already exists: ${board.id}`);
} else {
  console.log(`Creating board "${BOARD_NAME}"...`);
  board = await client.createBoard(workspace.id, BOARD_NAME);
  console.log(`✅ Created board: ${board.id}`);
}

// 3. Find or create 3 folders
const existingFolders = await client.getFolders(workspace.id, board.id);
const folderIds: Record<string, string> = {};

for (const name of FOLDER_NAMES) {
  let folder = findOrUndefined(existingFolders, name);
  if (folder) {
    console.log(`✅ Folder "${name}" already exists: ${folder.id}`);
  } else {
    console.log(`Creating folder "${name}"...`);
    folder = await client.createFolder(workspace.id, board.id, name);
    console.log(`✅ Created folder "${name}": ${folder.id}`);
  }
  folderIds[name] = folder.id;
}

// 4. Find or create custom attributes
const existingAttrs = await client.getAttributes(workspace.id, board.id);
const attrIds: Record<string, string> = {};

for (const attr of ATTRIBUTES) {
  const existing = findOrUndefined(existingAttrs, attr.name);
  if (existing) {
    console.log(`✅ Attribute "${attr.name}" already exists: ${existing.id}`);
    attrIds[attr.name] = existing.id;
  } else {
    console.log(`Creating attribute "${attr.name}" (${attr.type})...`);
    const created = await client.createAttribute(workspace.id, board.id, attr);
    console.log(`✅ Created attribute "${attr.name}": ${created.id}`);
    attrIds[attr.name] = created.id;
  }
}

// 5. Save to .env
const envUpdates: Record<string, string> = {
  STARTINFINITY_WORKSPACE_ID: workspace.id,
  STARTINFINITY_BOARD_ID: board.id,
  STARTINFINITY_FOLDER_BACKLOG_ID: folderIds["Backlog"],
  STARTINFINITY_FOLDER_IN_PROGRESS_ID: folderIds["In Progress"],
  STARTINFINITY_FOLDER_DONE_ID: folderIds["Done"],
};

updateEnvFile(envUpdates);

// 6. Print summary
console.log("\n=== Setup Complete ===");
console.log(`Workspace: ${workspace.name} → ${workspace.id}`);
console.log(`Board: ${BOARD_NAME} → ${board.id}`);
console.log(`Folders:`);
for (const [name, id] of Object.entries(folderIds)) {
  console.log(`  ${name} → ${id}`);
}
console.log(`Attributes:`);
for (const [name, id] of Object.entries(attrIds)) {
  console.log(`  ${name} → ${id}`);
}
console.log("\n✅ IDs saved to .env");
console.log(`\nView board: https://app.startinfinity.com/board/${board.id}`);
