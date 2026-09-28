import { describe, expect, it } from "vitest";
import { newSession, type Session, type SessionEvent } from "@/lib/session/schema";
import { CUT_OFF, connectedAsLine, connectedOfferLine, reconnectedLine, valueMomentLine } from "@/lib/agent/messages";
import { afterCall, callEndDetail, callingBack, declinedCall, gmailConnected, locationDenied, locationShared, missedCall, reminderDue } from "@/lib/agent/follow-ups";

const NOW = "2026-09-27T16:00:00.000Z";
let seq = 0;

function row(channel: SessionEvent["channel"], role: SessionEvent["role"], content: string, meta: SessionEvent["meta"]): SessionEvent {
  seq += 1;
  return { seq, id: `e${seq}`, at: NOW, channel, role, content, meta };
}
const started = (attempt: number) => row("system", "system", "agent", { kind: "call_started", callAttempt: attempt });
const line = (role: "user" | "agent", content: string, attempt = 1) => row("voice", role, content, { kind: "transcript", callAttempt: attempt });
const endCallTool = (reason: string) =>
  row("system", "tool", "end_call", { kind: "tool_call", tool: { name: "end_call", args: { reason }, ok: true } });

describe("callEndDetail", () => {
  it("knows a line the hangup cut off, or one that trailed off with no answer", () => {
    expect(callEndDetail([started(1), line("user", `so many things, like... ${CUT_OFF}`)], 1)).toEqual({ userCutOff: true });
    expect(callEndDetail([started(1), line("user", "there are so many things i need help with, like...")], 1)).toEqual({ userCutOff: true, cutOffListing: true });
    expect(callEndDetail([started(1), line("user", "so, like..."), line("agent", "take your time.")], 1)).toEqual({ lastAgentAt: NOW });
    expect(callEndDetail([started(1), line("agent", `what could i take off your... ${CUT_OFF}`)], 1)).toEqual({ agentCutOff: true, lastAgentAt: NOW });
  });

  it("hears a request to be texted near the end of the call, and nothing else", () => {
    const asked = (text: string) => callEndDetail([started(1), line("user", text)], 1).askedToText ?? false;
    expect(asked("I'm going to hang up, text me when you find it.")).toBe(true);
    expect(asked("just send me a text with the rest")).toBe(true);
    expect(asked("mándame un mensaje")).toBe(true);
    expect(asked("please don't text me")).toBe(false);
    expect(asked("can you text me the link?")).toBe(false);
    expect(asked("my name is preston")).toBe(false);
    expect(asked("can you send me a recap of this call?")).toBe(true);
    const early = [started(1), line("user", "text me later"), ...["ok", "sounds good", "yep", "cool"].map((text) => line("user", text))];
    expect(callEndDetail(early, 1).askedToText).toBeUndefined();
    // The agent's own promise on the call counts too, unless it was only about the link.
    const promised = (text: string) => callEndDetail([started(1), line("agent", text)], 1).askedToText ?? false;
    expect(promised("sure, i'll send you a text after with everything.")).toBe(true);
    expect(promised("i'll send you a recap once we hang up.")).toBe(true);
    expect(promised("i'll text you the google link now.")).toBe(false);
  });

  it("leaves out a request send_text already answered on the call, but hears one made after it", () => {
    const sendText = () => row("system", "tool", "send_text", { kind: "tool_call", tool: { name: "send_text", args: { text: "the title" }, ok: true } });
    const bubble = () => row("text", "agent", "the title", { kind: "chat" });
    // Their words can land after the tool call they led to, and the line said with it promises the text.
    const answered = [started(1), sendText(), bubble(), line("user", "text it to me now"), line("agent", "sure, i'll text you that now."), line("user", "thanks, bye")];
    expect(callEndDetail(answered, 1).askedToText).toBeUndefined();
    // Sent as the call ended, with nothing said after it.
    expect(callEndDetail([started(1), line("user", "text me the title"), sendText(), bubble()], 1).askedToText).toBeUndefined();
    expect(callEndDetail([...answered, line("user", "and text me what you find later")], 1).askedToText).toBe(true);
    const refused = row("system", "tool", "send_text", { kind: "tool_call", tool: { name: "send_text", args: {}, ok: false, error: "has_link" } });
    expect(callEndDetail([started(1), line("user", "text it to me"), refused, line("agent", "one sec, sending it without the link.")], 1).askedToText).toBe(true);
  });

  it("keeps the agent's latest texts, which the text after the call never repeats", () => {
    const texted = row("text", "agent", "good talking. text me whenever you need something.", { kind: "continue_text" });
    expect(callEndDetail([texted, started(2), line("user", "hi", 2)], 2)).toEqual({ sent: ["good talking. text me whenever you need something."] });
  });

  it("reads the agent's end_call reason for this call only", () => {
    expect(callEndDetail([started(1), endCallTool("abuse"), started(2), line("user", "hi", 2)], 2)).toEqual({});
    expect(callEndDetail([started(1), line("agent", "still there?"), endCallTool("silence")], 1)).toEqual({ agentReason: "silence", lastAgentAt: NOW });
  });

  it("reads a callback asked for with the agent's end_call, and only when it was", () => {
    const callBack = row("system", "tool", "end_call", { kind: "tool_call", tool: { name: "end_call", args: { reason: "user_request", call_back: true }, ok: true } });
    expect(callEndDetail([started(1), callBack], 1)).toEqual({ agentReason: "user_request", callBack: true });
    const refused = row("system", "tool", "end_call", { kind: "tool_call", tool: { name: "end_call", args: { reason: "user_request", call_back: true }, ok: false } });
    expect(callEndDetail([started(1), refused], 1)).toEqual({});
    expect(callEndDetail([started(1), endCallTool("user_request")], 1).callBack).toBeUndefined();
  });

  it("flags a question nothing on the call answered, but not a check-in or one the agent spoke to", () => {
    const asked = line("user", "Can you not go outside of my inbox?");
    const call = [started(1), asked, line("user", "Hello?"), line("agent", "hey, i'm here. what's up?"), line("user", "Hang up now.")];
    expect(callEndDetail(call, 1).unanswered).toBe(true);
    expect(callEndDetail([started(1), asked, line("agent", "i can search all of your mail."), line("user", "ok")], 1).unanswered).toBeUndefined();
    expect(callEndDetail([started(1), line("user", "Hello?"), line("user", "hey, are you still there?"), line("user", "Hello? Can you hear me?")], 1).unanswered).toBeUndefined();
    // A check-in in Spanish, or one the hangup cut off, is still only a check-in.
    expect(callEndDetail([started(1), line("user", "¿Hola? ¿Me escuchas?"), line("user", "¿Estás ahí?")], 1).unanswered).toBeUndefined();
    expect(callEndDetail([started(1), line("user", `hello? ${CUT_OFF}`)], 1).unanswered).toBeUndefined();
    // Asked right as the call ended, with nothing said after it.
    expect(callEndDetail([started(1), line("agent", "anything else?"), line("user", "can you check my drive too?")], 1).unanswered).toBe(true);
  });

  it("says it is calling right back, and never that the call dropped or rang out", () => {
    const next = callingBack();
    expect(next.fallback).toEqual([{ text: "calling you right back.", kind: "call_scheduled" }]);
    expect(next.note).toContain("ask for nothing");
    expect(next.mustNotSay).toEqual(expect.arrayContaining(["dropped", "rang out"]));
  });
});

