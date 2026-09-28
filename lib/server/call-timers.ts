import { graduatedRow, systemEvent, type CallEndDetail } from "@/lib/agent/messages";
import { afterCall, callEndDetail, callingBack, linkReminder, missedCall, reminderDue, type FollowUp } from "@/lib/agent/follow-ups";
import { canGraduate, isCallLive } from "@/lib/agent/policy";
import { withProfile } from "@/lib/agent/profile";
import { LINK_TTL_MS, pendingReminders, ringCall } from "@/lib/agent/tools";
import type { CallEndReason, NewEvent, Reminder, Session, SessionEvent } from "@/lib/session/schema";
import { signingIn } from "@/lib/voice/notes";

// Pure lazy timers. They run on every session read, so ring timeouts, dead calls, scheduled callbacks,
// stale Gmail links and reminders resolve without a cron, and the call routes reuse the same steps. What the agent
// texts about a step is its follow-up, written by whoever wins the write (lib/server/follow-up.ts).

export const RING_TIMEOUT_MS = 30_000;
// The ring screen gives up at 25 s from when a tab first saw it, but an answer tapped then still waits on the mic prompt
// and the offer. The answering tab pings the ring meanwhile, so a slow Allow never has it ring out under them; capped,
// so a prompt left open still ends as a missed call.
export const ANSWER_HOLD_MS = 60_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
// The call tab goes quiet in the background once the user opens the Google link to sign in; a phone may pause it
// entirely. Only then, and only this long: a link merely sent never stretches a dead call.
export const HEARTBEAT_TIMEOUT_OAUTH_MS = 90_000;
// A heartbeating client could otherwise hold a paid Realtime call open indefinitely.
export const MAX_CALL_MS = 10 * 60_000;
export const LINK_REMINDER_MS = 2 * 60_000;
// A callback they asked for on the call rings this long after it ends, once the "Call Ended" screen has cleared.
export const CALL_BACK_MS = 5_000;
// An open page polls every second, so a callback read later than this means nobody was there to answer.
export const SCHEDULED_GRACE_MS = 2 * 60_000;

export type Transition = { session: Session; events: NewEvent[]; followUp?: FollowUp };
type Timed = Transition & { hangupCallId?: string };

export const isLiveCallId = (id: string | undefined): id is string => id?.startsWith("rtc_") ?? false;

export function callSeconds(startedAt: string | undefined, endAt: string) {
  return startedAt ? Math.max(0, Math.round((Date.parse(endAt) - Date.parse(startedAt)) / 1000)) : 0;
}

const heartbeatLimit = (s: Session) => (signingIn(s) ? HEARTBEAT_TIMEOUT_OAUTH_MS : HEARTBEAT_TIMEOUT_MS);

/** When a ring runs out: its timeout, pushed back while a tab answering it keeps pinging, up to the hold's cap. */
function ringEndsAt(ringingAt: string, lastSeen: string | null): number {
  const rang = Date.parse(ringingAt);
  const due = rang + RING_TIMEOUT_MS;
  const seen = Date.parse(lastSeen ?? "") || 0;
  // The heartbeat column outlives calls, so only a ping since this ring started means someone is answering it.
  if (seen <= rang) return due;
  return Math.min(Math.max(due, seen + HEARTBEAT_TIMEOUT_MS), due + ANSWER_HOLD_MS);
}

export function missCall(session: Session): Transition {
  const next: Session = { ...session, call: { ...session.call, status: "missed" } };
  return {
    session: next,
    events: [systemEvent("missed_call", "missed", { callAttempt: next.call.attempts })],
    followUp: missedCall(next),
  };
}

/**
 * Ends the current call and writes the recovery text. `endAt` is when the call was last alive, and `detail`
 * is what the call's own events say about how it ended. When every slot is settled the session graduates
 * here too, so a hangup never depends on the agent having called `graduate` before the line dropped.
 */
