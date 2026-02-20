/**
 * Google OAuth Token Refresh
 *
 * Refreshes Google OAuth tokens using env vars.
 * No Keychain dependency — works on VPS and any platform.
 *
 * Supports multiple accounts:
 *   Default: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   Additional: GOOGLE_<LABEL>_REFRESH_TOKEN (reuses same client ID/secret)
 *              or GOOGLE_<LABEL>_CLIENT_ID, GOOGLE_<LABEL>_CLIENT_SECRET, GOOGLE_<LABEL>_REFRESH_TOKEN
 */

export interface GoogleAccount {
  label: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

export function isGoogleAuthAvailable(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  );
}

/** Discover all configured Google accounts from env vars. */
export function getGoogleAccounts(): GoogleAccount[] {
  const accounts: GoogleAccount[] = [];

  const defaultClientId = process.env.GOOGLE_CLIENT_ID;
  const defaultClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const defaultRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  // Default account
  if (defaultClientId && defaultClientSecret && defaultRefreshToken) {
    accounts.push({
      label: "default",
      clientId: defaultClientId,
      clientSecret: defaultClientSecret,
      refreshToken: defaultRefreshToken,
    });
  }

  // Scan for additional accounts: GOOGLE_<LABEL>_REFRESH_TOKEN
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^GOOGLE_([A-Z0-9_]+)_REFRESH_TOKEN$/);
    if (!match || !value) continue;
    const label = match[1];
    // Skip if it's the default (no prefix)
    if (label === "") continue;
    // Skip CLIENT_ID/CLIENT_SECRET keys that happen to match the pattern
    if (label === "CLIENT") continue;

    const clientId = process.env[`GOOGLE_${label}_CLIENT_ID`] || defaultClientId;
    const clientSecret = process.env[`GOOGLE_${label}_CLIENT_SECRET`] || defaultClientSecret;

    if (clientId && clientSecret) {
      accounts.push({
        label: label.toLowerCase(),
        clientId,
        clientSecret,
        refreshToken: value,
      });
    }
  }

  return accounts;
}

export async function getGoogleAccessToken(account?: GoogleAccount): Promise<string> {
  const cacheKey = account?.label || "default";

  // Return cached token if still valid (with 60s buffer)
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  const clientId = account?.clientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = account?.clientSecret || process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = account?.refreshToken || process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      `Missing Google OAuth env vars for account "${cacheKey}"`
    );
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token refresh failed for "${cacheKey}" (${response.status}): ${text}`);
  }

  const data = await response.json();
  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });

  return data.access_token;
}