describe("after-call notes", () => {
  const fact = "you've got 12 unread from the last 3 days. want me to sort them later?";
  const connected: Session = {
    ...newSession("s1", NOW),
    agentName: { value: "Max", source: "text", setAt: NOW },
    gmail: { status: "connected", email: "p7@gmail.com", valueFact: fact },
    call: { status: "ended", attempts: 1 },
  };

  // Gmail connected a minute into the call, and the call ended before the agent said anything about it.
  const LATER = "2026-09-27T16:01:00.000Z";
  const connectedOnCall: Session = {
    ...connected,
    userName: { value: "Preston", source: "voice", setAt: NOW },
    gmail: { ...connected.gmail, connectedAt: LATER },
    call: { status: "ended", attempts: 1, startedAt: NOW },
  };

  it("hands the value fact over word for word when they asked to be texted and never heard it", () => {
    const followUp = afterCall(connectedOnCall, "user_hangup", { askedToText: true, lastAgentAt: NOW });
    expect(followUp.note).toContain(`value_fact: "${fact}"`);
    expect(followUp.fallback.map((l) => l.text)).toEqual([`here's what i found: ${fact}`]);
    expect(followUp.facts).toEqual([fact, "p7@gmail.com"]);
  });

  it("sends a recap, not the fact again, once the call already said it", () => {
    const heard = afterCall(connectedOnCall, "user_hangup", { askedToText: true, lastAgentAt: "2026-09-27T16:01:05.000Z" });
    expect(heard.note).toContain("they already heard what you found on the call, so don't send it again");
    expect(heard.note).not.toContain("value_fact");
    expect(heard.fallback.map((l) => l.text)).toEqual(["you're all set, Preston. i'm Max and your gmail's connected. what should i start on first?"]);
  });

  it("texts the fact after a call that ended as gmail connected, before the agent could say it, for a need it answers", () => {
    const bills: Session = { ...connectedOnCall, helpNeed: { value: "stay on top of my bills", category: "bills", source: "voice", setAt: NOW } };
    const followUp = afterCall(bills, "user_hangup", { lastAgentAt: NOW });
    expect(followUp.note).toContain(`they never heard what you found, so share it in its own bubble: value_fact: "${fact}"`);
    expect(followUp.fallback.map((l) => l.kind)).toEqual(["recap", "value_moment"]);
  });

  it("keeps the unheard fact back after a call for a general need, or none saved", () => {
    for (const s of [connectedOnCall, { ...connectedOnCall, helpNeed: { value: "gmail", category: "inbox" as const, source: "voice" as const, setAt: NOW } }]) {
      const followUp = afterCall(s, "user_hangup", { lastAgentAt: NOW });
      expect(followUp.note).not.toContain("value_fact");
      expect(followUp.note).not.toContain(fact);
      expect(followUp.fallback.map((l) => l.kind)).toEqual(["recap"]);
    }
  });

  it("allows no number from their calendar or drive in a text after a call", () => {
    const shared: Session = { ...connected, gmail: { ...connected.gmail, calendarFact: "4 events on your calendar this week.", driveFact: "5 folders at the top of your drive." } };
    expect(afterCall(shared, "user_hangup").facts).toEqual([fact, "p7@gmail.com"]);
  });

  it("only lets a line that went on its own be told as dropped", () => {
    expect(afterCall(connected, "user_hangup").mustNotSay).toContain("disconnect");
    expect(afterCall(connected, "agent_end", { agentReason: "silence" }).mustNotSay).toContain("dropped");
    expect(afterCall(connected, "network", { neverConnected: true }).mustNotSay).toContain("cut off");
    expect(afterCall(connected, "network").mustNotSay).toBeUndefined();
    expect(missedCall({ ...connected, call: { status: "missed", attempts: 1 } }).mustNotSay).toContain("voicemail");
  });

  it("states what happened before anything else, and allows no invented numbers", () => {
    const followUp = afterCall(newSession("s2", NOW), "network");
    expect(followUp.note).toMatch(/^the call just ended: the connection dropped\. text them now: first say what happened/);
    expect(followUp.facts).toEqual([]);
    expect(afterCall(newSession("s2", NOW), "user_hangup", { userCutOff: true }).note).toContain("in the middle of a sentence");
  });

  it("says a missed or declined ring as exactly that", () => {
    expect(missedCall({ ...connected, call: { status: "missed", attempts: 1 } }).note).toMatch(/^you called them and it rang out/);
    expect(declinedCall({ ...connected, call: { status: "declined", attempts: 1 } }).note).toMatch(/^they declined your call/);
  });
});

