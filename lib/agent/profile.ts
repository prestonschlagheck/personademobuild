import type { Session, SessionEvent } from "@/lib/session/schema";

// A small card on how this person likes to talk, read from the thread in code with no model call, so the agent can
// mirror it. It holds labels only, never their words, and leaves out anything the thread can't tell yet.

export type Profile = NonNullable<Session["profile"]>;

// Their texts needed before length, tone, pace or hour says anything about them.
const MIN_TEXTS = 2;
// Median characters per text: up to SHORT_MAX is short, from LONG_MIN on is long.
export const SHORT_MAX = 25;
export const LONG_MIN = 100;
// Median wait from an agent text to their reply: up to QUICK_MS is quick, from SLOW_MS on is slow.
export const QUICK_MS = 30_000;
export const SLOW_MS = 5 * 60_000;

const EMOJI = /\p{Extended_Pictographic}/u;
const SLANG = /\b(?:lol|lmao|haha+|omg|idk|tbh|ngl|btw|pls|plz|thx|ty|u|ur|ya|yea|nah|gonna|wanna|gotta|kinda|sup|bro|dude|kk)\b/i;

const isTheirText = (e: SessionEvent) => e.channel === "text" && e.role === "user" && e.meta?.kind !== "reaction" && e.content.trim() !== "";
const isAgentText = (e: SessionEvent) => e.channel === "text" && e.role === "agent" && e.meta?.kind !== "reaction";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Emoji, slang, or all lowercase with no closing punctuation. */
export function casualText(text: string): boolean {
  const t = text.trim();
  return EMOJI.test(t) || SLANG.test(t) || (/\p{Ll}/u.test(t) && !/\p{Lu}/u.test(t) && !/[.!?]$/.test(t));
}

// The latest thing they did about calls says how they'd rather talk: a call they took, asked for or booked, or one
// they turned down, let ring out, or a "text is fine".
const CALL_SIGNALS: Partial<Record<string, (e: SessionEvent) => Profile["channel"]>> = {
  call_ringing: (e) => (e.content === "Calling" ? "call" : undefined),
  call_started: () => "call",
  call_scheduled: () => "call",
  call_declined: () => "text",
  missed_call: () => "text",
};

function channelOf(s: Session, events: SessionEvent[]): Profile["channel"] {
  // Set when they said they'd rather text, and cleared by the next call they ask for.
  if (s.steering.textOnly) return "text";
  return events.reduce<Profile["channel"]>((found, e) => (e.channel === "system" && CALL_SIGNALS[e.meta?.kind ?? ""]?.(e)) || found, undefined);
}

/** The wait from each agent text to their next text. A call in between says nothing about how fast they text. */
function replyGaps(events: SessionEvent[]): number[] {
  const gaps: number[] = [];
  let sent: number | null = null;
  for (const e of events) {
    if (e.meta?.kind === "call_started") sent = null;
    else if (isAgentText(e)) sent = Date.parse(e.at);
    else if (isTheirText(e) && sent !== null) {
      gaps.push(Date.parse(e.at) - sent);
      sent = null;
    }
  }
  return gaps;
}

function localHour(iso: string, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso));
  return Number(hour.find((p) => p.type === "hour")?.value ?? 0) % 24;
}

/** The hour they text at most, the latest of those that tie. */
function usualHour(texts: SessionEvent[], timeZone: string): number {
  const counts = new Map<number, number>();
  let best = { hour: 0, count: 0 };
  for (const e of texts) {
    const hour = localHour(e.at, timeZone);
    const count = (counts.get(hour) ?? 0) + 1;
    counts.set(hour, count);
    if (count >= best.count) best = { hour, count };
  }
  return best.hour;
}

/** What the session and its thread show about them right now. Pure. */
export function personProfile(s: Session, events: SessionEvent[]): Profile {
  const texts = events.filter(isTheirText);
  const profile: Profile = {};
  const channel = channelOf(s, events);
  if (channel) profile.channel = channel;
  if (s.lang) profile.lang = s.lang;
  if (texts.length >= MIN_TEXTS) {
    const chars = median(texts.map((e) => e.content.trim().length));
    profile.length = chars <= SHORT_MAX ? "short" : chars >= LONG_MIN ? "long" : "medium";
    profile.tone = texts.filter((e) => casualText(e.content)).length * 2 >= texts.length ? "casual" : "plain";
    if (s.timeZone) profile.hour = usualHour(texts, s.timeZone);
  }
  const gaps = replyGaps(events);
  if (gaps.length >= MIN_TEXTS) {
    const wait = median(gaps);
    if (wait <= QUICK_MS) profile.pace = "quick";
    else if (wait >= SLOW_MS) profile.pace = "slow";
  }
  return profile;
}

/**
 * The session with its card brought up to date. What the thread shows now wins; a field it no longer reaches, like a
 * call row older than the window, keeps its saved value.
 */
export function withProfile(s: Session, events: SessionEvent[]): Session {
  const profile = { ...s.profile, ...personProfile(s, events) };
  return Object.keys(profile).length ? { ...s, profile } : s;
}

const hourLabel = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? "am" : "pm"}`;

/**
 * The card as one short line for the agent, or null when nothing is known. English is what the agent assumes, so only
 * another language is named.
 */
export function profileLine(profile: Profile | undefined): string | null {
  if (!profile) return null;
  const style = [profile.length, profile.tone].filter(Boolean).join(" ");
  const parts = [
    profile.channel && (profile.channel === "text" ? "prefers text" : "likes calls"),
    profile.lang === "es" && "writes in spanish",
    style && `${style} texts`,
    profile.pace && (profile.pace === "quick" ? "replies fast" : "replies slowly"),
    profile.hour !== undefined && `usually texts around ${hourLabel(profile.hour)}`,
  ].filter(Boolean);
  return parts.length ? `person: ${parts.join(", ")}` : null;
}
