/**
 * Shared Google CLI Helper
 *
 * Loads env, provides Google OAuth token, and standard JSON output.
 * Used by all Google service CLI scripts (gcal, gmail, gdocs, gsheets, gdrive).
 */

import { loadEnv } from "../lib/env";
import { getGoogleAccessToken } from "../lib/data-sources/google-auth";

export async function init(): Promise<void> {
  await loadEnv();
}

export async function getToken(): Promise<string> {
  try {
    return await getGoogleAccessToken();
  } catch (e: any) {
    error(e.message || "Failed to get Google access token");
  }
}

export function output(data: unknown): void {
  console.log(JSON.stringify({ ok: true, data }));
}

export function error(msg: string): never {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

/**
 * Wrap the main function of a CLI script with error handling.
 * Catches unhandled errors and outputs them as JSON.
 */
export function run(fn: () => Promise<void>): void {
  fn().catch((e: any) => {
    error(e.message || String(e));
  });
}