describe("the text that ends setup", () => {
  const CALL_AT = "2026-09-27T16:00:00.000Z";
  const END_AT = "2026-09-27T16:04:00.000Z";
  const fact = "you've got 3 bills due this week. want me to list them?";
  const settled: Session = {
    ...newSession("s4", NOW),
    agentName: { value: "Max", source: "text", setAt: NOW },
    userName: { value: "Preston", source: "voice", setAt: NOW },
    helpNeed: { value: "stay on top of my bills", category: "bills", source: "voice", setAt: NOW },
    gmail: { status: "connected", email: "p7@gmail.com", valueFact: fact, connectedAt: CALL_AT },
    call: { status: "ended", attempts: 1, startedAt: CALL_AT },
    graduated: true,
    graduatedAt: END_AT,
    graduationReason: "all_slots",
  };
  const heard = { lastAgentAt: "2026-09-27T16:02:00.000Z" };

  it("after a call that finished setup, starts on their need with one question, never a passive sign-off", () => {
    const followUp = afterCall(settled, "user_hangup", heard);
    expect(followUp.note).toContain('setup is done, so start on "stay on top of my bills"');
    expect(followUp.note).toContain("end on one question");
    expect(followUp.note).not.toContain("text anytime");
    expect(followUp.mustAsk).toBe(true);
    expect(followUp.mustNotSay).toEqual(expect.arrayContaining(["text me anytime", "disconnect"]));
    expect(followUp.fallback.at(-1)?.text).toMatch(/\?$/);
  });

  it("asks what to start on when no need was saved", () => {
    const followUp = afterCall({ ...settled, helpNeed: null, steering: { ...settled.steering, skipped: ["helpNeed"] } }, "agent_end", heard);
    expect(followUp.note).toContain("ask what they'd like you to start on first");
    expect(followUp.fallback[0]?.text).toMatch(/what should i start on first\?$/);
  });

  it("lets the value fact's offer be the one question when the call never said it", () => {
    const followUp = afterCall({ ...settled, gmail: { ...settled.gmail, connectedAt: "2026-09-27T16:03:00.000Z" } }, "user_hangup", heard);
    expect(followUp.note).toContain("the value fact's offer is that step and your one question");
    expect(followUp.fallback.map((l) => l.kind)).toEqual(["recap", "value_moment"]);
    expect(followUp.fallback[0]?.text).not.toContain("?");
  });

  it("answers a question the call left open first, and starts on it rather than the need as saved", () => {
    const followUp = afterCall(settled, "user_hangup", { ...heard, unanswered: true });
    expect(followUp.note).toContain("a question they asked on the call never got an answer");
    expect(followUp.note).toContain("answer it plainly from what you and your tools can do");
    expect(followUp.note).toContain("start on that open question, not on the need as saved");
    expect(followUp.note).not.toContain('start on "stay on top of my bills"');
    expect(followUp.mustAsk).toBe(true);
    // An unheard fact still goes, but without its own offer, since the question's offer is the one ask.
    const unheard = afterCall({ ...settled, gmail: { ...settled.gmail, connectedAt: "2026-09-27T16:03:00.000Z" } }, "user_hangup", { ...heard, unanswered: true });
    expect(unheard.note).toContain('value_fact: "you\'ve got 3 bills due this week."');
    // Nothing to answer, or a call ended over abuse: no such line.
    expect(afterCall(settled, "user_hangup", heard).note).not.toContain("never got an answer");
    expect(afterCall(settled, "agent_end", { ...heard, unanswered: true, agentReason: "abuse" }).note).not.toContain("never got an answer");
  });

  it("never tells a text that answers an open question to ask nothing, or to ask for setup as a second question", () => {
    const before = afterCall({ ...settled, graduatedAt: "2026-09-27T15:00:00.000Z" }, "user_hangup", { ...heard, unanswered: true });
    expect(before.note).toContain("never got an answer");
    expect(before.note).toContain("that answer and its offer are the whole text");
    expect(before.note).not.toContain("ask nothing");
    const open: Session = { ...settled, graduated: false, gmail: { status: "not_started" }, call: { status: "ended", attempts: 1, startedAt: CALL_AT } };
    delete open.graduatedAt;
    const setup = afterCall(open, "user_hangup", { ...heard, unanswered: true });
    expect(setup.note).toContain("make that the offer; otherwise setup waits for a later turn");
    expect(setup.note).not.toMatch(/\. next, ask for/);
    // With no question left open, the next ask stands on its own.
    expect(afterCall(open, "user_hangup", heard).note).toMatch(/\. next, ask for connecting gmail/);
  });

  it("starts on the need in the text they asked for, once they heard the fact", () => {
    const followUp = afterCall(settled, "user_hangup", { ...heard, askedToText: true });
    expect(followUp.note).toContain("don't send it again: setup is done");
    expect(followUp.mustAsk).toBe(true);
  });

  it("only signs off after a call that came once setup was already done, and holds no other text to it", () => {
    const before = { ...settled, graduatedAt: "2026-09-27T15:00:00.000Z" };
    expect(afterCall(before, "user_hangup", heard).note).toContain("sign off warmly in one line. ask nothing");
    expect(afterCall(before, "user_hangup", heard).mustAsk).toBeUndefined();
    const open: Session = { ...settled, graduated: false, gmail: { status: "not_started" }, call: { status: "ended", attempts: 1, startedAt: CALL_AT } };
    expect(afterCall(open, "user_hangup").mustAsk).toBeUndefined();
    expect(afterCall(settled, "mic_denied").mustAsk).toBeUndefined();
  });

  it("after a call that followed graduation, points lightly to what is still open and never reuses its last text", () => {
    const linkOut: Session = { ...settled, graduatedAt: "2026-09-27T15:00:00.000Z", gmail: { status: "link_sent" } };
    const first = afterCall(linkOut, "user_hangup");
    expect(first.note).toContain("with one light pointer that the gmail link is in the thread whenever they want it");
    expect(first.note).toContain("never reuse the words of a text you already sent");
    expect(first.fallback).toEqual([{ text: "good talking. the gmail link's in the thread whenever you want it.", kind: "continue_text" }]);
    const again = afterCall(linkOut, "user_hangup", { sent: [first.fallback[0]?.text ?? ""] });
    expect(again.fallback[0]?.text).toBe("good talking. that gmail link's still up there if you want it.");
    // Nothing open: a plain sign-off, still never the same words twice in a row.
    const all = { ...settled, graduatedAt: "2026-09-27T15:00:00.000Z" };
    expect(afterCall(all, "user_hangup").note).not.toContain("pointer");
    expect(afterCall(all, "user_hangup", { sent: ["good talking. text me whenever you need something."] }).fallback[0]?.text).toBe(
      "good talking. i'm a text away if anything comes up.",
    );
  });

  it("after a gmail connect that settles the last slot, starts on the need through the fact's offer", () => {
    const waiting: Session = { ...settled, graduated: false, gmail: { status: "link_sent" }, call: { status: "not_offered", attempts: 0 } };
    delete waiting.graduatedAt;
    const ends = gmailConnected("p7@gmail.com", fact, false, {}, false, waiting);
    expect(ends.note).toContain("that settles setup, so this reply starts on their need");
    expect(ends.mustAsk).toBe(true);
    expect(ends.mustNotSay).toEqual(expect.arrayContaining(["text me anytime"]));
    const unread = gmailConnected("p7@gmail.com", null, false, {}, false, waiting);
    expect(unread.note).toContain('setup is done, so start on "stay on top of my bills"');
    expect(unread.mustAsk).toBe(true);
    // Not the last slot, or on a call, where the hangup ends setup: no such hold.
    expect(gmailConnected("p7@gmail.com", fact, false, {}, false, { ...waiting, userName: null }).mustAsk).toBeUndefined();
    expect(gmailConnected("p7@gmail.com", fact, true, {}, false, waiting).mustAsk).toBeUndefined();
  });
});

