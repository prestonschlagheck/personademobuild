import { describe, expect, it } from "vitest";
import { newSession, type Session } from "@/lib/session/schema";
import { canGraduate, nextBestAsk } from "@/lib/agent/policy";
import {
  CALL_TEXT_CAP,
  LINK_TTL_MS,
  renamedOnCall,
  TEXT_SENT_ON_CALL,
  TOOLS,
  cancelReminders,
  parseToolArgs,
  ringCall,
  runTool,
  runTools,
  toolSpecs,
  type ToolContext,
} from "@/lib/agent/tools";

const NOW = "2026-09-27T01:00:00.000Z";
const text: ToolContext = { runtime: "text", now: NOW, origin: "http://localhost:3000" };
const voice: ToolContext = { ...text, runtime: "voice" };
const base = () => newSession("s1", NOW);
const later = (ms: number): ToolContext => ({ ...text, now: new Date(Date.parse(NOW) + ms).toISOString() });

describe("tool table", () => {
  it("has no tool that can mark Gmail connected", () => {
    expect(TOOLS.map((t) => t.name)).not.toContain("set_gmail_connected");
    for (const tool of TOOLS) expect(tool.name).not.toMatch(/connect(ed)?$/);
  });

  it("allowlists runtimes: start and schedule over text, end_call on voice", () => {
    const names = (runtime: "text" | "voice") => toolSpecs(runtime).map((t) => t.name);
    expect(names("text")).toEqual(expect.arrayContaining(["start_call", "schedule_call"]));
    expect(names("text")).not.toContain("end_call");
    expect(names("voice")).toContain("end_call");
    expect(names("voice")).not.toContain("start_call");
    // The call has the state in its instructions and every result; another round to read it is dead air.
    expect(names("voice")).not.toContain("get_state");
  });

  it("emits provider-neutral JSON schemas", () => {
    const setName = toolSpecs("text").find((t) => t.name === "set_agent_name");
    expect(setName?.parameters).toMatchObject({
      type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 24 } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(setName?.parameters).not.toHaveProperty("$schema");
  });
});

describe("runTool", () => {
  it("rejects unknown tools and tools from the wrong runtime", () => {
    expect(runTool(base(), text, "set_gmail_connected", {}).output).toMatchObject({ ok: false, error: "unknown_tool" });
    expect(runTool(base(), voice, "start_call", {}).output).toMatchObject({ ok: false, error: "not_allowed" });
    expect(runTool(base(), text, "end_call", { reason: "done" }).output).toMatchObject({ ok: false, error: "not_allowed" });
  });

  it("validates arguments strictly", () => {
    expect(runTool(base(), text, "set_agent_name", { name: "Max", extra: 1 }).output.error).toBe("invalid_args");
    expect(runTool(base(), text, "delete_my_data", { confirmed: false }).output.error).toBe("invalid_args");
    expect(runTool(base(), text, "schedule_call", { in_minutes: 0 }).output.error).toBe("invalid_args");
  });

  it("records every call as a tool event, including failures", () => {
    const { events } = runTool(base(), text, "set_agent_name", { name: "<script>" });
    expect(events).toEqual([
      expect.objectContaining({ channel: "system", role: "tool", content: "set_agent_name", meta: expect.objectContaining({ kind: "tool_call" }) }),
    ]);
    expect(events[0]?.meta?.tool).toMatchObject({ ok: false, error: "not_allowed" });
  });

  it("returns the state block on success and failure", () => {
    expect(runTool(base(), text, "get_state", {}).output.state).toContain("next_best_ask: agentName");
    expect(runTool(base(), text, "set_user_name", { name: "fuck" }).output.state).toContain("user_name: not set");
  });

  it("never changes state when a tool fails", () => {
    const s = base();
    expect(runTool(s, text, "set_agent_name", { name: "asdfghjkl" }).session).toBe(s);
  });

  it("refuses to end a call before the user has said anything, but not a goodbye after a silence check-in", () => {
    expect(runTool(base(), { ...voice, heard: false }, "end_call", { reason: "done" }).output).toMatchObject({ ok: false, error: "call_just_started" });
    expect(runTool(base(), { ...voice, heard: false, spoke: 0 }, "end_call", { reason: "silence" }).output.error).toBe("call_just_started");
    expect(runTool(base(), { ...voice, heard: false, spoke: 2 }, "end_call", { reason: "silence" }).output.ok).toBe(true);
    expect(runTool(base(), { ...voice, heard: true }, "end_call", { reason: "done" }).output.ok).toBe(true);
  });

  it("refuses a silence goodbye when the user was the last one to speak", () => {
    expect(runTool(base(), { ...voice, heard: true, userSpokeLast: true }, "end_call", { reason: "silence" }).output.error).toBe("not_silent");
    expect(runTool(base(), { ...voice, heard: true, userSpokeLast: false }, "end_call", { reason: "silence" }).output.ok).toBe(true);
    expect(runTool(base(), { ...voice, heard: true, userSpokeLast: true }, "end_call", { reason: "done" }).output.ok).toBe(true);
  });

  it("reads a model's argument string, and anything unreadable as no arguments", () => {
    expect(parseToolArgs('{"name":"Max"}')).toEqual({ name: "Max" });
    expect(parseToolArgs("")).toEqual({});
    expect(parseToolArgs("{oops")).toEqual({});
  });
});

describe("names", () => {
  it("saves the agent name with its source and normalized casing", () => {
    const { session } = runTool(base(), text, "set_agent_name", { name: "your mom" });
    expect(session.agentName).toEqual({ value: "Your Mom", source: "text", setAt: NOW });
  });

  it("allows renames at any time, from either channel", () => {
    const first = runTool(base(), text, "set_agent_name", { name: "Buddy" }).session;
    expect(runTool(first, voice, "set_agent_name", { name: "max" }).session.agentName).toMatchObject({ value: "Max", source: "voice" });
  });

  it("sends the new contact card with a rename on a call, once, and tells the call to take the name at once", () => {
    const first = runTool(base(), text, "set_agent_name", { name: "Buddy" });
    // Over text the reply puts the card under its bubble, so the tool adds none.
    expect(first.events.filter((e) => e.meta?.kind === "contact_card")).toEqual([]);
    const renamed = runTool(first.session, voice, "set_agent_name", { name: "bob" });
    expect(renamed.events.filter((e) => e.meta?.kind === "contact_card")).toEqual([
      expect.objectContaining({ channel: "text", role: "agent", content: "Bob", meta: { kind: "contact_card", contactCard: { name: "Bob" } } }),
    ]);
    expect(renamed.output.hint).toBe(renamedOnCall("Bob"));
    expect(renamedOnCall("Bob")).toMatch(/^saved as Bob, .*right now/);
    // The same name again is no rename, so no second card.
    const again = runTool(renamed.session, voice, "set_agent_name", { name: "Bob" });
    expect(again.events.filter((e) => e.meta?.kind === "contact_card")).toEqual([]);
    expect(again.output.hint).toBeUndefined();
  });

  it("overwrites the user name when corrected", () => {
    const { session } = runTools(base(), voice, [
      { name: "set_user_name", args: { name: "preston" } },
      { name: "set_user_name", args: { name: "pres" } },
    ]);
    expect(session.userName?.value).toBe("Pres");
  });

  it("clears an earlier skip when the value arrives after all", () => {
    const skipped = runTool(base(), text, "skip_slot", { slot: "userName" }).session;
    expect(skipped.steering.skipped).toEqual(["userName"]);
    expect(runTool(skipped, text, "set_user_name", { name: "Preston" }).session.steering.skipped).toEqual([]);
  });
});

describe("help need", () => {
  it("classifies the need unless the model gives a category", () => {
    expect(runTool(base(), text, "set_help_need", { need: "my inbox is a mess" }).session.helpNeed?.category).toBe("inbox");
    expect(runTool(base(), text, "set_help_need", { need: "the thing", category: "travel" }).session.helpNeed?.category).toBe("travel");
  });

  it("keeps a short label for display and drops one too long to be a label", () => {
    const need = "focus on google-related stuff, mainly gmail";
    expect(runTool(base(), text, "set_help_need", { need, label: " google-related  stuff. " }).session.helpNeed?.label).toBe("google-related stuff");
    const long = runTool(base(), text, "set_help_need", { need, label: "everything to do with google and gmail and the setup" }).session.helpNeed;
    expect(long?.value).toBe(need);
    expect(long?.label).toBeUndefined();
  });
});

describe("a need they never said", () => {
  it("is refused with a code the model sees, while one in their own words is saved", () => {
    const refused = runTool(base(), { ...text, said: ["preston"] }, "set_help_need", { need: "Help with something real" });
    expect(refused.output).toMatchObject({ ok: false, error: "not_their_words" });
    expect(refused.session.helpNeed).toBeNull();
    const saved = runTool(base(), { ...text, said: ["mostly my inbox is a mess"] }, "set_help_need", { need: "clean up my inbox" });
    expect(saved.session.helpNeed?.value).toBe("clean up my inbox");
  });
});

describe("clear_help_need", () => {
  it("clears a need the user took back, on either runtime, and refuses when there is none", () => {
    const withNeed = runTool(base(), text, "set_help_need", { need: "book my haircut" }).session;
    expect(runTool(withNeed, text, "clear_help_need", {}).session.helpNeed).toBeNull();
    expect(runTool(withNeed, voice, "clear_help_need", {}).session.helpNeed).toBeNull();
    expect(runTool(base(), text, "clear_help_need", {}).output).toMatchObject({ ok: false, error: "not_set" });
  });
});

describe("send_gmail_link", () => {
  it("mints a single-use link, texts the card, and asks the server to store the state", () => {
    const { session, events, effects } = runTool(base(), text, "send_gmail_link", {});
    expect(session.gmail).toEqual({ status: "link_sent", linkSentAt: NOW });
    const card = events.find((e) => e.meta?.kind === "gmail_link");
    expect(card?.channel).toBe("text");
    expect(card?.meta?.link?.url).toBe(`http://localhost:3000/api/oauth/google/start?state=${effects.createOAuthState}`);
    expect(effects.createOAuthState).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is idempotent while the link is live, and mints again when it expires or on request", () => {
    const sent = runTool(base(), text, "send_gmail_link", {}).session;
    const again = runTool(sent, later(60_000), "send_gmail_link", {});
    expect(again.session).toBe(sent);
    expect(again.effects).toEqual({});
    expect(again.output.hint).toBe("the live link is already in the text thread");
    expect(runTool(sent, later(LINK_TTL_MS + 1), "send_gmail_link", {}).effects.createOAuthState).toBeDefined();
    expect(runTool(sent, later(60_000), "send_gmail_link", { fresh: true }).effects.createOAuthState).toBeDefined();
  });

  it("explains itself in the thread when sent from the call", () => {
    const kinds = runTool(base(), voice, "send_gmail_link", {}).events.map((e) => e.meta?.kind);
    expect(kinds).toEqual(["tool_call", "gmail_link", "gmail_link"]);
  });

  it("tells the call to say the privacy line with the first link only", () => {
    const first = runTool(base(), voice, "send_gmail_link", {});
    expect(first.output.hint).toContain("never send anything without asking");
    const denied: Session = { ...base(), gmail: { status: "denied" } };
    expect(runTool(denied, voice, "send_gmail_link", {}).output.hint).not.toContain("never send anything without asking");
    expect(runTool(base(), { ...voice, privacySaid: true }, "send_gmail_link", {}).output.hint).not.toContain("never send anything without asking");
    expect(runTool(base(), text, "send_gmail_link", {}).output.hint).toBeUndefined();
  });

  it("mints a new link on request while one is out, and words the replacement differently from the first", () => {
    const out: Session = { ...base(), gmail: { status: "link_sent", linkSentAt: NOW } };
    const renewed = runTool(out, voice, "send_gmail_link", { fresh: true, reason: "wrong_account" });
    expect(renewed.output.ok).toBe(true);
    expect(renewed.effects.createOAuthState).toBeTruthy();
    expect(renewed.events.some((e) => e.meta?.link)).toBe(true);
    const first = runTool(base(), voice, "send_gmail_link", {}).events.find((e) => e.role === "agent" && !e.meta?.link);
    const again = runTool(out, voice, "send_gmail_link", { fresh: true, reason: "expired" }).events.find((e) => e.role === "agent" && !e.meta?.link);
    expect(first?.content).toBe("here's the gmail link from our call. tap it whenever.");
    expect(again?.content).toBe("here's a fresh google link from our call, the one to use now.");
  });

  it("refuses while connected, and a fresh link disconnects the wrong account", () => {
    const connected: Session = { ...base(), gmail: { status: "connected", email: "wrong@gmail.com", valueFact: "x" } };
    expect(runTool(connected, text, "send_gmail_link", {}).output.error).toBe("already_connected");
    expect(runTool(connected, text, "send_gmail_link", { fresh: true }).session.gmail).toEqual({ status: "link_sent", linkSentAt: NOW });
  });
});

describe("calls", () => {
  it("rings on start_call and counts the attempt", () => {
    const { session, events } = runTool(base(), text, "start_call", {});
    expect(session.call).toMatchObject({ status: "ringing", attempts: 1, initiator: "agent", ringingAt: NOW });
    expect(events.at(-1)?.meta).toMatchObject({ kind: "call_ringing", callAttempt: 1 });
  });

  it("refuses a second call while one rings, and never runs out of calls", () => {
    const ringing = runTool(base(), text, "start_call", {}).session;
    expect(runTool(ringing, text, "start_call", {}).output.error).toBe("call_in_progress");
    const many: Session = { ...base(), call: { status: "ended", attempts: 30 } };
    expect(runTool(many, text, "start_call", {}).session.call).toMatchObject({ status: "ringing", attempts: 31 });
  });

  it("schedules a callback", () => {
    const { session, events } = runTool(base(), text, "schedule_call", { in_minutes: 10 });
    expect(session.call).toMatchObject({ status: "scheduled", scheduledFor: "2026-09-27T01:10:00.000Z" });
    expect(events.at(-1)).toMatchObject({ channel: "system", content: "2026-09-27T01:10:00.000Z", meta: { kind: "call_scheduled" } });
  });

  it("schedules by the user's own clock time, from the start of the minute", () => {
    const at = { ...text, now: "2026-09-27T16:36:20.000Z" };
    const ny: Session = { ...base(), timeZone: "America/New_York" };
    expect(runTool(ny, at, "schedule_call", { at: "12:40" }).session.call).toMatchObject({
      status: "scheduled",
      scheduledFor: "2026-09-27T16:40:00.000Z",
    });
    expect(runTool(ny, at, "schedule_call", { at: "3pm" }).session.call.scheduledFor).toBe("2026-09-27T19:00:00.000Z");
  });

  it("refuses a clock time it can't place, and anything but exactly one of at or in_minutes", () => {
    expect(runTool(base(), text, "schedule_call", { at: "12:40" }).output).toMatchObject({ ok: false, error: "time_zone_unknown" });
    const ny: Session = { ...base(), timeZone: "America/New_York" };
    expect(runTool(ny, text, "schedule_call", { at: "25:99" }).output.error).toBe("invalid_time");
    expect(runTool(ny, text, "schedule_call", {}).output.error).toBe("invalid_args");
    expect(runTool(ny, text, "schedule_call", { at: "12:40", in_minutes: 5 }).output.error).toBe("invalid_args");
  });

  it("end_call changes nothing; the client ends the call after the goodbye", () => {
    const s = base();
    expect(runTool(s, voice, "end_call", { reason: "done" }).session).toBe(s);
  });

  it("end_call takes call_back, recorded for the hangup to book the ring, and still changes nothing itself", () => {
    const s = base();
    const out = runTool(s, { ...voice, heard: true }, "end_call", { reason: "user_request", call_back: true });
    expect(out.output.ok).toBe(true);
    expect(out.session).toBe(s);
    expect(out.events[0]?.meta?.tool?.args).toEqual({ reason: "user_request", call_back: true });
    expect(runTool(s, voice, "end_call", { reason: "done", call_back: "yes" }).output.error).toBe("invalid_args");
    expect(toolSpecs("voice").find((t) => t.name === "end_call")?.parameters).toMatchObject({ properties: { call_back: { type: "boolean" } }, required: ["reason"] });
  });

  it("ringCall resets the previous call but keeps its end reason", () => {
    const ended: Session = { ...base(), call: { status: "ended", attempts: 1, lastEndReason: "user_hangup", activeCallId: "rtc_1", startedAt: NOW } };
    expect(ringCall(ended, "user", NOW).session.call).toEqual({
      status: "ringing",
      attempts: 2,
      initiator: "user",
      ringingAt: NOW,
      lastEndReason: "user_hangup",
    });
  });
});

describe("skip_slot", () => {
  it("records the skip and marks Gmail skipped", () => {
    const { session } = runTools(base(), text, [
      { name: "skip_slot", args: { slot: "userName" } },
      { name: "skip_slot", args: { slot: "userName" } },
      { name: "skip_slot", args: { slot: "gmail" } },
    ]);
    expect(session.steering.skipped).toEqual(["userName", "gmail"]);
    expect(session.gmail.status).toBe("skipped");
  });

  it("refuses to skip something already given", () => {
    const named = runTool(base(), text, "set_user_name", { name: "Preston" }).session;
    expect(runTool(named, text, "skip_slot", { slot: "userName" }).output.error).toBe("already_set");
  });
});

describe("graduate", () => {
  it("enforces the graduation rules", () => {
    expect(runTool(base(), text, "graduate", { reason: "all_slots" }).output.error).toBe("not_ready");
    expect(runTool(base(), text, "graduate", { reason: "need_first" }).output.error).toBe("not_ready");
    const need = runTool(base(), text, "set_help_need", { need: "my inbox" }).session;
    expect(runTool(need, text, "graduate", { reason: "need_first" }).session).toMatchObject({ graduated: true, graduationReason: "need_first" });
  });

  it("records all_slots whenever all four are settled, whichever reason the model picked", () => {
    const done: Session = {
      ...base(),
      agentName: { value: "Jarvis", source: "text", setAt: NOW },
      userName: { value: "Preston", source: "voice", setAt: NOW },
      helpNeed: { value: "my inbox", source: "voice", setAt: NOW, category: "inbox" },
      gmail: { status: "connected", email: "p@gmail.com", connectedAt: NOW },
    };
    expect(runTool(done, { ...voice, proceed: false }, "graduate", { reason: "need_first" }).session.graduationReason).toBe("all_slots");
    expect(runTool(done, text, "graduate", { reason: "user_requested" }).session.graduationReason).toBe("all_slots");
  });

  it("graduates on a saved need only when their latest words ask to move on", () => {
    const need = runTool(base(), text, "set_help_need", { need: "my inbox" }).session;
    expect(runTool(need, { ...text, proceed: false }, "graduate", { reason: "need_first" }).output.error).toBe("not_asked");
    expect(runTool(need, { ...text, proceed: true }, "graduate", { reason: "need_first" }).session.graduated).toBe(true);
  });

  it("skips setup only when their words asked to, or took the offer to skip the rest", () => {
    expect(runTool(base(), { ...text, proceed: false }, "graduate", { reason: "user_requested" }).output).toMatchObject({ ok: false, error: "not_asked" });
    expect(runTool(base(), { ...text, proceed: true }, "graduate", { reason: "user_requested" }).session.graduated).toBe(true);
  });

  it("records a skip of everything that was left as a skip, not as all four settled", () => {
    const skipped = runTools(base(), text, (["agentName", "userName", "helpNeed", "gmail"] as const).map((slot) => ({ name: "skip_slot", args: { slot } }))).session;
    expect(runTool(skipped, { ...text, proceed: true }, "graduate", { reason: "user_requested" }).session.graduationReason).toBe("user_requested");
    expect(runTool(skipped, { ...text, proceed: true }, "graduate", { reason: "all_slots" }).session.graduationReason).toBe("all_slots");
  });

  it("lets the user skip everything and writes the ready row", () => {
    const { session, events } = runTool(base(), text, "graduate", { reason: "user_requested" });
    expect(session).toMatchObject({ graduated: true, graduatedAt: NOW, graduationReason: "user_requested" });
    expect(events.at(-1)).toMatchObject({ channel: "system", content: "Persona is ready. Text anytime.", meta: { kind: "graduated" } });
  });

  it("is a no-op once graduated", () => {
    const done = runTool(base(), text, "graduate", { reason: "user_requested" }).session;
    expect(runTool(done, text, "graduate", { reason: "all_slots" })).toMatchObject({ session: done, output: { ok: true } });
  });
});

describe("request_location", () => {
  const withNeed = () => runTool(base(), text, "set_help_need", { need: "book my haircut" }).session;

  it("sends the card for a saved need and records the request against that need", () => {
    const { session, events } = runTool(withNeed(), text, "request_location", {});
    expect(session.location).toEqual({ forNeed: NOW, requestedAt: NOW });
    expect(events.at(-1)).toMatchObject({ channel: "text", role: "agent", meta: { kind: "location_request" } });
  });

  it("sends it when they offer where they are, with no need saved", () => {
    expect(runTool(base(), text, "request_location", {}).session.location).toEqual({ requestedAt: NOW });
  });

  it("keeps one card open at a time, and asks once per need", () => {
    const asked = runTool(withNeed(), text, "request_location", {}).session;
    expect(runTool(asked, text, "request_location", {}).output.error).toBe("already_requested");
    const shared: Session = { ...asked, location: { forNeed: NOW, requestedAt: NOW, sharedAt: NOW, coarse: { lat: 1, lng: 2, accuracyM: 50 } } };
    expect(runTool(shared, text, "request_location", {}).output.error).toBe("already_shared");
    const renewed = runTool(shared, later(60_000), "set_help_need", { need: "find a dentist near me" }).session;
    expect(runTool(renewed, later(60_000), "request_location", {}).output.ok).toBe(true);
  });

  it("is refused for a weather need, since no tool looks the weather up", () => {
    const weather = runTool(base(), text, "set_help_need", { need: "check the weather near me" }).session;
    expect(runTool(weather, text, "request_location", {}).output.error).toBe("no_live_lookup");
    expect(runTool(weather, voice, "request_location", {}).output.error).toBe("no_live_lookup");
  });

  it("stops asking when the need it was for is taken back", () => {
    const asked = runTool(withNeed(), text, "request_location", {}).session;
    expect(runTool(asked, text, "clear_help_need", {}).session.location).toBeUndefined();
  });

  it("is refused while stopped, and over text while a call is live", () => {
    expect(runTool({ ...withNeed(), consent: { stoppedAt: NOW } }, text, "request_location", {}).output.error).toBe("stopped");
    expect(runTool({ ...withNeed(), call: { status: "active", attempts: 1 } }, text, "request_location", {}).output.error).toBe("call_in_progress");
  });

  it("texts the card from a call, and tells the call where it went", () => {
    const onCall: Session = { ...withNeed(), call: { status: "active", attempts: 1 } };
    const { session, events, output } = runTool(onCall, voice, "request_location", {});
    expect(session.location).toEqual({ forNeed: NOW, requestedAt: NOW });
    expect(events.at(-1)).toMatchObject({ channel: "text", role: "agent", meta: { kind: "location_request" } });
    expect(output.hint).toContain("share my location");
    expect(runTool(session, voice, "request_location", {}).output.error).toBe("already_requested");
  });
});

describe("send_dashboard_link", () => {
  it("texts the dashboard card and changes nothing else", () => {
    const s = base();
    const { session, events } = runTool(s, text, "send_dashboard_link", {});
    expect(session).toBe(s);
    expect(events.at(-1)?.meta).toMatchObject({
      kind: "dashboard_link",
      link: { url: "http://localhost:3000/dashboard", title: "Open your Persona dashboard", preview: "dashboard" },
    });
  });

  it("is text only: a call keeps delete_my_data", () => {
    expect(runTool(base(), voice, "send_dashboard_link", {}).output.error).toBe("not_allowed");
  });
});

describe("send_text", () => {
  const onCall: Session = {
    ...base(),
    agentName: { value: "Buddy", source: "text", setAt: NOW },
    userName: { value: "Preston", source: "text", setAt: NOW },
    call: { status: "active", attempts: 1, startedAt: NOW },
  };
  const heard: ToolContext = { ...voice, heard: true, spoke: 1 };
  const bubbles = (events: { channel: string; role: string }[]) => events.filter((e) => e.channel === "text" && e.role === "agent");

  it("puts one agent bubble in the thread, trimmed and in the product voice, and tells the call it's there", () => {
    const { session, events, output } = runTool(onCall, heard, "send_text", { text: "  Persona Application Submission \u2014 4 PM, Preston\u2019s  " });
    expect(bubbles(events)).toEqual([{ channel: "text", role: "agent", content: "persona application submission, 4 pm, Preston's", meta: { kind: "chat" } }]);
    expect(output).toMatchObject({ ok: true, hint: TEXT_SENT_ON_CALL });
    expect(session.call.textsSent).toBe(1);
  });

  it("refuses a link, however it's written, but not an email address", () => {
    const links = [
      "see https://evil.example/login",
      "go to www.persona.ai",
      "it's on x.com",
      "try Sub.Example.co/path",
      // Written so a looser check misses it, but it still reads as a link.
      "it's __evil.com__",
      "see foo_bar.evil.com",
      "evil\u200b.com",
      "\uff45\uff56\uff49\uff4c\uff0e\uff43\uff4f\uff4d",
      "reach me @evil.com",
      "x@evil.com/login",
      "go to 10.0.0.1/login",
      // A file type that is also a real domain.
      "grab it at evil.zip",
    ];
    for (const link of links) {
      const { session, events, output } = runTool(onCall, heard, "send_text", { text: link });
      expect(output, link).toMatchObject({ ok: false, error: "has_link" });
      expect(bubbles(events), link).toEqual([]);
      expect(session, link).toBe(onCall);
    }
    for (const words of [
      "her email is maya.chen@gmail.com",
      "first_last@x.co.uk",
      "call at 4.30 pm, e.g. after lunch",
      "q3 budget.xlsx and offer letter.final.pdf",
      "$4.99 on 9.28",
    ]) {
      expect(runTool(onCall, heard, "send_text", { text: words }).output.ok, words).toBe(true);
    }
  });

  it("keeps a text to one line with nothing hidden in it, and never past a bubble once its dashes are commas", () => {
    const { events } = runTool(onCall, heard, "send_text", { text: "title\n\n\n\n4 pm\u202e\u200b the \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 trip" });
    expect(bubbles(events)).toEqual([expect.objectContaining({ content: "title 4 pm the \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 trip" })]);
    expect(runTool(onCall, heard, "send_text", { text: "\u200b\u2060" }).output.error).toBe("empty_text");
    const dashed = `${"a".repeat(98)}\u2014${"b".repeat(98)}\u2014ab`;
    expect(dashed).toHaveLength(200);
    const { session, output } = runTool(onCall, heard, "send_text", { text: dashed });
    expect(output).toMatchObject({ ok: false, error: "too_long" });
    expect(session).toBe(onCall);
  });

  it("refuses an empty text, one past 200 characters, and one before they've said anything", () => {
    expect(runTool(onCall, heard, "send_text", { text: "   " }).output.error).toBe("empty_text");
    expect(runTool(onCall, heard, "send_text", { text: "a".repeat(201) }).output.error).toBe("invalid_args");
    expect(runTool(onCall, heard, "send_text", { text: ` ${"a".repeat(200)} ` }).output.ok).toBe(true);
    expect(runTool(onCall, { ...voice, heard: false, spoke: 0 }, "send_text", { text: "hi" }).output.error).toBe("nothing_heard_yet");
  });

  it("refuses after stop", () => {
    const stopped = { ...onCall, consent: { stoppedAt: NOW } };
    const { events, output } = runTool(stopped, heard, "send_text", { text: "the title" });
    expect(output).toMatchObject({ ok: false, error: "stopped" });
    expect(bubbles(events)).toEqual([]);
  });

  it(`sends at most ${CALL_TEXT_CAP} on one call, and a new ring starts the count over`, () => {
    const calls = Array.from({ length: CALL_TEXT_CAP + 1 }, (_, i) => ({ name: "send_text", args: { text: `note ${i + 1}` } }));
    const { session, events, outputs } = runTools(onCall, heard, calls);
    expect(outputs.map((o) => o.ok)).toEqual([...Array<boolean>(CALL_TEXT_CAP).fill(true), false]);
    expect(outputs.at(-1)?.error).toBe("text_limit");
    expect(bubbles(events)).toHaveLength(CALL_TEXT_CAP);
    const next = ringCall({ ...session, call: { ...session.call, status: "ended" } }, "user", NOW).session;
    expect(next.call.textsSent).toBeUndefined();
    expect(runTool({ ...next, call: { ...next.call, status: "active" } }, heard, "send_text", { text: "again" }).output.ok).toBe(true);
  });

  it("is not offered over text, where every reply is a text already", () => {
    expect(toolSpecs("text").map((t) => t.name)).not.toContain("send_text");
    expect(toolSpecs("voice").find((t) => t.name === "send_text")?.parameters).toMatchObject({
      properties: { text: { type: "string", maxLength: 200 } },
      required: ["text"],
      additionalProperties: false,
    });
    expect(runTool(onCall, text, "send_text", { text: "hi" }).output.error).toBe("not_allowed");
  });
});

describe("send_contact_card", () => {
  const named: Session = { ...base(), agentName: { value: "Jarvis", source: "text", setAt: NOW } };
  const cards = (events: { meta?: { kind?: string } }[]) => events.filter((e) => e.meta?.kind === "contact_card");
  const aMinuteOn = (ctx: ToolContext): ToolContext => ({ ...ctx, now: new Date(Date.parse(NOW) + 60_000).toISOString() });

  it("texts the card with the saved name, on either runtime", () => {
    for (const ctx of [text, voice]) {
      const { session, events, output } = runTool(named, aMinuteOn(ctx), "send_contact_card", {});
      expect(session, ctx.runtime).toEqual({ ...named, contact: { sentAt: aMinuteOn(ctx).now } });
      expect(cards(events), ctx.runtime).toEqual([
        expect.objectContaining({ channel: "text", role: "agent", content: "Jarvis", meta: { kind: "contact_card", contactCard: { name: "Jarvis" } } }),
      ]);
      expect(output.ok, ctx.runtime).toBe(true);
    }
    expect(toolSpecs("text").map((t) => t.name)).toContain("send_contact_card");
    expect(toolSpecs("voice").map((t) => t.name)).toContain("send_contact_card");
  });

  it("refuses with no name yet, and after stop", () => {
    expect(runTool(base(), aMinuteOn(voice), "send_contact_card", {}).output).toMatchObject({ ok: false, error: "no_name" });
    expect(runTool({ ...named, consent: { stoppedAt: NOW } }, aMinuteOn(text), "send_contact_card", {}).output.error).toBe("stopped");
  });

  it("sends no second card right after a name, which sent its own", () => {
    for (const ctx of [text, voice]) {
      const { events, outputs } = runTools(base(), ctx, [
        { name: "set_agent_name", args: { name: "Nova" } },
        { name: "send_contact_card", args: {} },
      ]);
      // Over text the reply puts the card under its bubble, and a call's rename sends it with the save.
      expect(cards(events), ctx.runtime).toHaveLength(ctx.runtime === "voice" ? 1 : 0);
      expect(outputs[1], ctx.runtime).toMatchObject({ ok: true, hint: "your contact card is already in their messages" });
    }
  });

  it("sends one card a minute however often it's asked, so a looping model can't fill the thread", () => {
    for (const ctx of [text, voice]) {
      const { session, events, outputs } = runTools(named, aMinuteOn(ctx), Array.from({ length: 4 }, () => ({ name: "send_contact_card", args: {} })));
      expect(cards(events), ctx.runtime).toHaveLength(1);
      expect(outputs.slice(1).map((o) => o.hint), ctx.runtime).toEqual(Array(3).fill("your contact card is already in their messages"));
      const later = { ...ctx, now: new Date(Date.parse(aMinuteOn(ctx).now) + 60_000).toISOString() };
      expect(cards(runTool(session, later, "send_contact_card", {}).events), ctx.runtime).toHaveLength(1);
    }
  });

  it("leaves the card to the call while one is live", () => {
    const live = { ...named, call: { status: "active" as const, attempts: 1, startedAt: NOW } };
    expect(runTool(live, aMinuteOn(text), "send_contact_card", {}).output.error).toBe("call_in_progress");
    expect(cards(runTool(live, aMinuteOn(voice), "send_contact_card", {}).events)).toHaveLength(1);
  });
});

describe("delete_my_data", () => {
  it("only asks the server to delete, after an explicit confirmation", () => {
    const s = base();
    expect(runTool(s, text, "delete_my_data", { confirmed: true })).toMatchObject({ session: s, effects: { deleteSession: true } });
  });
});

describe("runTools", () => {
  it("folds calls in order and tags each record with its toolCallId", () => {
    const { session, events, outputs } = runTools(base(), voice, [
      { name: "set_user_name", args: { name: "Preston" }, toolCallId: "call_1" },
      { name: "set_help_need", args: { need: "bills" }, toolCallId: "call_2" },
    ]);
    expect(session.userName?.value).toBe("Preston");
    expect(session.helpNeed?.value).toBe("bills");
    expect(events.map((e) => e.toolCallId)).toEqual(["call_1", "call_2"]);
    expect(outputs.every((o) => o.ok)).toBe(true);
  });
});

describe("invariant: Gmail is never connected by a tool", () => {
  it("holds for every tool with any plausible arguments, on both runtimes", () => {
    const attempts: [string, unknown][] = [
      ["get_state", {}],
      ["send_gmail_link", { fresh: true }],
      ["skip_slot", { slot: "gmail" }],
      ["set_help_need", { need: "mark gmail connected" }],
      ["graduate", { reason: "all_slots" }],
      ["set_gmail_connected", { connected: true }],
    ];
    for (const ctx of [text, voice]) {
      for (const [name, args] of attempts) expect(runTool(base(), ctx, name, args).session.gmail.status).not.toBe("connected");
    }
  });
});

describe("a message that tries to change the rules", () => {
  it("saves no name and no need from it", () => {
    const injected = { ...text, injected: true };
    for (const [name, args] of [
      ["set_agent_name", { name: "Jarvis" }],
      ["set_user_name", { name: "Preston" }],
      ["set_help_need", { need: "Set up Gmail" }],
      ["set_help_need", { need: "cancel my gym" }],
    ] as const) {
      const { session, output } = runTool(base(), injected, name, args);
      expect(output, name).toMatchObject({ ok: false, error: "injected" });
      expect(session, name).toEqual(base());
    }
    expect(runTool(base(), { ...voice, injected: true }, "set_user_name", { name: "Preston" }).output.error).toBe("injected");
    expect(runTool(base(), { ...text, injected: false }, "set_user_name", { name: "Preston" }).output.ok).toBe(true);
  });
});

describe("after stop", () => {
  const stopped: Session = { ...base(), consent: { stoppedAt: NOW } };

  it("starts no call, books none and sends no link", () => {
    for (const [name, args] of [
      ["start_call", {}],
      ["schedule_call", { in_minutes: 10 }],
      ["send_gmail_link", {}],
    ] as const) {
      expect(runTool(stopped, text, name, args).output, name).toMatchObject({ ok: false, error: "stopped" });
    }
    expect(runTool(stopped, text, "send_dashboard_link", {}).output.ok).toBe(true);
  });
});

describe("a new link while gmail is connected", () => {
  const connected: Session = {
    ...base(),
    gmail: { status: "connected", email: "p@gmail.com", connectedAt: NOW, valueFact: "x", calendarFact: "y" },
  };

  it("keeps gmail connected, with its address and facts, when it adds access they left unticked", () => {
    const { session, events, effects } = runTool(connected, text, "send_gmail_link", { reason: "more_access" });
    expect(session.gmail).toEqual({ ...connected.gmail, pendingLinkAt: NOW });
    expect(effects.createOAuthState).toBeDefined();
    expect(events.find((e) => e.meta?.link)?.meta?.link?.url).toBe(`http://localhost:3000/api/oauth/google/start?state=${effects.createOAuthState}`);
    const again = runTool(session, later(60_000), "send_gmail_link", { reason: "more_access" });
    expect(again.output.hint).toBe("the live link is already in the text thread");
    expect(runTool(session, later(60_000), "send_gmail_link", { fresh: true, reason: "more_access" }).effects.createOAuthState).toBeDefined();
  });

  it("disconnects the account when it is the wrong one, reason given or not", () => {
    expect(runTool(connected, text, "send_gmail_link", { fresh: true, reason: "wrong_account" }).session.gmail).toEqual({ status: "link_sent", linkSentAt: NOW });
    expect(runTool(connected, text, "send_gmail_link", { fresh: true }).session.gmail).toEqual({ status: "link_sent", linkSentAt: NOW });
  });

  it("hands a replaced account's sign-in back at once, and keeps it while a link only adds access", () => {
    expect(runTool(connected, text, "send_gmail_link", { fresh: true, reason: "wrong_account" }).effects.revokeGoogle).toBe(true);
    expect(runTool(connected, voice, "send_gmail_link", { fresh: true }).effects.revokeGoogle).toBe(true);
    expect(runTool(connected, text, "send_gmail_link", { reason: "more_access" }).effects.revokeGoogle).toBeUndefined();
    // With nothing connected there is no sign-in to hand back.
    expect(runTool(base(), text, "send_gmail_link", { fresh: true, reason: "wrong_account" }).effects.revokeGoogle).toBeUndefined();
  });

  it("tells the call the new link keeps gmail connected", () => {
    expect(runTool(connected, voice, "send_gmail_link", { reason: "more_access" }).output.hint).toContain("gmail stays connected meanwhile");
  });
});

describe("the call's link, texted once the need calls for it", () => {
  it("has the call ask about their need in the same turn, in two short sentences at most", () => {
    const hint = runTool(base(), voice, "send_gmail_link", {}).output.hint ?? "";
    expect(hint).toContain("then ask about their need");
    expect(hint).toContain("two short sentences at most");
    expect(hint).not.toContain("nothing else");
    const withNeed: Session = { ...base(), helpNeed: { value: "bills", source: "voice", setAt: NOW, category: "bills" } };
    const hint2 = runTool(withNeed, voice, "send_gmail_link", {}).output.hint ?? "";
    expect(hint2).toContain("tie it to their need: going through their email is the best way to help with it");
    expect(hint2).toContain("then ask what to call them");
    const named: Session = { ...withNeed, userName: { value: "Preston", source: "voice", setAt: NOW } };
    expect(runTool(named, voice, "send_gmail_link", {}).output.hint).toContain("ask nothing else");
  });
});

describe("the call's link sentence", () => {
  const ctxAt = (now: string): ToolContext => ({ runtime: "voice", now, origin: "http://localhost", heard: true, spoke: 1 });

  it("is one sentence in the call's own words, welcoming a name said in the same breath, with the privacy line once", () => {
    const named: Session = { ...base(), userName: { value: "Preston", source: "voice", setAt: NOW } };
    const soon = new Date(Date.parse(NOW) + 2_000).toISOString();
    const hint = runTool(named, ctxAt(soon), "send_gmail_link", {}).output.hint ?? "";
    expect(hint).toContain("in one sentence of your own words, welcome Preston by name, and say you just texted them a google link to tap whenever, and that you never send anything without asking.");
    expect(hint).not.toMatch(/word for word/);
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    expect(runTool(named, ctxAt(later), "send_gmail_link", {}).output.hint).not.toContain("welcome Preston");
    expect(runTool(named, { ...ctxAt(soon), privacySaid: true }, "send_gmail_link", {}).output.hint).not.toContain("never send anything without asking");
  });
});

describe("set_reminder", () => {
  const ny: Session = { ...base(), timeZone: "America/New_York" };
  const set = (s: Session, args: Record<string, unknown>, ctx: ToolContext = text) => runTool(s, ctx, "set_reminder", args);

  it("books a reminder in minutes and says the local time back", () => {
    const { session, output } = set(ny, { what: "  stretch. ", in_minutes: 1 });
    expect(session.reminders).toEqual([{ id: expect.any(String), at: "2026-09-27T01:01:00.000Z", what: "stretch", setAt: NOW }]);
    expect(output).toMatchObject({ ok: true, hint: expect.stringContaining("9:01 pm") });
  });

  it("books one by their clock time, the same way a callback is booked, and names the day when it isn't today", () => {
    const at = { ...text, now: "2026-09-27T16:36:20.000Z" };
    expect(set(ny, { what: "call mom", at: "12:40" }, at).session.reminders?.[0]?.at).toBe("2026-09-27T16:40:00.000Z");
    expect(set(ny, { what: "call mom", in_minutes: 180 }).output.hint).toContain("12:00 am on sun, sep 27");
  });

  it("works on a call too, and without a time zone says how far off it is", () => {
    const { session, output } = set(base(), { what: "stretch", in_minutes: 10 }, voice);
    expect(session.reminders).toHaveLength(1);
    expect(output.hint).toContain("10 min from now");
  });

  it("keeps a second ask for the same reminder as the one already waiting", () => {
    const once = set(ny, { what: "stretch", in_minutes: 1 }).session;
    expect(set(once, { what: "Stretch", in_minutes: 1 }).session.reminders).toHaveLength(1);
    expect(set(once, { what: "stretch", in_minutes: 2 }).session.reminders).toHaveLength(2);
  });

  it("refuses after stop, past five waiting, and with nothing to remind them of", () => {
    expect(set({ ...ny, consent: { stoppedAt: NOW } }, { what: "stretch", in_minutes: 1 }).output).toMatchObject({ ok: false, error: "stopped" });
    let full = ny;
    for (let i = 1; i <= 5; i++) full = set(full, { what: `stretch ${i}`, in_minutes: i }).session;
    expect(set(full, { what: "one more", in_minutes: 9 }).output).toMatchObject({ ok: false, error: "too_many_reminders" });
    // A reminder already sent or cancelled no longer counts.
    const spent: Session = { ...full, reminders: full.reminders?.map((r, i) => (i === 0 ? { ...r, sentAt: NOW } : r)) };
    expect(set(spent, { what: "one more", in_minutes: 9 }).output.ok).toBe(true);
    expect(set(ny, { what: " . ", in_minutes: 1 }).output).toMatchObject({ ok: false, error: "empty_what" });
  });

  it("refuses a time it can't place, and anything but exactly one of at or in_minutes", () => {
    expect(set(base(), { what: "stretch", at: "3pm" }).output).toMatchObject({ ok: false, error: "time_zone_unknown" });
    expect(set(ny, { what: "stretch", at: "25:99" }).output.error).toBe("invalid_time");
    expect(set(ny, { what: "stretch" }).output.error).toBe("invalid_args");
    expect(set(ny, { what: "stretch", at: "3pm", in_minutes: 5 }).output.error).toBe("invalid_args");
    expect(set(ny, { what: "stretch", in_minutes: 0 }).output.error).toBe("invalid_args");
    expect(set(ny, { what: "stretch", in_minutes: 10_081 }).output.error).toBe("invalid_args");
  });

  it("saves nothing guessed on a call's opening or lifted from a message that tries to change the rules", () => {
    expect(set(ny, { what: "stretch", in_minutes: 1 }, { ...voice, heard: false, spoke: 0 }).output.error).toBe("nothing_heard_yet");
    expect(set(ny, { what: "stretch", in_minutes: 1 }, { ...text, injected: true }).output.error).toBe("injected");
  });
});

describe("cancelReminders", () => {
  it("cancels every reminder still waiting and leaves sent ones as they were", () => {
    const sent = { id: "a", at: NOW, what: "stretch", setAt: NOW, sentAt: NOW };
    const waiting = { id: "b", at: NOW, what: "drink water", setAt: NOW };
    const later = "2026-09-27T02:00:00.000Z";
    expect(cancelReminders({ ...base(), reminders: [sent, waiting] }, later).reminders).toEqual([sent, { ...waiting, cancelledAt: later }]);
    const none = base();
    expect(cancelReminders(none, later)).toBe(none);
  });
});

describe("disconnect_google", () => {
  const connected: Session = {
    ...base(),
    gmail: {
      status: "connected",
      email: "p@gmail.com",
      connectedAt: NOW,
      scopes: ["gmail.modify"],
      pendingLinkAt: NOW,
      valueFact: "3 bills are due this week.",
      calendarFact: "2 events tomorrow.",
      driveFact: "folders: taxes.",
    },
  };

  it("runs on both runtimes and takes no arguments", () => {
    for (const runtime of ["text", "voice"] as const) {
      expect(toolSpecs(runtime).find((t) => t.name === "disconnect_google")?.parameters).toMatchObject({ properties: {}, additionalProperties: false });
    }
  });

  it("disconnects, forgetting the address and every fact, and asks for the sign-in to be handed back once saved", () => {
    const { session, output, effects } = runTool(connected, voice, "disconnect_google", {});
    expect(output.ok).toBe(true);
    expect(session.gmail).toEqual({ status: "disconnected" });
    expect(effects).toEqual({ revokeGoogle: true });
  });

  it("is refused with nothing connected, unless a sign-in is still stored", () => {
    const linkSent: Session = { ...base(), gmail: { status: "link_sent", linkSentAt: NOW } };
    expect(runTool(linkSent, text, "disconnect_google", {}).output).toMatchObject({ ok: false, error: "not_connected" });
    expect(runTool({ ...base(), gmail: { status: "disconnected" } }, text, "disconnect_google", {}).output.error).toBe("not_connected");
    expect(runTool(linkSent, { ...text, googleGrant: true }, "disconnect_google", {}).effects.revokeGoogle).toBe(true);
  });

  it("counts gmail as settled, so it is not asked for again, while a new link still connects it", () => {
    const { session } = runTool({ ...connected, userName: { value: "Preston", source: "text", setAt: NOW } }, text, "disconnect_google", {});
    expect(nextBestAsk(session, "text").slot).not.toBe("gmail");
    expect(canGraduate({ ...session, agentName: { value: "Buddy", source: "text", setAt: NOW }, helpNeed: { value: "bills", source: "text", setAt: NOW, category: "bills" } }, "all_slots").ok).toBe(true);
    const relinked = runTool(session, text, "send_gmail_link", {});
    expect(relinked.session.gmail).toEqual({ status: "link_sent", linkSentAt: NOW });
    expect(relinked.effects.revokeGoogle).toBeUndefined();
  });
});
