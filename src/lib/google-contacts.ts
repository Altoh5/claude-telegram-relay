/**
 * Google Contacts Sync
 *
 * Fetches contacts from Google People API and upserts to Convex contacts table.
 * Uses existing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN from .env.
 *
 * Run manually: bun run src/lib/google-contacts.ts
 * Scheduled: launchd daily at 6 AM (com.go.contacts-sync)
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { loadEnv } from "./env";

await loadEnv();

interface GooglePerson {
  resourceName: string;
  names?: { displayName: string }[];
  emailAddresses?: { value: string }[];
  phoneNumbers?: { value: string }[];
  organizations?: { name: string }[];
}

interface PeopleApiResponse {
  connections?: GooglePerson[];
  nextPageToken?: string;
  totalPeople?: number;
}

async function refreshAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN"
    );
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  const json = (await resp.json()) as { access_token: string };
  return json.access_token;
}

async function fetchAllContacts(accessToken: string): Promise<GooglePerson[]> {
  const contacts: GooglePerson[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(
      "https://people.googleapis.com/v1/people/me/connections"
    );
    url.searchParams.set(
      "personFields",
      "names,emailAddresses,phoneNumbers,organizations"
    );
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      if (resp.status === 403) {
        console.error(
          "403 Forbidden — contacts.readonly scope may not be authorized."
        );
        console.error(
          "Re-run: bun run setup/setup-google-oauth.ts to add contacts scope."
        );
      }
      const err = await resp.text();
      throw new Error(`People API error ${resp.status}: ${err}`);
    }

    const json = (await resp.json()) as PeopleApiResponse;
    contacts.push(...(json.connections ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  return contacts;
}

function getConvex(): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL not set in .env");
  return new ConvexHttpClient(url);
}

async function main() {
  console.log("Google Contacts Sync starting...");

  const accessToken = await refreshAccessToken();
  console.log("Access token refreshed.");

  const contacts = await fetchAllContacts(accessToken);
  console.log(`Fetched ${contacts.length} contacts from Google.`);

  if (contacts.length === 0) {
    console.log("No contacts found. Done.");
    return;
  }

  const cx = getConvex();
  let synced = 0;
  let failed = 0;

  for (const person of contacts) {
    const googleId = person.resourceName; // e.g. "people/c123456"
    const name = person.names?.[0]?.displayName;
    if (!name) continue; // Skip contacts without a name

    try {
      await cx.mutation(api.contacts.upsert, {
        google_id: googleId,
        name,
        email: person.emailAddresses?.[0]?.value,
        phone: person.phoneNumbers?.[0]?.value,
        organization: person.organizations?.[0]?.name,
        last_synced: Date.now(),
      });
      synced++;
    } catch (err) {
      console.error(`Failed to upsert ${name}: ${err}`);
      failed++;
    }
  }

  console.log(`Sync complete: ${synced} upserted, ${failed} failed.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
