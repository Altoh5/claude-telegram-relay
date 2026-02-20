/**
 * Google OAuth Setup for Straits Interactive account
 * Reuses existing GOOGLE_CLIENT_ID/SECRET, generates a new refresh token
 * and saves it as GOOGLE_SI_REFRESH_TOKEN in .env
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createServer } from "http";
import { exec } from "child_process";

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const REDIRECT_PORT = 8976;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env");
  process.exit(1);
}

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Google OAuth Setup — Straits Interactive Account           ║
║  Sign in with: alvin@straitsinteractive.com                 ║
╚══════════════════════════════════════════════════════════════╝
`);

// Build authorization URL
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("login_hint", "alvin@straitsinteractive.com");

// Start local server to catch the callback
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
      res.end(`<h2>Authorization failed: ${error}</h2>`);
      clearTimeout(timeout);
      server.close();
      reject(new Error(`Authorization failed: ${error}`));
      return;
    }

    if (authCode) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>Success! You can close this tab and return to the terminal.</h2>");
      clearTimeout(timeout);
      server.close();
      resolve(authCode);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(REDIRECT_PORT, () => {
    console.log(`Waiting for authorization on port ${REDIRECT_PORT}...`);
    console.log(`\nOpening browser — sign in with alvin@straitsinteractive.com\n`);

    // Open browser
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} "${authUrl.toString()}"`);
  });
});

// Exchange code for tokens
console.log("\nExchanging authorization code for tokens...");

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
  console.error("No refresh token received.");
  console.error(JSON.stringify(tokens, null, 2));
  process.exit(1);
}

console.log("\n✅ Got refresh token for Straits Interactive account!");

// Save to .env as GOOGLE_SI_REFRESH_TOKEN
const envPath = join(PROJECT_ROOT, ".env");
let envContent = "";
try {
  envContent = await readFile(envPath, "utf-8");
} catch {}

const key = "GOOGLE_SI_REFRESH_TOKEN";
const value = tokens.refresh_token;
const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");

if (regex.test(envContent)) {
  envContent = envContent.replace(regex, `${key}=${value}`);
} else {
  envContent += `\n${key}=${value}`;
}

await writeFile(envPath, envContent);
console.log(`\n✅ Saved GOOGLE_SI_REFRESH_TOKEN to .env`);
console.log("The bot will now fetch emails from both accounts.");
