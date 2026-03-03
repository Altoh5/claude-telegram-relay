/**
 * Google OAuth Setup — Bot Account (altoh.bot@gmail.com)
 *
 * Gets a refresh token for the bot's Google account.
 * Uses existing GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET from .env.
 * Requests: gmail.readonly + drive (to list/post comment replies + export doc text)
 *
 * Run: bun run setup/setup-google-oauth-bot.ts
 *
 * IMPORTANT: Make sure your incognito window is logged in as altoh.bot@gmail.com
 * before running this — the browser will authorize whichever account is active.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createServer } from "http";
import { loadEnv } from "../src/lib/env";

await loadEnv();

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
const REDIRECT_PORT = 8977; // Different port from main OAuth script
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive",
].join(" ");

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env.\n" +
    "Run the main OAuth setup first: bun run setup/setup-google-oauth.ts"
  );
  process.exit(1);
}

console.log(`
╔══════════════════════════════════════════════════════════════╗
║       Google OAuth Setup — Bot Account                      ║
║   Enables: Gmail read + Google Drive API (comments/replies) ║
╚══════════════════════════════════════════════════════════════╝

Using existing Cloud project credentials from .env.
Client ID: ${clientId.slice(0, 20)}...

⚠️  IMPORTANT: Before continuing, make sure your incognito window
   is signed in as altoh.bot@gmail.com — that's the account
   that will be authorized.

Press Enter when ready...
`);

const readline = await import("readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

await ask("");

// Build authorization URL
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log(`\nOpening browser for authorization...`);
console.log(`\nIf it doesn't open automatically, paste this URL into your incognito window:\n`);
console.log(authUrl.toString() + "\n");

try {
  const { exec } = await import("child_process");
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${authUrl.toString()}"`);
} catch {}

// Wait for callback
const code = await new Promise<string>((resolve, reject) => {
  const timeout = setTimeout(() => {
    server.close();
    reject(new Error("Timed out waiting for authorization (120s)"));
  }, 120_000);

  const server = createServer((req, res) => {
    const url = new URL(req.url || "", `http://localhost:${REDIRECT_PORT}`);
    const authCode = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`);
      clearTimeout(timeout);
      server.close();
      reject(new Error(`Authorization failed: ${error}`));
      return;
    }

    if (authCode) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h2>✅ Authorization successful!</h2><p>You can close this tab and return to the terminal.</p>`);
      clearTimeout(timeout);
      server.close();
      resolve(authCode);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(REDIRECT_PORT, () => {
    console.log(`Waiting for callback on port ${REDIRECT_PORT}...`);
  });
});

// Exchange code for tokens
console.log("\nExchanging code for tokens...");

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  }),
});

if (!tokenResponse.ok) {
  const text = await tokenResponse.text();
  console.error(`Token exchange failed: ${text}`);
  process.exit(1);
}

const tokens = await tokenResponse.json();

if (!tokens.refresh_token) {
  console.error(
    "\n❌ No refresh token received.\n" +
    "This usually means the account was already authorized without 'prompt=consent'.\n" +
    "Go to https://myaccount.google.com/permissions (as altoh.bot@gmail.com),\n" +
    "revoke access to this app, then run this script again."
  );
  process.exit(1);
}

console.log("\n✅ Success!\n");
console.log(`GOOGLE_BOT_DOCS_REFRESH_TOKEN=${tokens.refresh_token}\n`);

const save = await ask("Save GOOGLE_BOT_DOCS_REFRESH_TOKEN to .env? (y/n): ");

if (save.toLowerCase() === "y") {
  const envPath = join(PROJECT_ROOT, ".env");
  let envContent = "";
  try {
    envContent = await readFile(envPath, "utf-8");
  } catch {}

  const key = "GOOGLE_BOT_DOCS_REFRESH_TOKEN";
  const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `${key}=${tokens.refresh_token}`);
  } else {
    envContent += `\n${key}=${tokens.refresh_token}`;
  }

  await writeFile(envPath, envContent);
  console.log(`\n✅ Saved to .env as GOOGLE_BOT_DOCS_REFRESH_TOKEN`);
}

rl.close();
