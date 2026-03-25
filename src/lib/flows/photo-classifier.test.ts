import { describe, it, expect, mock } from "bun:test";

const mockCallClaude = mock(async () => ({ text: "food_place", isError: false }));

mock.module("../claude", () => ({
  callClaude: mockCallClaude,
}));

const { classifyPhoto } = await import("./photo-classifier");

describe("classifyPhoto", () => {
  it("returns food_place classification", async () => {
    mockCallClaude.mockResolvedValueOnce({ text: "food_place", isError: false });
    const result = await classifyPhoto({
      caption: "Dinner at Boon Tong Kee",
      visionDescription: "A plate of chicken rice at a restaurant",
    });
    expect(result).toBe("food_place");
  });

  it("defaults to general for unknown classification", async () => {
    mockCallClaude.mockResolvedValueOnce({ text: "something_random", isError: false });
    const result = await classifyPhoto({
      caption: "",
      visionDescription: "A sunset photo",
    });
    expect(result).toBe("general");
  });
});
