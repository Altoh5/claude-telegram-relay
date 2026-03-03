/**
 * Google OAuth Token Refresh — Bot Account (altoh.bot@gmail.com)
 *
 * Same pattern as src/lib/data-sources/google-auth.ts but uses the
 * bot account's refresh token (GOOGLE_BOT_DOCS_REFRESH_TOKEN).
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID        (shared with main account)
 *   GOOGLE_CLIENT_SECRET    (shared with main account)
 *   GOOGLE_BOT_DOCS_REFRESH_TOKEN
 */

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export function isBotAuthAvailable(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_BOT_DOCS_REFRESH_TOKEN
  );
}

export async function getBotAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const refreshToken = process.env.GOOGLE_BOT_DOCS_REFRESH_TOKEN!;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing bot OAuth env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_BOT_DOCS_REFRESH_TOKEN"
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
    throw new Error(`Bot token refresh failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.accessToken;
}