export function endActiveCall(session: Session, reason: CallEndReason, now: string, endAt = now, detail: CallEndDetail = {}): Timed {
  const { activeCallId, ...call } = session.call;
  let next: Session = { ...session, call: { ...call, status: "ended", lastEndReason: reason, endedAt: now } };
  // The recovery text points at an open link, so it counts as that link's reminder.
  if (next.gmail.status === "link_sent" && !next.gmail.remindedAt) next = { ...next, gmail: { ...next.gmail, remindedAt: now } };
  const graduates = !next.graduated && canGraduate(next, "all_slots").ok;
  if (graduates) next = { ...next, graduated: true, graduatedAt: now, graduationReason: "all_slots" };
  const ended = systemEvent("call_ended", reason, { callAttempt: call.attempts, callSeconds: callSeconds(call.startedAt, endAt) });
  const after = graduates ? { after: [systemEvent("graduated", graduatedRow(next))] } : {};
  const hangupCallId = isLiveCallId(activeCallId) ? activeCallId : undefined;
  // "hang up and call me again": the agent's own hangup books the next ring through the scheduled path, which holds
  // back for a stop.
  if (detail.callBack && reason === "agent_end" && !next.consent.stoppedAt) {
    const scheduledFor = new Date(Date.parse(now) + CALL_BACK_MS).toISOString();
    next = { ...next, call: { ...next.call, status: "scheduled", scheduledFor } };
    return {
      session: next,
      events: [ended, systemEvent("call_scheduled", scheduledFor, { callAttempt: call.attempts })],
      followUp: { ...callingBack(), ...after },
      hangupCallId,
    };
  }
  return { session: next, events: [ended], followUp: { ...afterCall(next, reason, detail), ...after }, hangupCallId };
}

// A booked callback keeps its time on the ring, so a missed one can say "called at 12:40 like you asked".
function ringBooked(session: Session, scheduledFor: string, now: string): Transition {
  const rung = ringCall(session, "agent", now);
  return { ...rung, session: { ...rung.session, call: { ...rung.session.call, scheduledFor } } };
}

/** `events` are the thread's recent rows, read only when a live call is due to end, so its text knows how. */
export function applyCallTimers(session: Session, lastSeen: string | null, now: string, events: SessionEvent[] = []): Timed | null {
  const { call } = session;
  const t = Date.parse(now);

  switch (call.status) {
    case "ringing":
      return !call.ringingAt || t > ringEndsAt(call.ringingAt, lastSeen) ? missCall(session) : null;
    case "active": {
      const detail = callEndDetail(events, call.attempts);
      const started = Date.parse(call.startedAt ?? "") || 0;
      if (started && t - started > MAX_CALL_MS) return endActiveCall(withProfile(session, events), "timeout", now, now, { ...detail, lengthCap: true });
      // The heartbeat column outlives calls, so a ping from an earlier call never counts.
      const alive = Math.max(Date.parse(lastSeen ?? "") || 0, started);
      if (t - alive <= heartbeatLimit(session)) return null;
      // The person card is saved as the call ends, with the call they took in it.
      return endActiveCall(withProfile(session, events), "timeout", now, alive ? new Date(alive).toISOString() : now, detail);
    }
    case "scheduled": {
      const due = Date.parse(call.scheduledFor ?? "");
      if (!due || !call.scheduledFor || due > t || session.consent.stoppedAt) return null;
      if (t - due <= SCHEDULED_GRACE_MS) return ringBooked(session, call.scheduledFor, now);
      // Too late to ring into a page that just loaded, silent and without a gesture. The call goes back to
      // being on offer, and the welcome back line offers it again.
      const offered: Session["call"] = { ...call, status: "offered" };
      delete offered.scheduledFor;
      return { session: { ...session, call: offered }, events: [] };
    }
    case "not_offered":
    case "offered":
    case "ended":
    case "declined":
    case "missed":
    case "failed":
      return null;
    default: {
      const unknown: never = call.status;
      return unknown;
    }
  }
}

/**
 * An open Gmail link gets one quiet reminder after a couple of minutes, never over a live call, and
 * expires with its OAuth state, so polling calms down and the agent offers a fresh link instead.
 */