describe("the text at gmail connect", () => {
  const EMAIL = "p7@gmail.com";
  const INBOX_FACT = "you've got 11 unread, and only 1 of your newest 12 looks like a real person. want me to flag mail from real people as it comes in?";
  const BILLS_FACT = "i see bills from 2 companies in the last 6 weeks: northwind energy and harbor mobile. want a heads-up?";
  const need = (value: string, category: "inbox" | "bills") => ({ value, category, source: "voice" as const, setAt: NOW });
  const waiting: Session = {
    ...newSession("s6", NOW),
    agentName: { value: "Max", source: "text", setAt: NOW },
    userName: { value: "Preston", source: "voice", setAt: NOW },
    helpNeed: need("gmail", "inbox"),
    gmail: { status: "link_sent" },
    call: { status: "not_offered", attempts: 0 },
  };
  const both = { granted: "calendar and drive", anchors: ["11", "1"] };

  it("for a general need, names what else they allowed and offers to go through their email, reading out nothing", () => {
    for (const s of [waiting, { ...waiting, helpNeed: null }]) {
      const general = gmailConnected(EMAIL, INBOX_FACT, false, both, false, s);
      expect(general.mustSayOne).toBeUndefined();
      expect(general.facts).toEqual([EMAIL]);
      expect(general.note).not.toContain(INBOX_FACT);
      expect(general.note).not.toMatch(/11 unread|check their calendar/);
      expect(general.note).toContain("they also allowed their calendar and drive");
      expect(general.note).toContain("offer to go through their email for them");
      expect(general.fallback).toEqual([connectedAsLine(EMAIL), connectedOfferLine("calendar and drive")]);
    }
    expect(connectedOfferLine("calendar and drive").text).toMatch(/calendar and drive.*\?$/);
  });

  it("for a specific need, keeps the one inbox finding in its own bubble, held to its names", () => {
    const bills = gmailConnected(EMAIL, BILLS_FACT, false, { granted: "calendar and drive", anchors: ["northwind energy"] }, false, { ...waiting, helpNeed: need("stay on top of my bills", "bills") });
    expect(bills.mustSayOne).toEqual(["northwind energy"]);
    expect(bills.note).toContain(`"${BILLS_FACT}"`);
    expect(bills.facts).toEqual([EMAIL, BILLS_FACT]);
    expect(bills.fallback).toEqual([connectedAsLine(EMAIL), valueMomentLine(BILLS_FACT)]);
  });

  it("names only the access actually granted, and never claims the calendar without it", () => {
    const bills = { ...waiting, helpNeed: need("stay on top of my bills", "bills") };
    for (const s of [waiting, bills]) {
      const driveOnly = gmailConnected(EMAIL, s === bills ? BILLS_FACT : INBOX_FACT, false, { granted: "drive" }, false, s);
      expect(driveOnly.note).toContain("they also allowed their drive");
      expect(driveOnly.note).not.toContain("calendar");
      expect(driveOnly.fallback.map((l) => l.text).join(" ")).not.toContain("calendar");
    }
    const none = gmailConnected(EMAIL, BILLS_FACT, false, {}, false, bills);
    expect(none.note).not.toMatch(/calendar|drive/);
  });

  it("on a sign-in that adds access, still reads out no count for a general need, and keeps the finding optional for a specific one", () => {
    const connected: Session = { ...waiting, gmail: { status: "connected", email: EMAIL } };
    const general = gmailConnected(EMAIL, INBOX_FACT, false, both, true, connected);
    expect(general.note).not.toContain(INBOX_FACT);
    expect(general.facts).toEqual([EMAIL]);
    expect(general.fallback).toEqual([reconnectedLine(EMAIL), connectedOfferLine("calendar and drive")]);
    const bills = gmailConnected(EMAIL, BILLS_FACT, false, { anchors: ["northwind energy"] }, true, { ...connected, helpNeed: need("stay on top of my bills", "bills") });
    expect(bills.mustSayOne).toBeUndefined();
    expect(bills.note).toContain("it's optional; don't recite it");
    expect(bills.fallback.at(-1)?.text).not.toContain("?");
  });

  it("with no readable inbox, confirms and offers a fresh link, with nothing from their calendar or drive", () => {
    const unread = gmailConnected(EMAIL, null, false, {}, false, waiting);
    expect(unread.fallback.map((l) => l.kind)).toEqual(["confirm_account", "value_unavailable"]);
    expect(`${unread.note} ${unread.fallback.map((l) => l.text).join(" ")}`).not.toMatch(/calendar|drive/);
    const granted = gmailConnected(EMAIL, null, false, { granted: "calendar and drive" }, false, waiting);
    expect(granted.fallback.map((l) => l.kind)).toEqual(["confirm_account", "value_unavailable"]);
    expect(granted.fallback.map((l) => l.text).join(" ")).not.toMatch(/calendar|drive/);
    expect(granted.facts).toEqual([EMAIL]);
  });

  it("on a call, says only that it connected and what else they allowed, and leaves the rest to the call", () => {
    const onCall = gmailConnected(EMAIL, INBOX_FACT, true, { granted: "drive", anchors: ["11"] }, false, waiting);
    expect(onCall.note).toContain("they also allowed their drive");
    expect(onCall.note).not.toContain("calendar");
    expect(onCall.note).not.toContain(INBOX_FACT);
    expect(onCall.fallback).toEqual([connectedAsLine(EMAIL)]);
    expect(onCall.facts).toEqual([EMAIL]);
    expect(onCall.mustSayOne).toBeUndefined();
  });
});

