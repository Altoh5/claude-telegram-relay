/**
 * Go - Environment Loader
 *
 * Loads .env file from project root. No external dependencies.
 */

import { readFile } from "fs/promises";
import { join } from "path";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();

export async function loadEnv(envPath?: string): Promise<void> {
  const path = envPath || join(PROJECT_ROOT, ".env");
  const content = await readFile(path, "utf-8").catch(() => "");

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join("=").trim();
      }
    }
  }
}

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function optionalEnv(key: string, defaultValue: string = ""): string {
  return process.env[key] || defaultValue;
}

export { PROJECT_ROOT };
