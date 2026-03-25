import { describe, it, expect, mock } from "bun:test";

mock.module("../data-sources/google-auth", () => ({
  getGoogleAccessToken: mock(async () => "fake-token"),
}));

const mockFetch = mock(async () => ({
  ok: true,
  json: async () => ({ id: "event123", htmlLink: "https://calendar.google.com/event123" }),
}));
globalThis.fetch = mockFetch as any;

const { buildCalendarEvent, createCalendarEvent } = await import("./appointment");

describe("buildCalendarEvent", () => {
  it("builds correct event body from appointment details", () => {
    const event = buildCalendarEvent({
      title: "WMI Workshop",
      date: "2026-04-02",
      start_time: "14:00",
      end_time: "15:00",
      location: "WMI Office",
      attendees: ["jason@wmi.com"],
    });
    expect(event.summary).toBe("WMI Workshop");
    expect(event.start.dateTime).toContain("2026-04-02T14:00");
    expect(event.location).toBe("WMI Office");
    expect(event.attendees).toHaveLength(1);
  });

  it("handles missing end_time by defaulting to +1 hour", () => {
    const event = buildCalendarEvent({
      title: "Meeting",
      date: "2026-04-02",
      start_time: "10:00",
      end_time: "",
      location: "",
      attendees: [],
    });
    expect(event.end.dateTime).toContain("11:00");
  });
});
