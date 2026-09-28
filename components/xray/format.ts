import type { CallEndReason, CallStatus, GmailStatus, Session } from "@/lib/session/schema";

// Labels and time formats for the state panel. Records over enums, so a new status fails to compile.

export const CALL_STATUS: Record<CallStatus, string> = {
  not_offered: "Not offered",
  offered: "Offered",
  ringing: "Ringing",
  active: "On a call",
  ended: "Ended",
  declined: "Declined",
  missed: "Missed",
  failed: "Failed",
  scheduled: "Callback scheduled",
};

export const END_REASON: Record<CallEndReason, string> = {
  user_hangup: "User hung up",
  agent_end: "Agent wrapped up",
  network: "Network dropped",
  mic_denied: "Mic denied",
  mic_missing: "No mic",
  mic_busy: "Mic busy",
  tab_closed: "Tab closed",
  timeout: "Went silent",
  error: "Error",
};

export const GMAIL_STATUS: Record<GmailStatus, string> = {
  not_started: "Not started",
  link_sent: "Link sent",
  connected: "Connected",
  denied: "Denied",
  error: "Error",
  skipped: "Skipped",
  disconnected: "Disconnected",
};

/** A name as a name: "mary-jane o'neil" reads "Mary-Jane O'Neil". */
export const capitalized = (name: string) => name.replace(/(^|[\s'-])(\p{Ll})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());

// The need's opening, when a need saved before labels existed has none: "focus on google stuff, mainly gmail" is
// "Google stuff".
const LEAD = /^(?:(?:please|just|mainly)\s+)?(?:focus(?:ing)? on|help(?:ing)?(?: me)? with|i (?:want|need)(?: help with)?|handl(?:e|ing)|manag(?:e|ing))\s+/i;

/** The help need in a few words, sentence case. */
export function needLabel(need: NonNullable<Session["helpNeed"]>) {
  const short = need.label ?? (need.value.split(/[,.;:!?]|\s[-–]\s/)[0] ?? "").trim().replace(LEAD, "");
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** Milliseconds as seconds to a tenth: 1286 is "1.3 s". */
export const seconds = (ms: number) => `${(ms / 1_000).toFixed(1)} s`;
