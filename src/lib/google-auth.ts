/**
 * Go - Google API Direct Access
 *
 * Reads OAuth tokens from macOS Keychain and auto-refreshes when expired.
 * This bypasses both Claude CLI subprocesses and MCP servers entirely,
 * making API calls instant (<1s) instead of 60-180s via subprocess.
 *
 * WHY THIS EXISTS:
 * Claude CLI subprocesses initialize ALL configured MCP servers on startup.
 * From launchd (background), this takes 60-180s and frequently times out.
 * Direct API calls using cached OAuth tokens are instant and reliable.
 *
 * REQUIREMENTS:
 * - macOS (uses `security` CLI for keychain access)
 * - Google OAuth tokens stored in keychain by a Google MCP server
 *   (gmail-business or google-workspace extensions)
 * - Refresh endpoint: google-workspace-extension.geminicli.com
 *
 * KEYCHAIN FORMAT:
 * Service: "gmail-business-oauth" or "google-workspace-oauth"
 * Account: "main-account"
 * Value: JSON { serverName, token: { accessToken, refreshToken, expiresAt, scope }, updatedAt }
 */

import { spawn } from "bun";

// Well-known keychain service names for Google MCP servers
export const KEYCHAIN_GMAIL = "gmail-business-oauth";
export const KEYCHAIN_CALENDAR = "google-workspace-oauth";
const KEYCHAIN_ACCOUNT = "main-account";
const REFRESH_ENDPOINT =
  "https://google-workspace-extension.geminicli.com/refreshToken";

export interface GoogleToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  tokenType?: string;
}

/**
 * Read an OAuth token from the macOS Keychain.
 * Throws if the keychain entry doesn't exist or can't be parsed.
 */
export async function getKeychainToken(service: string): Promise<GoogleToken> {
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

/**
 * Save an updated OAuth token back to the macOS Keychain.
 */
async function saveKeychainToken(
  service: string,
  token: GoogleToken
): Promise<void> {
  const data = JSON.stringify({
    serverName: service,
    token,
    updatedAt: Date.now(),
  });
  // Delete existing entry then re-add (security CLI has no in-place update)
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
  await del.exited; // ignore errors (might not exist)
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
 * Check if Google OAuth keychain tokens are available.
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
