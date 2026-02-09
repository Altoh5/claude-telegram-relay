/**
 * Go - Google API Direct Access (Cross-Platform)
 *
 * Reads OAuth tokens and auto-refreshes when expired.
 * This bypasses both Claude CLI subprocesses and MCP servers entirely,
 * making API calls instant (<1s) instead of 60-180s via subprocess.
 *
 * WHY THIS EXISTS:
 * Claude CLI subprocesses initialize ALL configured MCP servers on startup.
 * From background services, this takes 60-180s and frequently times out.
 * Direct API calls using cached OAuth tokens are instant and reliable.
 *
 * PLATFORM SUPPORT:
 * - macOS: Reads/writes tokens via macOS Keychain (`security` CLI)
 * - Windows/Linux: Reads/writes tokens to a local JSON file
 *
 * TOKEN SOURCE:
 * Tokens are created by Google MCP servers (gmail-business, google-workspace)
 * during initial OAuth setup. This module reads those cached tokens.
 *
 * KEYCHAIN FORMAT (macOS):
 * Service: "gmail-business-oauth" or "google-workspace-oauth"
 * Account: "main-account"
 * Value: JSON { serverName, token: { accessToken, refreshToken, expiresAt, scope }, updatedAt }
 *
 * FILE FORMAT (Windows/Linux):
 * Stored in config/.google-tokens.json:
 * { "gmail-business-oauth": { serverName, token: { ... }, updatedAt }, ... }
 */

import { spawn } from "bun";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";

// Well-known service names for Google MCP servers
export const KEYCHAIN_GMAIL = "gmail-business-oauth";
export const KEYCHAIN_CALENDAR = "google-workspace-oauth";
const KEYCHAIN_ACCOUNT = "main-account";
const REFRESH_ENDPOINT =
  "https://google-workspace-extension.geminicli.com/refreshToken";

const IS_MACOS = process.platform === "darwin";
const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
const TOKEN_FILE = join(PROJECT_ROOT, "config", ".google-tokens.json");

export interface GoogleToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  tokenType?: string;
}

interface TokenFileEntry {
  serverName: string;
  token: GoogleToken;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Token File Storage (Windows/Linux)
// ---------------------------------------------------------------------------

async function readTokenFile(): Promise<Record<string, TokenFileEntry>> {
  try {
    const content = await readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeTokenFile(
  data: Record<string, TokenFileEntry>
): Promise<void> {
  const dir = dirname(TOKEN_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(TOKEN_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// macOS Keychain Storage
// ---------------------------------------------------------------------------

async function readKeychainEntry(service: string): Promise<GoogleToken> {
  const proc = spawn({
    cmd: [
      "security",
      "find-generic-password",
      "-s",
      service,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `No keychain entry for service "${service}". ` +
        `Set up the corresponding Google MCP server first to create the OAuth token.`
    );
  }
  const data = JSON.parse(output.trim());
  return data.token as GoogleToken;
}

async function writeKeychainEntry(
  service: string,
  token: GoogleToken
): Promise<void> {
  const data = JSON.stringify({
    serverName: service,
    token,
    updatedAt: Date.now(),
  });
  // Delete existing then re-add (security CLI has no in-place update)
  const del = spawn({
    cmd: [
      "security",
      "delete-generic-password",
      "-s",
      service,
      "-a",
      KEYCHAIN_ACCOUNT,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  await del.exited; // ignore errors (entry might not exist)
  const add = spawn({
    cmd: [
      "security",
      "add-generic-password",
      "-s",
      service,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
      data,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await add.exited) !== 0) {
    console.error(`Warning: Failed to save refreshed token for ${service}`);
  }
}

// ---------------------------------------------------------------------------
// Platform-Agnostic API
// ---------------------------------------------------------------------------

/**
 * Read an OAuth token from the platform credential store.
 * - macOS: reads from Keychain
 * - Windows/Linux: reads from config/.google-tokens.json
 *
 * Throws if the token doesn't exist.
 */
export async function getKeychainToken(
  service: string
): Promise<GoogleToken> {
  if (IS_MACOS) {
    return readKeychainEntry(service);
  }

  // File-based storage
  const tokens = await readTokenFile();
  const entry = tokens[service];
  if (!entry || !entry.token) {
    throw new Error(
      `No token found for "${service}" in ${TOKEN_FILE}. ` +
        `Set up the corresponding Google MCP server first, then copy the ` +
        `OAuth token to ${TOKEN_FILE}. See docs/architecture.md for format.`
    );
  }
  return entry.token;
}

/**
 * Save an updated OAuth token back to the platform credential store.
 */
export async function saveKeychainToken(
  service: string,
  token: GoogleToken
): Promise<void> {
  if (IS_MACOS) {
    return writeKeychainEntry(service, token);
  }

  // File-based storage
  const tokens = await readTokenFile();
  tokens[service] = {
    serverName: service,
    token,
    updatedAt: Date.now(),
  };
  await writeTokenFile(tokens);
}

/**
 * Get a valid access token for a Google API, refreshing if expired.
 *
 * Usage:
 *   const token = await getValidAccessToken(KEYCHAIN_GMAIL);
 *   fetch("https://gmail.googleapis.com/...", {
 *     headers: { Authorization: `Bearer ${token}` }
 *   });
 */
export async function getValidAccessToken(service: string): Promise<string> {
  const token = await getKeychainToken(service);

  // If token is still valid for 5+ minutes, use it as-is
  const fiveMinutes = 5 * 60 * 1000;
  if (token.expiresAt > Date.now() + fiveMinutes) {
    return token.accessToken;
  }

  // Refresh via cloud function (holds the OAuth client_secret server-side)
  console.log(`Refreshing ${service} OAuth token...`);
  const res = await fetch(REFRESH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: token.refreshToken }),
  });

  if (!res.ok) {
    throw new Error(
      `Token refresh failed for ${service}: ${res.status} ${await res.text()}`
    );
  }

  const fresh = (await res.json()) as Record<string, any>;
  const updated: GoogleToken = {
    accessToken: fresh.access_token,
    refreshToken: token.refreshToken, // preserve original
    expiresAt:
      fresh.expiry_date || Date.now() + (fresh.expires_in || 3600) * 1000,
    scope: token.scope,
    tokenType: "Bearer",
  };

  await saveKeychainToken(service, updated);
  return updated.accessToken;
}

/**
 * Check if Google OAuth tokens are available for a given service.
 * Does not validate the token -- just checks if the entry exists.
 */
export async function isGoogleAuthAvailable(
  service: string
): Promise<boolean> {
  try {
    await getKeychainToken(service);
    return true;
  } catch {
    return false;
  }
}
