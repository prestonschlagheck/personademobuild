import { describe, expect, it, vi } from "vitest";
import { newSession, type Reminder, type Session, type SessionEvent } from "@/lib/session/schema";
import { LINK_TTL_MS } from "@/lib/agent/tools";
import { afterCall, followUpEvents } from "@/lib/agent/follow-ups";
import {
  ANSWER_HOLD_MS,
  applyCallTimers,
  applyLinkTimer,
  applyReminderTimer,
  applyTimers,
  CALL_BACK_MS,
  endActiveCall,
  type Transition,
  HEARTBEAT_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_OAUTH_MS,
  LINK_REMINDER_MS,
  MAX_CALL_MS,
  nextTimerAt,
  RING_TIMEOUT_MS,
  SCHEDULED_GRACE_MS,
} from "@/lib/server/call-timers";

// Wording belongs to messages.ts and has its own tests. These assert on kinds only, reading each step's
// follow-up as its template, which is what mock mode writes.
vi.mock("@/lib/agent/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/messages")>()),
  missedCallLine: () => ({ text: "missed", kind: "missed_call", quickReplies: ["call me", "text is fine"] }),
  recoveryAfterCall: (_: Session, reason: string) => ({ text: `recovery ${reason}`, kind: reason === "mic_denied" ? "mic_help" : "recovery" }),
}));

const T0 = "2026-09-26T16:00:00.000Z";
const after = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function withCall(call: Partial<Session["call"]>, patch: Partial<Session> = {}): Session {
  const base = newSession("s1", T0);
  return { ...base, ...patch, call: { ...base.call, ...call } };
}

const kinds = (events: { meta?: { kind?: string } }[]) => events.map((e) => e.meta?.kind);
const thread = (t: Transition | null | undefined) => (t ? [...t.events, ...(t.followUp ? followUpEvents(t.followUp) : [])] : []);

describe("ringing", () => {
  const ringing = withCall({ status: "ringing", attempts: 1, ringingAt: T0 });

  it("keeps ringing inside the window", () => {
    expect(applyCallTimers(ringing, null, after(RING_TIMEOUT_MS))).toBeNull();
  });

  it("becomes missed after 30 s with the missed-call text", () => {
    expect(RING_TIMEOUT_MS).toBe(30_000);
    const result = applyCallTimers(ringing, null, after(RING_TIMEOUT_MS + 1));
    expect(result?.session.call.status).toBe("missed");
    expect(kinds(thread(result))).toEqual(["missed_call", "missed_call"]);
    expect(result?.events[0]).toMatchObject({ channel: "system", meta: { callAttempt: 1 } });
    expect(thread(result)[1]).toMatchObject({ channel: "text", role: "agent", meta: { quickReplies: ["call me", "text is fine"] } });
    expect(result?.hangupCallId).toBeUndefined();
  });

  it("holds while the tab answering it pings, so a slow mic prompt never rings out under the user", () => {
    // Answered at 24 s, the ring screen's last second, and still waiting on the mic prompt at 38 s.
    expect(applyCallTimers(ringing, after(24_000), after(RING_TIMEOUT_MS + 1))).toBeNull();
    expect(applyCallTimers(ringing, after(38_000), after(38_000 + HEARTBEAT_TIMEOUT_MS))).toBeNull();
    // The answering tab went away: missed once its pings stop.
    expect(applyCallTimers(ringing, after(24_000), after(24_001 + HEARTBEAT_TIMEOUT_MS))?.session.call.status).toBe("missed");
  });

  it("holds no longer than its cap, and never for a ping from before this ring", () => {
    const cap = RING_TIMEOUT_MS + ANSWER_HOLD_MS;
    expect(applyCallTimers(ringing, after(cap - 1_000), after(cap))).toBeNull();
    expect(applyCallTimers(ringing, after(cap), after(cap + 1))?.session.call.status).toBe("missed");
    expect(applyCallTimers(ringing, "2026-09-26T15:59:59.000Z", after(RING_TIMEOUT_MS + 1))?.session.call.status).toBe("missed");
    expect(applyCallTimers(ringing, T0, after(RING_TIMEOUT_MS + 1))?.session.call.status).toBe("missed");
  });
});

