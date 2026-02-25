import { describe, it, expect, mock, spyOn, afterEach } from "bun:test";
import * as fs from "fs/promises";

// Dynamic import to allow mocking
const getModule = () => import("./lib/twinmind-direct-sync.ts");

// ─── readTwinMindToken ────────────────────────────────────────────────────────

describe("readTwinMindToken", () => {
  afterEach(() => {
    // clear module cache between tests
  });

  it("returns token when credentials file has twinmind entry", async () => {
    const fakeCreds = {
      mcpOAuth: {
        "twinmind|abc123": {
          serverUrl: "https://api.thirdear.live/v3/mcp",
          accessToken: "test-access-token-xyz",
          refreshToken: "test-refresh-token",
        },
      },
    };

    const readFileSpy = spyOn(fs, "readFile").mockResolvedValueOnce(
      JSON.stringify(fakeCreds) as any
    );

    const { readTwinMindToken } = await getModule();
    const result = await readTwinMindToken();

    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("test-access-token-xyz");
    expect(result?.serverUrl).toBe("https://api.thirdear.live/v3/mcp");

    readFileSpy.mockRestore();
  });

  it("returns null when credentials file is missing", async () => {
    const readFileSpy = spyOn(fs, "readFile").mockRejectedValueOnce(
      new Error("ENOENT") as any
    );

    const { readTwinMindToken } = await getModule();
    const result = await readTwinMindToken();

    expect(result).toBeNull();
    readFileSpy.mockRestore();
  });

  it("returns null when mcpOAuth has no twinmind entry", async () => {
    const fakeCreds = { mcpOAuth: { "other|server": { serverUrl: "https://other.com" } } };
    const readFileSpy = spyOn(fs, "readFile").mockResolvedValueOnce(
      JSON.stringify(fakeCreds) as any
    );

    const { readTwinMindToken } = await getModule();
    const result = await readTwinMindToken();

    expect(result).toBeNull();
    readFileSpy.mockRestore();
  });
});
