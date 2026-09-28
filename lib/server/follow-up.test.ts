import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type SessionEvent } from "@/lib/session/schema";
import { declinedLine, remindLaterLine } from "@/lib/agent/messages";
import { afterCall, declinedCall, gmailConnected, remindLater, reminderDue, staleLink } from "@/lib/agent/follow-ups";
import type { TextAgent, TextReply } from "@/lib/agent/text-agent";

vi.mock("server-only", () => ({}));
const { respond } = vi.hoisted(() => ({ respond: vi.fn<TextAgent["respond"]>() }));
vi.mock("@/lib/server/openai-text", () => ({ openAiTextAgent: { respond } }));

const { declineCall, endCall } = await import("@/lib/server/call-service");
const { RING_TIMEOUT_MS } = await import("@/lib/server/call-timers");
const { deliverFollowUp, deliverOnce, FOLLOW_UP_DEADLINE_MS, shapeReply } = await import("@/lib/server/follow-up");
const { readSnapshot } = await import("@/lib/server/session-service");
const { getStore } = await import("@/lib/server/store");

const said = (...texts: string[]): TextReply => ({ bubbles: texts.map((text) => ({ text, kind: "chat" })), tools: [] });

async function ringing(id: string, ringingAt = new Date().toISOString()) {
  const now = new Date().toISOString();
  const session = {
    ...newSession(id, now),
    agentName: { value: "Jarvis", source: "text" as const, setAt: now },
    consent: { termsShownAt: now },
    call: { status: "ringing" as const, attempts: 1, initiator: "agent" as const, ringingAt },
  };
  await getStore().create(session);
  return session;
}

const agentTexts = async (id: string) => (await getStore().listEvents(id, 50)).filter((e) => e.channel === "text" && e.role === "agent");

const FACT = "i see what look like 2 subscriptions: netflix and spotify. want me to line up which ones to cancel?";

// A call where gmail connected and the user's last words asked to be texted what the agent finds.
async function textMeCall(id: string) {
  const now = new Date().toISOString();
  await getStore().create({
    ...newSession(id, now),
    agentName: { value: "Buddy", source: "text", setAt: now },
    userName: { value: "Preston", source: "text", setAt: now },
    helpNeed: { value: "cancel subscriptions i don't use", source: "voice", setAt: now, category: "subscriptions" },
    gmail: { status: "connected", email: "p@gmail.com", connectedAt: now, valueFact: FACT },
    consent: { termsShownAt: now, firstCallAt: now },
    call: { status: "active", attempts: 1, initiator: "agent", startedAt: now },
  });
  await getStore().appendEvents(id, [
    { at: now, channel: "system", role: "system", content: "agent", meta: { kind: "call_started", callAttempt: 1 } },
    { at: now, channel: "voice", role: "user", content: "I'm going to hang up, text me when you find it.", meta: { kind: "transcript", callAttempt: 1 } },
  ]);
}