describe("active", () => {
  const active = withCall({ status: "active", attempts: 2, startedAt: T0, activeCallId: "rtc_abc" });

  it("stays active while heartbeats arrive", () => {
    expect(applyCallTimers(active, after(10_000), after(10_000 + HEARTBEAT_TIMEOUT_MS))).toBeNull();
  });

  it("ends with timeout 10 s after the last heartbeat and returns the call to hang up", () => {
    expect(HEARTBEAT_TIMEOUT_MS).toBe(10_000);
    const result = applyCallTimers(active, after(10_000), after(10_001 + HEARTBEAT_TIMEOUT_MS));
    expect(result?.session.call).toMatchObject({ status: "ended", lastEndReason: "timeout" });
    expect(result?.session.call.activeCallId).toBeUndefined();
    expect(result?.hangupCallId).toBe("rtc_abc");
    expect(kinds(thread(result))).toEqual(["call_ended", "recovery"]);
    expect(result?.events[0]).toMatchObject({ content: "timeout", meta: { callSeconds: 10, callAttempt: 2 } });
  });

  it("measures from the start when no heartbeat ever arrived", () => {
    expect(applyCallTimers(active, null, after(HEARTBEAT_TIMEOUT_MS))).toBeNull();
    expect(applyCallTimers(active, null, after(HEARTBEAT_TIMEOUT_MS + 1))?.session.call.status).toBe("ended");
  });

  it("ignores a heartbeat left over from an earlier call", () => {
    expect(applyCallTimers(active, "2026-09-26T15:00:00.000Z", after(5_000))).toBeNull();
  });

  it("allows 90 s once they opened the Gmail link to sign in", () => {
    expect(HEARTBEAT_TIMEOUT_OAUTH_MS).toBe(90_000);
    const signingIn = { ...active, gmail: { status: "link_sent" as const, linkSentAt: T0, openedAt: T0 } };
    expect(applyCallTimers(signingIn, T0, after(HEARTBEAT_TIMEOUT_OAUTH_MS - 1_000))).toBeNull();
    expect(applyCallTimers(signingIn, T0, after(HEARTBEAT_TIMEOUT_OAUTH_MS + 1))?.session.call.lastEndReason).toBe("timeout");
  });

  it("gives a link that was only sent, never opened, no extra time", () => {
    const sent = { ...active, gmail: { status: "link_sent" as const, linkSentAt: T0 } };
    expect(applyCallTimers(sent, T0, after(HEARTBEAT_TIMEOUT_MS + 1))?.session.call.lastEndReason).toBe("timeout");
    // Opened, then connected: the sign-in is over, so the normal limit is back.
    const connected = { ...active, gmail: { status: "connected" as const, openedAt: T0 } };
    expect(applyCallTimers(connected, T0, after(HEARTBEAT_TIMEOUT_MS + 1))?.session.call.lastEndReason).toBe("timeout");
  });

  it("ends a call that outlives the length cap, heartbeats or not, and says so", () => {
    expect(applyCallTimers(active, after(MAX_CALL_MS), after(MAX_CALL_MS))).toBeNull();
    const capped = applyCallTimers(active, after(MAX_CALL_MS), after(MAX_CALL_MS + 1));
    expect(capped?.session.call.lastEndReason).toBe("timeout");
    expect(capped?.followUp?.note).toContain("it hit the length limit for a call");
  });

  it("reads the call's own lines when the tab goes quiet, so a request to be texted is kept", () => {
    const events: SessionEvent[] = [
      { seq: 1, id: "e1", at: T0, channel: "system", role: "system", content: "agent", meta: { kind: "call_started", callAttempt: 2 } },
      { seq: 2, id: "e2", at: T0, channel: "voice", role: "user", content: "i'm heading out, text me when you find it", meta: { kind: "transcript", callAttempt: 2 } },
    ];
    const result = applyCallTimers(active, null, after(HEARTBEAT_TIMEOUT_MS + 1), events);
    expect(result?.followUp?.note).toContain("they asked you to text them");
  });

  it("never hangs up a mock call through OpenAI", () => {
    const mock = withCall({ status: "active", attempts: 1, startedAt: T0, activeCallId: "mock_1" });
    expect(applyCallTimers(mock, null, after(60_000))?.hangupCallId).toBeUndefined();
  });
});

