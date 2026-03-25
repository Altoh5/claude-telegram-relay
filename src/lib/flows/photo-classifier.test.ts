import { describe, it, expect, mock } from "bun:test";

const mockCreate = mock(async () => ({
  content: [{ type: "text", text: "food_place" }],
}));

mock.module("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

const { classifyPhoto } = await import("./photo-classifier");

describe("classifyPhoto", () => {
  it("returns food_place classification", async () => {
    const result = await classifyPhoto({
      caption: "Dinner at Boon Tong Kee",
      visionDescription: "A plate of chicken rice at a restaurant",
    });
    expect(result).toBe("food_place");
  });

  it("defaults to general for unknown classification", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "something_random" }],
    });
    const result = await classifyPhoto({
      caption: "",
      visionDescription: "A sunset photo",
    });
    expect(result).toBe("general");
  });
});