describe("follow-ups with the live model", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    respond.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("has the model answer a declined call, under the template's kind", async () => {
    await ringing("fu-decline");
    respond.mockResolvedValue(said("no stress, texting works. what should i call you?"));
    const snapshot = await declineCall("fu-decline", { attempt: 1, action: "decline" });

    expect(respond).toHaveBeenCalledOnce();
    const [session, texts, , note] = respond.mock.lastCall ?? [];
    expect(session?.call.status).toBe("declined");
    expect(texts).toEqual([]);
    expect(note).toContain("they declined your call");
    expect(snapshot.events.slice(-2).map((e) => [e.meta?.kind, e.content])).toEqual([
      ["call_declined", "declined"],
      ["continue_text", "no stress, texting works. what should i call you?"],
    ]);
  });

  it("gives the model until the deadline, then sends the template", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ringing("fu-slow");
    respond.mockReturnValue(new Promise(() => undefined));
    let settled = false;
    const pending = declineCall("fu-slow", { attempt: 1, action: "remind_later" }).finally(() => (settled = true));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(FOLLOW_UP_DEADLINE_MS - 100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);

    const last = (await pending).events.at(-1);
    expect(last).toMatchObject({ content: remindLaterLine(10).text, meta: { kind: "call_scheduled", fallback: true } });
  });

  it("starts the model on the thread the save handed back, with no second read of the session or its thread", async () => {
    const session = await ringing("fu-known");
    const store = getStore();
    const load = vi.spyOn(store, "load");
    const list = vi.spyOn(store, "listEvents");
    respond.mockResolvedValue(said("no stress, texting works."));
    const history: SessionEvent[] = [{ seq: 1, id: "e1", at: session.createdAt, channel: "text", role: "user", content: "hey", meta: { kind: "chat" } }];
    await deliverFollowUp("fu-known", declinedCall({ ...session, call: { ...session.call, status: "declined" } }), { respond }, 7, { session, history, since: Date.now() });
    expect(load).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(respond.mock.lastCall?.[0]).toBe(session);
    expect(respond.mock.lastCall?.[2]).toEqual(history);
    expect((await agentTexts("fu-known")).map((e) => e.content)).toEqual(["no stress, texting works."]);
    load.mockRestore();
    list.mockRestore();
  });

  it("counts the deadline from the request that caused the follow-up, not from when the model starts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = await ringing("fu-since");
    respond.mockReturnValue(new Promise(() => undefined));
    let settled = false;
    const since = Date.now() - 1_000;
    const pending = deliverFollowUp("fu-since", remindLater(10), { respond }, 8, { session, history: [], since }).finally(() => (settled = true));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(FOLLOW_UP_DEADLINE_MS - 1_000 - 150);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect((await agentTexts("fu-since")).at(-1)).toMatchObject({ content: remindLaterLine(10).text, meta: { kind: "call_scheduled", fallback: true } });
  });

  it("sends the template when the model fails", async () => {
    await ringing("fu-error");
    respond.mockRejectedValue(new Error("openai responses failed with 500"));
    const snapshot = await declineCall("fu-error", { attempt: 1, action: "decline" });
    expect(snapshot.events.at(-1)?.content).toBe(declinedLine(snapshot.session).text);
  });

  it("writes one follow-up when two requests race the same transition", async () => {
    await ringing("fu-race");
    respond.mockResolvedValue(said("all good, we'll keep it to text."));
    await Promise.all([1, 2].map(() => declineCall("fu-race", { attempt: 1, action: "decline" })));
    expect(respond).toHaveBeenCalledOnce();
    expect(await agentTexts("fu-race")).toHaveLength(1);
  });

  it("writes one missed-call text when polls race the ring timeout", async () => {
    await ringing("fu-ring", new Date(Date.now() - RING_TIMEOUT_MS - 1_000).toISOString());
    respond.mockResolvedValue(said("tried you, no worries. want me to try again?"));
    await Promise.all([1, 2, 3].map(() => readSnapshot("fu-ring")));
    expect(respond).toHaveBeenCalledOnce();
    expect((await agentTexts("fu-ring")).map((e) => e.meta?.kind)).toEqual(["missed_call"]);
  });

  it("texts what they asked for on the call, with the value fact in the note", async () => {
    await textMeCall("fu-text-me");
    respond.mockResolvedValue(said("found 2 that look like subscriptions: netflix and spotify. want me to line up which to cancel?"));
    await endCall("fu-text-me", { attempt: 1, reason: "user_hangup" });

    const note = respond.mock.lastCall?.[3] ?? "";
    expect(note).toContain("they asked you to text them");
    expect(note).toContain(`value_fact: "${FACT}"`);
    const [reply] = (await agentTexts("fu-text-me")).map((e) => e.content);
    expect(reply).toContain("netflix and spotify");
  });

  it("sends the fact itself when the model's version invents a number", async () => {
    await textMeCall("fu-text-me-invented");
    respond.mockResolvedValue(said("found 5 subscriptions costing you $40 a month."));
    await endCall("fu-text-me-invented", { attempt: 1, reason: "user_hangup" });
    expect((await agentTexts("fu-text-me-invented")).map((e) => e.content)).toEqual([`here's what i found: ${FACT}`]);
  });

  it("sends the template at once while a text turn holds the lease", async () => {
    await ringing("fu-busy");
    await getStore().acquireTurnLease("fu-busy", 20_000);
    const snapshot = await declineCall("fu-busy", { attempt: 1, action: "decline" });
    expect(respond).not.toHaveBeenCalled();
    expect(snapshot.events.at(-1)?.content).toBe(declinedLine(snapshot.session).text);
  });

  it("records on the text what caused it and how long after that row it was saved", async () => {
    await ringing("fu-trace");
    respond.mockResolvedValue(said("no stress, texting works."));
    const { events } = await declineCall("fu-trace", { attempt: 1, action: "decline" });
    const [row, text] = events.slice(-2);
    expect(row?.meta?.kind).toBe("call_declined");
    expect(text?.meta?.followUp).toEqual({ cause: "call_declined:declined", causeSeq: row?.seq, ms: Date.parse(text?.at ?? "") - Date.parse(row?.at ?? ""), template: false });
    expect(text?.meta?.followUp?.ms).toBeGreaterThanOrEqual(0);
  });

  it("marks a recovery the template wrote, and a missed call the ring timeout caused", async () => {
    await textMeCall("fu-trace-hangup");
    respond.mockRejectedValue(new Error("openai responses failed with 500"));
    await endCall("fu-trace-hangup", { attempt: 1, reason: "network" });
    expect((await agentTexts("fu-trace-hangup"))[0]?.meta?.followUp).toMatchObject({ cause: "call_ended:network", template: true });

    await ringing("fu-trace-ring", new Date(Date.now() - RING_TIMEOUT_MS - 1_000).toISOString());
    respond.mockResolvedValue(said("tried you, no worries. want me to try again?"));
    await readSnapshot("fu-trace-ring");
    const [missed] = await agentTexts("fu-trace-ring");
    expect(missed?.meta?.followUp).toMatchObject({ cause: "missed_call:missed", template: false });
  });

  it("records nothing on a follow-up no call caused", async () => {
    await ringing("fu-trace-none");
    respond.mockResolvedValue(said("that link's used up. want a fresh one?"));
    await deliverOnce("fu-trace-none", staleLink(), { respond }, () => true);
    expect((await agentTexts("fu-trace-none"))[0]?.meta?.followUp).toBeUndefined();
  });

  it("writes a follow-up that no state change settles once, under the lease", async () => {
    await ringing("fu-stale");
    respond.mockResolvedValue(said("that link's used up. want a fresh one?"));
    const agent: TextAgent = { respond };
    const due = (history: SessionEvent[]) => !history.some((e) => e.meta?.kind === "stale_link");
    await Promise.all([1, 2].map(() => deliverOnce("fu-stale", staleLink(), agent, due)));
    await deliverOnce("fu-stale", staleLink(), agent, due);
    expect(respond).toHaveBeenCalledOnce();
    expect((await agentTexts("fu-stale")).map((e) => e.meta?.kind)).toEqual(["stale_link"]);
  });
});

