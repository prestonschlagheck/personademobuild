import "server-only";
import { z } from "zod";
import { CALENDAR_DAYS, CALENDAR_LIMIT, FOLDER_LIMIT, type CalendarEvent } from "@/lib/gmail/workspace-facts";

// Calendar and Drive REST over plain fetch, read-only. Only event titles and start times and folder names
// are read, never descriptions, attendees or file contents, and nothing read here is stored beyond the facts.

const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DAY_MS = 86_400_000;

const eventsSchema = z.object({
  items: z
    .array(
      z.object({
        summary: z.string().optional(),
        start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
        creator: z.object({ self: z.boolean().optional() }).optional(),
        organizer: z.object({ self: z.boolean().optional() }).optional(),
      }),
    )
    .optional(),
});
const filesSchema = z.object({ files: z.array(z.object({ name: z.string() })).optional() });

async function get<T>(token: string, url: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(6_000) });
  if (!res.ok) throw new Error(`google request failed with ${res.status}`);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new Error("google response did not parse");
  return parsed.data;
}

/** The primary calendar's next week, soonest first. */
export async function upcomingEvents(token: string, now: Date = new Date()): Promise<CalendarEvent[]> {
  const query = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + CALENDAR_DAYS * DAY_MS).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(CALENDAR_LIMIT),
    fields: "items(summary,start,creator/self,organizer/self)",
  });
  const { items = [] } = await get(token, `${CALENDAR_API}?${query}`, eventsSchema);
  return items.flatMap((item) => {
    const start = item.start?.dateTime ?? item.start?.date;
    if (!start) return [];
    return [{ summary: item.summary ?? "", start, allDay: !item.start?.dateTime, own: Boolean(item.creator?.self || item.organizer?.self) }];
  });
}

/** The user's own top-level folders, most recently changed first. */
export async function topFolders(token: string): Promise<string[]> {
  const query = new URLSearchParams({
    q: "mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and 'me' in owners and trashed = false",
    orderBy: "modifiedTime desc",
    pageSize: String(FOLDER_LIMIT),
    fields: "files(name)",
  });
  const { files = [] } = await get(token, `${DRIVE_API}?${query}`, filesSchema);
  return files.map((f) => f.name);
}
