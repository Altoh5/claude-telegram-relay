import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

let _client: ConvexHttpClient | null = null;

export function getConvex(): ConvexHttpClient | null {
  const url = process.env.CONVEX_URL;
  if (!url) return null;
  if (!_client) _client = new ConvexHttpClient(url);
  return _client;
}

export { api };