describe("delivering a follow-up again", () => {
  beforeEach(() => vi.stubEnv("OPENAI_API_KEY", ""));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("writes it once for the same saved change", async () => {
    await ringing("fu-repeat");
    await deliverFollowUp("fu-repeat", remindLater(10), null, 3);
    await deliverFollowUp("fu-repeat", remindLater(10), null, 3);
    expect((await agentTexts("fu-repeat")).map((e) => e.clientMsgId)).toEqual(["followup:v3:0"]);
  });

  it("retries a write that failed once", async () => {
    await ringing("fu-retry");
    vi.spyOn(getStore(), "appendEvents").mockRejectedValueOnce(new Error("network"));
    await deliverFollowUp("fu-retry", remindLater(10), null, 4);
    expect((await agentTexts("fu-retry")).map((e) => e.content)).toEqual([remindLaterLine(10).text]);
  });

  it("adds nothing on the retry when the first write landed but its answer was lost", async () => {
    await ringing("fu-lost");
    const store = getStore();
    const append = store.appendEvents.bind(store);
    vi.spyOn(store, "appendEvents").mockImplementationOnce(async (id, events) => {
      await append(id, events);
      throw new Error("answer lost");
    });
    await deliverFollowUp("fu-lost", remindLater(10), null, 4);
    expect((await agentTexts("fu-lost")).map((e) => e.content)).toEqual([remindLaterLine(10).text]);
  });
});