describe("scheduled", () => {
  const scheduled = withCall({ status: "scheduled", attempts: 1, scheduledFor: after(600_000) });

  it("waits until the scheduled time", () => {
    expect(applyCallTimers(scheduled, null, after(599_000))).toBeNull();
  });

  it("rings again as the agent when due, counted as an attempt and keeping the booked time", () => {
    const result = applyCallTimers(scheduled, null, after(600_000));
    expect(result?.session.call).toMatchObject({ status: "ringing", attempts: 2, initiator: "agent", ringingAt: after(600_000) });
    expect(result?.session.call.scheduledFor).toBe(after(600_000));
    expect(kinds(thread(result))).toEqual(["call_ringing"]);
    expect(result?.events[0]).toMatchObject({ channel: "system", meta: { callAttempt: 2 } });
  });

  it("tells the model the booked time when that ring goes unanswered", () => {
    const rung = applyCallTimers({ ...scheduled, timeZone: "America/New_York" }, null, after(600_000));
    const missed = rung && applyCallTimers(rung.session, null, after(600_000 + RING_TIMEOUT_MS + 1));
    expect(missed?.session.call.status).toBe("missed");
    expect(missed?.followUp?.note).toContain("you called them at 12:10 pm, the time they booked, and it rang out");
    expect(missed?.followUp?.facts).toEqual(["12:10 pm"]);
  });

  it("rings up to two minutes late, then offers the call instead of ringing a page that just loaded", () => {
    expect(applyCallTimers(scheduled, null, after(600_000 + SCHEDULED_GRACE_MS))?.session.call.status).toBe("ringing");
    const late = applyCallTimers(scheduled, null, after(600_000 + SCHEDULED_GRACE_MS + 1));
    expect(late?.session.call).toEqual({ status: "offered", attempts: 1 });
    expect(thread(late)).toEqual([]);
  });

  it("does not ring someone who asked to stop", () => {
    expect(applyCallTimers({ ...scheduled, consent: { stoppedAt: T0 } }, null, after(700_000))).toBeNull();
  });
});

it("leaves every other status alone", () => {
  for (const status of ["not_offered", "offered", "ended", "declined", "missed", "failed"] as const) {
    expect(applyCallTimers(withCall({ status }), null, after(3_600_000))).toBeNull();
  }
});

it("uses the mic-help line when the mic was denied", () => {
  const result = endActiveCall(withCall({ status: "active", attempts: 1, startedAt: T0 }), "mic_denied", after(2_000));
  expect(kinds(thread(result))).toEqual(["call_ended", "mic_help"]);
});

it("tells the model which mic problem stopped the call and the fix that goes with it, never a drop", () => {
  const failed = withCall({ status: "failed", attempts: 1 });
  const note = (reason: "mic_denied" | "mic_missing" | "mic_busy") => afterCall(failed, reason, { neverConnected: true });
  expect(note("mic_denied").note).toContain("say their mic looks blocked: they can allow it from the lock icon");
  expect(note("mic_missing").note).toContain("say there's no mic on their device, so you'll keep going over text, and offer no call.");
  expect(note("mic_busy").note).toContain("say their mic's busy with another app: they can close it and you'll call back");
  for (const reason of ["mic_denied", "mic_missing", "mic_busy"] as const) {
    expect(note(reason).mustNotSay).toContain("dropped");
    expect(note(reason).note.includes("lock icon")).toBe(reason === "mic_denied");
  }
  // Said as they happened when a live call's mic went, too.
  const live = withCall({ status: "active", attempts: 1, startedAt: T0 });
  expect(afterCall(live, "mic_missing").note).toContain("their device has no microphone the browser can use");
  expect(afterCall(live, "mic_busy").note).toContain("another app is using their microphone");
});