export function applyLinkTimer(session: Session, now: string): Transition | null {
  const { gmail } = session;
  if (gmail.status !== "link_sent" || !gmail.linkSentAt) return null;
  const age = Date.parse(now) - Date.parse(gmail.linkSentAt);
  if (age >= LINK_TTL_MS) return { session: { ...session, gmail: { status: "not_started" } }, events: [] };
  const busy = isCallLive(session) || session.consent.stoppedAt;
  if (age < LINK_REMINDER_MS || gmail.remindedAt || busy) return null;
  return { session: { ...session, gmail: { ...gmail, remindedAt: now } }, events: [], followUp: linkReminder() };
}

/** The earliest reminder waiting to go out, or none while they have said stop. */
function nextReminder(session: Session): Reminder | undefined {
  if (session.consent.stoppedAt) return undefined;
  return pendingReminders(session).reduce<Reminder | undefined>((first, r) => (!first || Date.parse(r.at) < Date.parse(first.at) ? r : first), undefined);
}

/**
 * A reminder they asked for is texted once its time comes, earliest first, even over a live call: it is marked sent in
 * the same save, so a late or repeated read never sends it twice. Several due at once go out one read apart.
 */
export function applyReminderTimer(session: Session, now: string): Transition | null {
  const due = nextReminder(session);
  if (!due || Date.parse(due.at) > Date.parse(now)) return null;
  const sent = { ...due, sentAt: now };
  const next: Session = { ...session, reminders: (session.reminders ?? []).map((r) => (r.id === due.id ? sent : r)) };
  return { session: next, events: [], followUp: reminderDue(next, sent) };
}

/**
 * When the next lazy timer falls due, or null when none is pending. Mirrors applyCallTimers, applyLinkTimer and
 * applyReminderTimer, guards
 * included, so a session's Durable Object wakes exactly when a read would change something and never for a timer
 * that cannot fire (a booked callback on a stopped session, a link reminder held back by a live call).
 */
export function nextTimerAt(session: Session, lastSeen: string | null, now: string): number | null {
  const { call, gmail } = session;
  const t = Date.parse(now);
  const due: number[] = [];
  if (call.status === "ringing" && call.ringingAt) due.push(ringEndsAt(call.ringingAt, lastSeen));
  if (call.status === "active") {
    const started = Date.parse(call.startedAt ?? "") || 0;
    const alive = Math.max(Date.parse(lastSeen ?? "") || 0, started);
    if (started) due.push(started + MAX_CALL_MS);
    due.push((alive || t) + heartbeatLimit(session));
  }
  if (call.status === "scheduled" && call.scheduledFor && !session.consent.stoppedAt) due.push(Date.parse(call.scheduledFor));
  if (gmail.status === "link_sent" && gmail.linkSentAt) {
    const sent = Date.parse(gmail.linkSentAt);
    due.push(sent + LINK_TTL_MS);
    if (!gmail.remindedAt && !isCallLive(session) && !session.consent.stoppedAt) due.push(sent + LINK_REMINDER_MS);
  }
  // A reminder already due that another follow-up held back goes out on the very next read.
  const reminder = nextReminder(session);
  if (reminder) due.push(Math.max(Date.parse(reminder.at), t + 1));
  const next = due.filter((at) => Number.isFinite(at) && at > t);
  return next.length ? Math.min(...next) : null;
}

/** Every lazy timer in order, or null when nothing is due. One follow-up at a time: a later one waits for the next read. */
export function applyTimers(session: Session, lastSeen: string | null, now: string, events: SessionEvent[] = []): Timed | null {
  let done = applyCallTimers(session, lastSeen, now, events);
  for (const step of [applyLinkTimer, applyReminderTimer]) {
    const next = step(done?.session ?? session, now);
    if (!next || (done?.followUp && next.followUp)) continue;
    done = { ...done, session: next.session, events: [...(done?.events ?? []), ...next.events], followUp: done?.followUp ?? next.followUp };
  }
  return done;
}