describe("follow-ups in mock mode", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    respond.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("write the template with the change itself", async () => {
    await ringing("fu-mock");
    const snapshot = await declineCall("fu-mock", { attempt: 1, action: "decline" });
    expect(respond).not.toHaveBeenCalled();
    const [row, line] = snapshot.events.slice(-2);
    expect(line?.content).toBe(declinedLine(snapshot.session).text);
    expect(line?.seq).toBe((row?.seq ?? 0) + 1);
    expect(line?.at).toBe(row?.at);
  });
});

describe("shapeReply", () => {
  const connected = gmailConnected("p@gmail.com", "you've got 12 unread from the last 3 days.");

  it("aligns the template's kinds from the end, so the value moment is always tagged", () => {
    expect(shapeReply(said("connected as p@gmail.com, and you've got 12 unread from the last 3 days."), connected)?.map((l) => l.kind)).toEqual([
      "value_moment",
    ]);
    expect(shapeReply(said("connected as P@gmail.com.", "12 unread from the last 3 days."), connected)?.map((l) => l.kind)).toEqual([
      "confirm_account",
      "value_moment",
    ]);
    expect(shapeReply(said("connected as p@gmail.com. you've got 12 unread from the last 3 days."), connected)).toMatchObject([
      { text: "connected as p@gmail.com.", kind: "confirm_account" },
      { text: "you've got 12 unread from the last 3 days.", kind: "value_moment" },
    ]);
  });

  it("keeps the template's chips on the bubble that stands in for their line", () => {
    const missed = { note: "it rang out.", fallback: [{ text: "rang out. try again, or keep going here?", kind: "missed_call" as const, quickReplies: ["call me back", "text is fine"] }] };
    expect(shapeReply(said("no answer that time.", "want me to try again, or keep going here?"), missed)).toEqual([
      { text: "no answer that time.", kind: "missed_call" },
      { text: "want me to try again, or keep going here?", kind: "missed_call", quickReplies: ["call me back", "text is fine"] },
    ]);
  });

  it("refuses a reply with a bubble already sent word for word", () => {
    const signOff = { note: "sign off.", fallback: [{ text: "nice catching you. i'm a text away if anything comes up.", kind: "continue_text" as const }] };
    const sent = ["good talking. text me whenever you need something."];
    expect(shapeReply(said("Good talking. Text me whenever you need something."), signOff, sent)).toBeNull();
    expect(shapeReply(said("good talking, the gmail link's up there whenever."), signOff, sent)).not.toBeNull();
  });

  it("refuses a reply that asks nothing when it must", () => {
    const ends = { note: "setup is done.", fallback: [{ text: "you're all set. want me to start there now?", kind: "recap" as const }], mustAsk: true };
    expect(shapeReply(said("you're all set, text me anytime."), ends)).toBeNull();
    expect(shapeReply(said("you're all set.", "want me to pull the bills first?"), ends)).not.toBeNull();
  });

  it("refuses a reply that drops the address or states a number the facts lack", () => {
    expect(shapeReply(said("you're connected! 12 unread from the last 3 days."), connected)).toBeNull();
    expect(shapeReply(said("connected as p@gmail.com. you've got 40 unread."), connected)).toBeNull();
    expect(shapeReply(said("calling you back in 15 min."), remindLater(10))).toBeNull();
    expect(shapeReply(said("i'll call you back in 10 min."), remindLater(10))).not.toBeNull();
    expect(shapeReply(said("   "), remindLater(10))).toBeNull();
    const stretch = reminderDue(newSession("s1", new Date().toISOString()), { id: "r1", at: "", what: "stretch", setAt: "" });
    expect(shapeReply(said("hey, time to stretch."), stretch)).toEqual([{ text: "hey, time to stretch.", kind: "reminder" }]);
    expect(shapeReply(said("stretch for 10 minutes."), stretch)).toBeNull();
  });

  it("refuses a first connect that leaves out what the fact was built from, and lets a reconnect leave it out", () => {
    const fact = "i see bills from 2 companies in the last 6 weeks: northwind energy and harbor mobile. want a heads-up?";
    const anchors = ["northwind energy", "harbor mobile"];
    const first = gmailConnected("p@gmail.com", fact, false, { anchors });
    expect(first.mustSayOne).toEqual(anchors);
    expect(shapeReply(said("connected as p@gmail.com.", "i can check for bill details in your inbox."), first)).toBeNull();
    expect(shapeReply(said("connected as p@gmail.com.", "i spotted bills from harbor mobile and northwind energy. want a heads-up?"), first)).toMatchObject([
      { kind: "confirm_account" },
      { kind: "value_moment" },
    ]);
    const again = gmailConnected("p@gmail.com", fact, false, { anchors }, true);
    expect(again.mustSayOne).toBeUndefined();
    expect(shapeReply(said("all set, you're now connected as p@gmail.com."), again)).not.toBeNull();
  });

  it("for a general need, refuses a connect reply that reads out a count, and takes the offer in its place", () => {
    const now = new Date().toISOString();
    const inbox = { ...newSession("g1", now), helpNeed: { value: "my inbox", category: "inbox" as const, source: "voice" as const, setAt: now } };
    const general = gmailConnected("p@gmail.com", "you've got 12 unread from the last 3 days. want me to sort them?", false, { granted: "calendar", anchors: ["12"] }, false, inbox);
    expect(general.mustSayOne).toBeUndefined();
    expect(shapeReply(said("connected as p@gmail.com.", "you've got 12 unread. want me to sort them?"), general)).toBeNull();
    expect(shapeReply(said("connected as p@gmail.com.", "your calendar came through too. want me to go through your email?"), general)).toMatchObject([
      { kind: "confirm_account" },
      { kind: "value_moment" },
    ]);
  });

  it("holds a count anchor to the whole number", () => {
    const counted = { note: "", fallback: [], mustSayOne: ["2"] };
    expect(shapeReply(said("you've got 12 unread."), counted)).toBeNull();
    expect(shapeReply(said("i see 2 appointment emails."), counted)).not.toBeNull();
  });

  it("refuses a reply that tells another story than what happened", () => {
    const hungUp = afterCall(newSession("h1", new Date().toISOString()), "user_hangup");
    expect(shapeReply(said("looks like we got disconnected."), hungUp)).toBeNull();
    expect(shapeReply(said("looks like you hung up. want me to call back?"), hungUp)).not.toBeNull();
  });

  it("on a live call, confirms the account by text and leaves the fact to the call", () => {
    const onCall = gmailConnected("p@gmail.com", "you've got 12 unread from the last 3 days.", true);
    expect(onCall.fallback.map((l) => l.kind)).toEqual(["confirm_account"]);
    expect(onCall.facts).toEqual(["p@gmail.com"]);
    expect(shapeReply(said("connected as p@gmail.com. 12 unread from the last 3 days."), onCall)).toBeNull();
  });

  it("holds an admin block's text to the offer of a fresh link", () => {
    const blocked = { note: "", fallback: [], mustSay: ["@gmail.com", "link"] };
    expect(shapeReply(said("google sign-in didn't finish. a personal @gmail.com account usually works best."), blocked)).toBeNull();
    expect(shapeReply(said("a personal @gmail.com account usually works best. want a fresh link?"), blocked)).not.toBeNull();
  });
});