describe("a callback asked for on the call", () => {
  const active = withCall({ status: "active", attempts: 1, startedAt: T0, activeCallId: "rtc_abc" });
  const end = after(60_000);

  it("books the next ring a few seconds after the agent's hangup, which the scheduled timer then rings", () => {
    const result = endActiveCall(active, "agent_end", end, end, { agentReason: "user_request", callBack: true });
    expect(result.session.call).toMatchObject({ status: "scheduled", scheduledFor: after(60_000 + CALL_BACK_MS), lastEndReason: "agent_end", endedAt: end });
    expect(result.session.call.activeCallId).toBeUndefined();
    expect(result.hangupCallId).toBe("rtc_abc");
    // The text says it is calling right back, instead of the usual recovery line.
    expect(kinds(thread(result))).toEqual(["call_ended", "call_scheduled", "call_scheduled"]);
    expect(result.followUp?.note).toContain("calling right back");
    expect(nextTimerAt(result.session, end, end)).toBe(Date.parse(after(60_000 + CALL_BACK_MS)));
    expect(applyCallTimers(result.session, end, after(60_000 + CALL_BACK_MS - 1))).toBeNull();
    const rung = applyCallTimers(result.session, end, after(60_000 + CALL_BACK_MS));
    expect(rung?.session.call).toMatchObject({ status: "ringing", attempts: 2, initiator: "agent" });
  });

  it("books nothing after they said stop or when the call ended some other way, however many calls there were", () => {
    const callBack = { agentReason: "user_request", callBack: true };
    const stopped = endActiveCall({ ...active, consent: { stoppedAt: T0 } }, "agent_end", end, end, callBack);
    const hungUp = endActiveCall(active, "user_hangup", end, end, callBack);
    for (const result of [stopped, hungUp]) {
      expect(result.session.call.status).toBe("ended");
      expect(kinds(thread(result))).toEqual(["call_ended", "recovery"]);
    }
    const many = endActiveCall({ ...active, call: { ...active.call, attempts: 30 } }, "agent_end", end, end, callBack);
    expect(many.session.call.status).toBe("scheduled");
  });

  it("leaves a plain hangup as it was", () => {
    const result = endActiveCall(active, "agent_end", end, end, { agentReason: "done" });
    expect(result.session.call.status).toBe("ended");
    expect(kinds(thread(result))).toEqual(["call_ended", "recovery"]);
    expect(result.followUp?.note).not.toContain("ring them again");
  });
});

describe("ending with every slot settled", () => {
  const filled = (value: string) => ({ value, source: "voice" as const, setAt: T0 });
  const complete = withCall(
    { status: "active", attempts: 1, startedAt: T0 },
    {
      agentName: filled("Buddy"),
      userName: filled("Sam"),
      helpNeed: { ...filled("my inbox"), category: "inbox" },
      gmail: { status: "connected", email: "sam@example.com" },
    },
  );

  it("graduates and adds the ready row after the recovery text", () => {
    const result = endActiveCall(complete, "user_hangup", after(60_000));
    expect(result.session).toMatchObject({ graduated: true, graduatedAt: after(60_000), graduationReason: "all_slots" });
    expect(kinds(thread(result))).toEqual(["call_ended", "recovery", "graduated"]);
  });

  it("leaves an unfinished or already graduated session alone", () => {
    const partial = { ...complete, gmail: { status: "not_started" as const } };
    expect(endActiveCall(partial, "user_hangup", after(60_000)).session.graduated).toBe(false);
    const graduated = { ...complete, graduated: true, graduationReason: "need_first" as const };
    expect(endActiveCall(graduated, "agent_end", after(60_000)).session.graduationReason).toBe("need_first");
  });
});

