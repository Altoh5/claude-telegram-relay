import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// transcribe.ts reads VOICE_PROVIDER at module level, so we need to
// set env vars before importing. We use dynamic imports per test group.

describe("transcribe", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns empty string when VOICE_PROVIDER is not set", async () => {
    delete process.env.VOICE_PROVIDER;
    // Fresh import to pick up env
    const mod = await import("./transcribe.ts");
    const result = await mod.transcribe(Buffer.from("audio"));
    // When provider is empty, returns ""
    expect(result).toBe("");
  });

  it("returns empty string for unknown VOICE_PROVIDER", async () => {
    process.env.VOICE_PROVIDER = "unknown_provider";
    const { transcribe } = await import("./transcribe.ts");
    const result = await transcribe(Buffer.from("audio"));
    expect(result).toBe("");
  });
});
