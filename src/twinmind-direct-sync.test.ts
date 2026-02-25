// src/twinmind-direct-sync.test.ts
import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// We'll import after module exists
let syncFromTwinmindDirect: (supabase: any) => Promise<number>;

beforeEach(async () => {
  const mod = await import("./lib/twinmind-direct-sync.ts");
  syncFromTwinmindDirect = mod.syncFromTwinmindDirect;
});