describe("location follow-ups", () => {
  it("thanks them for a share and moves on, stating no number, so the coordinates never reach the thread", () => {
    const s: Session = { ...newSession("s3", NOW), agentName: { value: "Max", source: "text", setAt: NOW }, consent: { termsShownAt: NOW } };
    const followUp = locationShared(s);
    expect(followUp.note).toContain("never write the coordinates");
    expect(followUp.facts).toEqual([]);
    expect(followUp.mustNotSay).toEqual(expect.arrayContaining(["booked", "found"]));
    expect(followUp.fallback[0]?.text).toMatch(/^got it, thanks\. /);
  });

  it("says a refusal honestly in one line and asks for nothing", () => {
    const denied = locationDenied("denied");
    expect(denied.note).toContain("blocked location");
    expect(denied.fallback).toEqual([{ text: expect.stringContaining("the button still works"), kind: "location_denied" }]);
    expect(locationDenied("timeout").fallback[0]?.text).toContain("tap share again");
  });
});

describe("a reminder coming due", () => {
  const reminder = { id: "r1", at: NOW, what: "Stretch before the 3 pm meeting", setAt: NOW };

  it("tells the model what it is for, and falls back to a line that names it", () => {
    const due = reminderDue(newSession("s1", NOW), reminder);
    expect(due.note).toContain('"Stretch before the 3 pm meeting"');
    expect(due.fallback).toEqual([{ text: "quick reminder: stretch before the 3 pm meeting.", kind: "reminder" }]);
    // The only numbers the text may state are the ones in their own words.
    expect(due.facts).toEqual(["Stretch before the 3 pm meeting"]);
  });

  it("falls back in spanish for someone texting in spanish", () => {
    expect(reminderDue({ ...newSession("s1", NOW), lang: "es" }, { ...reminder, what: "estirar" }).fallback[0]?.text).toBe("te recuerdo: estirar.");
  });
});
