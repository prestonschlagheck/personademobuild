import type { InboxFinding } from "@/lib/gmail/value-fact";
import type { HelpCategory } from "@/lib/session/schema";

// The one-line Calendar and Drive facts delivered alongside the inbox fact, computed in code like it, and the value
// line that joins the inbox fact to one related event or folder and its offer.
// Privacy and safety: anyone can send a calendar invite, so an event is named only when the user created
// it; others are counted. Folder names come only from the user's own top-level folders. Every name is
// cleaned and cut short before it reaches the thread or a model.

export type CalendarEvent = {
  summary: string;
  /** RFC 3339 for a timed event, YYYY-MM-DD for an all-day one. */
  start: string;
  allDay: boolean;
  /** The user created or organizes it, so its title is theirs to hear. */
  own: boolean;
};

/** How far ahead the calendar fact looks, and how many events or folders it reads. */
export const CALENDAR_DAYS = 7;
export const CALENDAR_LIMIT = 20;
export const FOLDER_LIMIT = 20;
const FOLDERS_NAMED = 3;
const NAME_MAX = 32;

/** A title or folder name, safe to quote: no control characters, markup or quotes, one line, short. */
export function cleanName(raw: string): string {
  const flat = raw
    .replace(/[\p{Cc}\p{Cf}\u2013\u2014]/gu, " ")
    .replace(/["'`<>{}[\]\\|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (flat.length <= NAME_MAX) return flat;
  const cut = flat.slice(0, NAME_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > NAME_MAX / 2 ? cut.slice(0, space) : cut).trim()}…`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function when(event: CalendarEvent, now: Date, timeZone: string): string {
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  // An all-day date is already a calendar day; a timed start is placed in the user's zone.
  const date = event.allDay ? new Date(`${event.start}T12:00:00Z`) : new Date(event.start);
  const zone = event.allDay ? "UTC" : timeZone;
  const today = day(now);
  const tomorrow = day(new Date(now.getTime() + 86_400_000));
  const eventDay = event.allDay ? event.start : day(date);
  const label =
    eventDay === today
      ? "today"
      : eventDay === tomorrow
        ? "tomorrow"
        : new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(date).toLowerCase();
  if (event.allDay) return label;
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date).toLowerCase();
  return `${label} at ${time.replace(":00", "")}`;
}

/** Events in the next week, soonest first, as returned by the Calendar API. */
export function calendarFact(events: CalendarEvent[], now: Date, timeZone = "America/New_York"): string {
  const [next] = events;
  if (!next) return `your calendar is clear for the next ${CALENDAR_DAYS} days.`;
  const count = events.length >= CALENDAR_LIMIT ? `${CALENDAR_LIMIT}+ events` : plural(events.length, "event");
  const name = next.own ? cleanName(next.summary) : "";
  const what = name ? `"${name}"` : next.own ? "an untitled event" : "an invite from someone else";
  return `${count} on your calendar this week. next up: ${what}, ${when(next, now, timeZone)}.`;
}

/** The user's own top-level folders, most recently changed first. */
export function driveFact(folders: string[]): string {
  const names = [...new Set(folders.map(cleanName).filter(Boolean))];
  if (names.length === 0) return "your drive has no folders at the top level.";
  const shown = names.slice(0, FOLDERS_NAMED).join(", ");
  const capped = folders.length >= FOLDER_LIMIT;
  const rest = names.length - FOLDERS_NAMED;
  const more = capped ? ", and more" : rest > 0 ? `, plus ${rest} more` : "";
  return `${capped ? `${FOLDER_LIMIT}+ folders` : plural(names.length, "folder")} at the top of your drive: ${shown}${more}.`;
}

export type WorkspaceFacts = { calendarFact?: string; driveFact?: string };

/** The Calendar and Drive facts as one line for a model, or undefined when neither was granted. */
export function workspaceLine(gmail: WorkspaceFacts): string | undefined {
  const parts = [gmail.calendarFact && `calendar: ${gmail.calendarFact}`, gmail.driveFact && `drive: ${gmail.driveFact}`].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

/** The optional Google access granted with Gmail, as said aloud: "calendar and drive", "calendar", "drive" or "". */
export function grantedLine({ scopes = [] }: { scopes?: string[] }): string {
  return (["calendar", "drive"] as const).filter((name) => scopes.some((scope) => scope.includes(name))).join(" and ");
}

// Needs the inbox fact answers on its own. A general one ("my inbox", "gmail", or none saved) hears no counts at connect.
const GENERAL_NEEDS = new Set<HelpCategory | null>([null, "inbox", "calls", "other"]);

/** Whether the inbox fact answers their need, so it is worth sharing as Gmail connects. */
export function factFitsNeed(category: HelpCategory | null): boolean {
  return !GENERAL_NEEDS.has(category);
}

/** The longest value line: the inbox fact, one related event or folder, and the offer. */
export const VALUE_LINE_MAX = 200;

// What ties one of the user's own events or folders to a need. A calendar need takes its next event of any kind.
const RELATED: Partial<Record<HelpCategory, RegExp>> = {
  bills: /\b(?:rent|pay|bills?|due|mortgage|insurance|taxes|utilities|invoices?|receipts?)\b/,
  subscriptions: /\b(?:renew\w*|subscriptions?|memberships?|trial|cancel\w*)\b/,
  travel: /\b(?:flights?|trips?|travel|hotels?|airport|pack(?:ing)?|vacation|trains?|passports?)\b/,
  appointments: /\b(?:appointments?|appts?|dentist|dental|doctor|dr|check-?ups?|therapy|therapist|vet|haircut|clinic|physical)\b/,
  shopping: /\b(?:returns?|orders?|packages?|pick ?up|deliver\w*)\b/,
  calendar: /\S/,
};

export type Workspace = { events?: CalendarEvent[]; folders?: string[] };

function relates(name: string, { category, business }: InboxFinding): boolean {
  if (!name) return false;
  if (business && ` ${name} `.includes(` ${business} `)) return true;
  return Boolean(category && RELATED[category]?.test(name));
}

// Only the user's own events are named, as in the calendar fact, and a folder only when no event relates.
function relatedLine(finding: InboxFinding, { events = [], folders = [] }: Workspace, now: Date, timeZone: string): string {
  const event = events.find((e) => e.own && relates(cleanName(e.summary), finding));
  if (event) return `"${cleanName(event.summary)}" is on your calendar ${when(event, now, timeZone)}.`;
  const folder = finding.category === "calendar" ? undefined : folders.map(cleanName).find((name) => relates(name, finding));
  return folder ? `there's a "${folder}" folder in your drive.` : "";
}

/**
 * The one line sent when Gmail connects: the inbox fact for the need, one of the user's events or folders when it
 * bears on the need, and one offer. Every number in it comes from those facts. The related detail is the first thing
 * to go when the line runs long; the fact and the offer always stay.
 */
export function valueLine(finding: InboxFinding, workspace: Workspace, now: Date, timeZone = "America/New_York"): string {
  const related = relatedLine(finding, workspace, now, timeZone);
  const full = [finding.fact, related, finding.offer].filter(Boolean).join(" ");
  return full.length <= VALUE_LINE_MAX ? full : `${finding.fact} ${finding.offer}`;
}
