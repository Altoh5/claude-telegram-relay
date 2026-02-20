/**
 * Gmail Data Source
 *
 * Fetches unread email count and top subjects via Gmail REST API.
 * Uses Google OAuth refresh token — no MCP or Keychain needed.
 *
 * Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 */

import { register } from "../registry";
import {
  isGoogleAuthAvailable,
  getGoogleAccessToken,
  getGoogleAccounts,
  type GoogleAccount,
} from "../google-auth";
import type { DataSource, DataSourceResult } from "../types";

/**
 * Recursively extract plain text from a Gmail message payload.
 * Tries text/plain first, falls back to stripping HTML tags from text/html.
 */
function extractBodyText(payload: any): string {
  if (!payload) return "";

  // Check this part's body
  if (payload.body?.data && payload.body.size > 0) {
    const decoded = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    if (payload.mimeType === "text/plain") return decoded;
    if (payload.mimeType === "text/html") {
      // Strip HTML tags for a rough text extraction
      return decoded
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#\d+;/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  // Recurse into parts (multipart messages)
  if (payload.parts) {
    // Prefer text/plain
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain") {
        const text = extractBodyText(part);
        if (text) return text;
      }
    }
    // Fall back to text/html
    for (const part of payload.parts) {
      const text = extractBodyText(part);
      if (text) return text;
    }
  }

  return "";
}

/** Clean up raw email text for readable snippets. */
function cleanSnippet(text: string): string {
  return text
    // Strip URLs (http/https)
    .replace(/https?:\/\/\S+/gi, "")
    // Strip template/merge tags like *|EMAIL|*, {{name}}, %%tags%%
    .replace(/\*\|[^|]*\|\*/g, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/%%[^%]*%%/g, "")
    // Strip [1], [2] reference markers
    .replace(/\[\d+\]/g, "")
    // Strip email addresses
    .replace(/\S+@\S+\.\S+/g, "")
    // Strip UTM and query params leftovers (e.g. ?utm_source=...)
    .replace(/\?\S+/g, "")
    // Collapse whitespace
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Email accounts to exclude from briefings (lowercase). Lazy — evaluated after loadEnv(). */
let _excludedEmails: Set<string> | null = null;
function getExcludedEmails(): Set<string> {
  if (!_excludedEmails) {
    _excludedEmails = new Set(
      (process.env.GMAIL_EXCLUDE_ACCOUNTS || "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    );
  }
  return _excludedEmails;
}

/** Fetch unread emails for a single account. */
async function fetchAccountEmails(
  account: GoogleAccount,
  maxMessages = 5
): Promise<{ lines: string[]; total: number; accountLabel: string } | null> {
  const token = await getGoogleAccessToken(account);

  // Get the email address for this account
  const profileResp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const emailAddr = profileResp.ok
    ? (await profileResp.json()).emailAddress
    : account.label;

  // Skip excluded accounts
  if (getExcludedEmails().has(emailAddr.toLowerCase())) {
    return null;
  }

  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent("is:unread in:inbox -category:promotions -category:social")}&maxResults=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail API error for ${emailAddr} (${response.status}): ${text}`);
  }

  const data = await response.json();
  const total = data.resultSizeEstimate || 0;
  const messageIds: string[] =
    data.messages?.map((m: any) => m.id).slice(0, maxMessages) || [];

  if (total === 0) {
    return { lines: [], total: 0, accountLabel: emailAddr };
  }

  const subjects = await Promise.all(
    messageIds.map(async (id) => {
      try {
        const msgResp = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!msgResp.ok) return null;
        const msg = await msgResp.json();
        const headers = msg.payload?.headers || [];
        const subject =
          headers.find((h: any) => h.name === "Subject")?.value ||
          "(no subject)";
        const from =
          headers.find((h: any) => h.name === "From")?.value || "";
        const fromName = from.replace(/<.*>/, "").trim() || from;

        const bodyText = extractBodyText(msg.payload);
        const cleaned = bodyText
          ? cleanSnippet(bodyText)
          : msg.snippet || "";
        const snippet = cleaned.slice(0, 300);

        return `• **${fromName}**: ${subject}\n  _${snippet}${snippet.length >= 300 ? "..." : ""}_`;
      } catch {
        return null;
      }
    })
  );

  const lines = subjects.filter(Boolean) as string[];
  if (total > maxMessages) {
    lines.push(`_...and ${total - maxMessages} more unread_`);
  }

  return { lines, total, accountLabel: emailAddr };
}

const gmailSource: DataSource = {
  id: "gmail",
  name: "Gmail (Unread)",
  emoji: "📧",

  isAvailable(): boolean {
    return isGoogleAuthAvailable();
  },

  async fetch(): Promise<DataSourceResult> {
    const accounts = getGoogleAccounts();
    const multiAccount = accounts.length > 1;

    const rawResults = await Promise.all(
      accounts.map((acc) =>
        fetchAccountEmails(acc, multiAccount ? 3 : 5).catch((err) => ({
          lines: [`_Error fetching ${acc.label}: ${err.message}_`],
          total: 0,
          accountLabel: acc.label,
        }))
      )
    );

    // Filter out excluded (null) accounts
    const results = rawResults.filter(Boolean) as { lines: string[]; total: number; accountLabel: string }[];
    const totalCount = results.reduce((sum, r) => sum + r.total, 0);

    if (totalCount === 0) {
      return { lines: ["Inbox zero — no unread emails across all accounts"], meta: { count: 0 } };
    }

    const allLines: string[] = [];
    for (const result of results) {
      if (result.lines.length === 0) continue;
      if (multiAccount) {
        allLines.push(`**${result.accountLabel}** (${result.total} unread):`);
      }
      allLines.push(...result.lines);
    }

    return {
      lines: allLines.length > 0 ? allLines : [`${totalCount} unread emails`],
      meta: { count: totalCount },
    };
  },
};

register(gmailSource);