describe("gmail link", () => {
  const sent = withCall({ status: "ended", attempts: 1 }, { gmail: { status: "link_sent", linkSentAt: T0 } });

  it("reminds once, a couple of minutes after the link went out", () => {
    expect(applyLinkTimer(sent, after(LINK_REMINDER_MS - 1))).toBeNull();
    const result = applyLinkTimer(sent, after(LINK_REMINDER_MS));
    expect(kinds(thread(result))).toEqual(["link_reminder"]);
    expect(result?.session.gmail).toMatchObject({ status: "link_sent", remindedAt: after(LINK_REMINDER_MS) });
    expect(result && applyLinkTimer(result.session, after(LINK_REMINDER_MS * 2))).toBeNull();
  });

  it("stays quiet over a live call and after stop", () => {
    expect(applyLinkTimer({ ...sent, call: { status: "active", attempts: 1 } }, after(LINK_REMINDER_MS))).toBeNull();
    expect(applyLinkTimer({ ...sent, consent: { stoppedAt: T0 } }, after(LINK_REMINDER_MS))).toBeNull();
  });

  it("expires with its sign-in state", () => {
    const result = applyLinkTimer(sent, after(LINK_TTL_MS));
    expect(result?.session.gmail).toEqual({ status: "not_started" });
    expect(thread(result)).toEqual([]);
  });

  it("counts the recovery text of a dropped call as the reminder", () => {
    const onCall = withCall({ status: "active", attempts: 1, startedAt: T0 }, { gmail: { status: "link_sent", linkSentAt: T0 } });
    const now = after(Math.max(HEARTBEAT_TIMEOUT_OAUTH_MS, LINK_REMINDER_MS) + 1);
    const result = applyTimers(onCall, null, now);
    expect(kinds(thread(result))).toEqual(["call_ended", "recovery"]);
    expect(result?.session.gmail.remindedAt).toBe(now);
  });

  it("holds a due reminder for the next read while another follow-up goes out", () => {
    const ringing = withCall({ status: "ringing", attempts: 1, ringingAt: T0 }, { gmail: { status: "link_sent", linkSentAt: T0 } });
    const now = after(Math.max(RING_TIMEOUT_MS, LINK_REMINDER_MS) + 1);
    const missed = applyTimers(ringing, null, now);
    expect(kinds(thread(missed))).toEqual(["missed_call", "missed_call"]);
    expect(missed?.session.gmail.remindedAt).toBeUndefined();
    expect(kinds(thread(missed && applyTimers(missed.session, null, now)))).toEqual(["link_reminder"]);
  });
});

describe("next timer", () => {
  it("wakes for a ring timeout, and for the heartbeat timeout or length cap of a live call", () => {
    expect(nextTimerAt(withCall({ status: "ringing", ringingAt: T0 }), null, T0)).toBe(Date.parse(T0) + RING_TIMEOUT_MS);
    const live = withCall({ status: "active", startedAt: T0 });
    expect(nextTimerAt(live, after(10_000), after(12_000))).toBe(Date.parse(after(10_000)) + HEARTBEAT_TIMEOUT_MS);
    expect(nextTimerAt(live, after(MAX_CALL_MS - 1_000), after(MAX_CALL_MS - 500))).toBe(Date.parse(T0) + MAX_CALL_MS);
  });

  it("wakes when a held ring or a sign-in's grace runs out, as the timers decide", () => {
    const ringing = withCall({ status: "ringing", ringingAt: T0 });
    expect(nextTimerAt(ringing, after(28_000), after(29_000))).toBe(Date.parse(after(28_000)) + HEARTBEAT_TIMEOUT_MS);
    expect(nextTimerAt(ringing, after(RING_TIMEOUT_MS + ANSWER_HOLD_MS), after(RING_TIMEOUT_MS))).toBe(Date.parse(T0) + RING_TIMEOUT_MS + ANSWER_HOLD_MS);
    const live = withCall({ status: "active", startedAt: T0 });
    const opened = { ...live, gmail: { status: "link_sent" as const, linkSentAt: T0, openedAt: T0, remindedAt: T0 } };
    expect(nextTimerAt(opened, after(10_000), after(12_000))).toBe(Date.parse(after(10_000)) + HEARTBEAT_TIMEOUT_OAUTH_MS);
    const sent = { ...live, gmail: { status: "link_sent" as const, linkSentAt: T0, remindedAt: T0 } };
    expect(nextTimerAt(sent, after(10_000), after(12_000))).toBe(Date.parse(after(10_000)) + HEARTBEAT_TIMEOUT_MS);
  });

  it("never wakes for a timer that cannot fire", () => {
    const booked = withCall({ status: "scheduled", scheduledFor: after(60_000) });
    expect(nextTimerAt(booked, null, T0)).toBe(Date.parse(after(60_000)));
    // A stopped session keeps its booked time, but the callback never rings, so nothing is due.
    expect(nextTimerAt({ ...booked, consent: { ...booked.consent, stoppedAt: T0 } }, null, after(120_000))).toBeNull();
    expect(nextTimerAt(withCall({ status: "ended" }), null, T0)).toBeNull();
  });

  it("wakes for a link's reminder, then only for its expiry", () => {
    const linked = { ...withCall({}), gmail: { status: "link_sent" as const, linkSentAt: T0 } };
    expect(nextTimerAt(linked, null, T0)).toBe(Date.parse(T0) + LINK_REMINDER_MS);
    const reminded = { ...linked, gmail: { ...linked.gmail, remindedAt: after(LINK_REMINDER_MS) } };
    expect(nextTimerAt(reminded, null, after(LINK_REMINDER_MS))).toBe(Date.parse(T0) + LINK_TTL_MS);
  });
});

