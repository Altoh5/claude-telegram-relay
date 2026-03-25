import { getGoogleAccessToken } from "../data-sources/google-auth";

export interface AppointmentDetails {
  title: string;
  date: string;        // YYYY-MM-DD
  start_time: string;  // HH:MM
  end_time: string;    // HH:MM (empty = start + 1h)
  location: string;
  attendees: string[];
}

export function buildCalendarEvent(details: AppointmentDetails) {
  const tz = process.env.USER_TIMEZONE || "Asia/Singapore";

  // If end_time is empty, default to start + 1 hour
  let endTime = details.end_time;
  if (!endTime && details.start_time) {
    const [h, m] = details.start_time.split(":").map(Number);
    endTime = `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  return {
    summary: details.title,
    location: details.location || undefined,
    start: { dateTime: `${details.date}T${details.start_time}:00`, timeZone: tz },
    end: { dateTime: `${details.date}T${endTime}:00`, timeZone: tz },
    attendees: details.attendees.map((email) => ({ email })),
  };
}

export async function createCalendarEvent(details: AppointmentDetails): Promise<string> {
  const token = await getGoogleAccessToken();
  const event = buildCalendarEvent(details);

  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Calendar API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.htmlLink ?? "";
}
