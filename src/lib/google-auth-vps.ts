/**
 * VPS Google OAuth Token Manager
 *
 * On VPS (Linux), there's no macOS Keychain. This module:
 * 1. Reads refresh tokens from environment variables
 * 2. Refreshes access tokens via the cloud function
 * 3. Caches access tokens in memory with expiry checks
 *
 * Required env vars (set during VPS setup):
 *   GMAIL_REFRESH_TOKEN     — for your Gmail account
 *   WORKSPACE_REFRESH_TOKEN — for your Google Workspace (Calendar)
 *
 * How to get refresh tokens:
 * 1. On your Mac, set up the gmail-business and google-workspace MCP servers
 * 2. Run the token export script: bun run setup/export-tokens.ts
 * 3. Copy the refresh tokens to your VPS .env file
 */

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

const REFRESH_URL =
  "https://google-workspace-extension.geminicli.com/refreshToken";

// Map service names to env var names
const SERVICE_TO_ENV: Record<string, string> = {
  "gmail-business": "GMAIL_REFRESH_TOKEN",
  "google-workspace": "WORKSPACE_REFRESH_TOKEN",
};

/**
 * Get a valid access token for a Google service.
 * Refreshes automatically when expired (5-min buffer).
 */
export async function getValidAccessToken(service: string): Promise<string> {
  // Check cache first
  const cached = tokenCache.get(service);
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.accessToken;
  }

  // Get refresh token from env
  const envVar = SERVICE_TO_ENV[service];
  if (!envVar) {
    throw new Error(`Unknown Google service: ${service}`);
  }

  const refreshToken = process.env[envVar];
  if (!refreshToken) {
    throw new Error(
      `Missing ${envVar} env var. Export tokens from your Mac using: bun run setup/export-tokens.ts`
    );
  }

  // Refresh via cloud function
  console.log(`Refreshing ${service} access token...`);
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Token refresh failed for ${service}: ${res.status} ${errText}`
    );
  }

  const data = (await res.json()) as Record<string, any>;
  const accessToken = data.access_token;
  const expiresIn = data.expires_in || 3600;
  const expiresAt = Date.now() + expiresIn * 1000;

  // Cache it
  tokenCache.set(service, { accessToken, expiresAt });
  console.log(
    `${service} token refreshed (expires in ${Math.round(expiresIn / 60)}m)`
  );

  return accessToken;
}

/**
 * Check if a Google service has a refresh token configured.
 */
export function isServiceConfigured(service: string): boolean {
  const envVar = SERVICE_TO_ENV[service];
  return !!(envVar && process.env[envVar]);
}