describe("reminders", () => {
  const reminder = (id: string, ms: number, patch: Partial<Reminder> = {}): Reminder => ({ id, at: after(ms), what: `reminder ${id}`, setAt: T0, ...patch });
  const withReminders = (...reminders: Reminder[]) => ({ ...withCall({ status: "ended", attempts: 1 }), reminders });

  it("texts a reminder once, when its time comes", () => {
    const s = withReminders(reminder("a", 60_000));
    expect(applyReminderTimer(s, after(59_999))).toBeNull();
    const fired = applyTimers(s, null, after(60_000));
    expect(kinds(thread(fired))).toEqual(["reminder"]);
    expect(fired?.session.reminders?.[0]?.sentAt).toBe(after(60_000));
    expect(fired && applyTimers(fired.session, null, after(120_000))).toBeNull();
  });

  it("still texts once when the alarm comes late", () => {
    const fired = applyTimers(withReminders(reminder("a", 60_000)), null, after(3 * 60 * 60_000));
    expect(kinds(thread(fired))).toEqual(["reminder"]);
    expect(fired && applyTimers(fired.session, null, after(3 * 60 * 60_000 + 1_000))).toBeNull();
  });

  it("sends the earliest first when several are due, one per read", () => {
    const s = withReminders(reminder("late", 90_000), reminder("early", 30_000));
    const first = applyTimers(s, null, after(120_000));
    expect(first?.followUp?.fallback[0]?.text).toContain("reminder early");
    const second = first && applyTimers(first.session, null, after(120_000));
    expect(second?.followUp?.fallback[0]?.text).toContain("reminder late");
    expect(second && applyTimers(second.session, null, after(120_000))).toBeNull();
  });

  it("texts over a live call too", () => {
    const onCall: Session = { ...withCall({ status: "active", attempts: 1, startedAt: T0 }), reminders: [reminder("a", 5_000)] };
    expect(kinds(thread(applyTimers(onCall, after(4_000), after(5_000))))).toEqual(["reminder"]);
  });

  it("never sends a cancelled reminder, or any while stopped", () => {
    expect(applyTimers(withReminders(reminder("a", 1_000, { cancelledAt: T0 })), null, after(60_000))).toBeNull();
    const stopped = { ...withReminders(reminder("a", 1_000)), consent: { stoppedAt: T0 } };
    expect(applyTimers(stopped, null, after(60_000))).toBeNull();
    expect(nextTimerAt(stopped, null, T0)).toBeNull();
  });

  it("waits a read while another follow-up goes out, and wakes for it right after", () => {
    const ringing: Session = { ...withCall({ status: "ringing", attempts: 1, ringingAt: T0 }), reminders: [reminder("a", 1_000)] };
    const now = after(RING_TIMEOUT_MS + 1);
    const missed = applyTimers(ringing, null, now);
    expect(kinds(thread(missed))).toEqual(["missed_call", "missed_call"]);
    expect(missed?.session.reminders?.[0]?.sentAt).toBeUndefined();
    expect(missed && nextTimerAt(missed.session, null, now)).toBe(Date.parse(now) + 1);
    expect(kinds(thread(missed && applyTimers(missed.session, null, now)))).toEqual(["reminder"]);
  });

  it("wakes for the earliest one still waiting", () => {
    const s = withReminders(reminder("sent", 10_000, { sentAt: after(10_000) }), reminder("later", 90_000), reminder("sooner", 30_000));
    expect(nextTimerAt(s, null, T0)).toBe(Date.parse(after(30_000)));
    expect(nextTimerAt(withReminders(reminder("gone", 30_000, { cancelledAt: T0 })), null, T0)).toBeNull();
  });
});
