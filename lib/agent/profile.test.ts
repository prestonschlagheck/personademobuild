import { describe, expect, it } from "vitest";
import { newSession, type EventKind, type Session, type SessionEvent } from "@/lib/session/schema";
import { LONG_MIN, QUICK_MS, SHORT_MAX, SLOW_MS, casualText, personProfile, profileLine, withProfile } from "@/lib/agent/profile";

const START = Date.parse("2026-09-28T15:00:00.000Z");
let seq = 0;
const at = (ms: number) => new Date(START + ms).toISOString();
const row = (channel: SessionEvent["channel"], role: SessionEvent["role"], content: string, ms = 0, kind: EventKind = "chat"): SessionEvent => {
  seq += 1;
  return { seq, id: `e${seq}`, at: at(ms), channel, role, content, meta: { kind } };
};
const theirs = (content: string, ms = 0) => row("text", "user", content, ms);
const ours = (content: string, ms = 0) => row("text", "agent", content, ms);
const system = (kind: EventKind, content = "", ms = 0) => row("system", "system", content, ms, kind);
const session = (extra: Partial<Session> = {}): Session => ({ ...newSession("s1", at(0)), ...extra });

describe("the person card", () => {
  it("knows nothing about a thread with nothing in it", () => {
    expect(personProfile(session(), [])).toEqual({});
    expect(withProfile(session(), []).profile).toBeUndefined();
    expect(profileLine(undefined)).toBeNull();
    expect(profileLine({})).toBeNull();
  });

  it("reads length, tone and hour only from two texts on", () => {
    const one = personProfile(session({ timeZone: "America/New_York" }), [theirs("hey")]);
    expect(one).toEqual({});
  });

  describe("channel", () => {
    it("is text once they said so, declined or let it ring out", () => {
      expect(personProfile(session({ steering: { ...newSession("s", at(0)).steering, textOnly: true } }), []).channel).toBe("text");
      expect(personProfile(session(), [system("call_ringing", "Incoming call"), system("call_declined", "declined")]).channel).toBe("text");
      expect(personProfile(session(), [system("call_ringing", "Incoming call"), system("missed_call", "missed")]).channel).toBe("text");
    });

    it("is call once they took one, asked for one or booked one", () => {
      expect(personProfile(session(), [system("call_ringing", "Incoming call"), system("call_started", "agent")]).channel).toBe("call");
      expect(personProfile(session(), [system("call_ringing", "Calling")]).channel).toBe("call");
      expect(personProfile(session(), [system("call_scheduled", at(60_000))]).channel).toBe("call");
    });

    it("follows the latest thing they did, and never an agent bubble of the same kind", () => {
      expect(personProfile(session(), [system("missed_call", "missed"), system("call_ringing", "Calling")]).channel).toBe("call");
      expect(personProfile(session(), [system("call_started", "agent"), system("call_declined", "declined")]).channel).toBe("text");
      expect(personProfile(session(), [row("text", "agent", "i'll call you in 5 min.", 0, "call_scheduled")]).channel).toBeUndefined();
      // An agent call that rang with no answer yet says nothing.
      expect(personProfile(session(), [system("call_ringing", "Incoming call")]).channel).toBeUndefined();
    });
  });

  it("carries the language the session tracks", () => {
    expect(personProfile(session({ lang: "es" }), []).lang).toBe("es");
    expect(personProfile(session(), []).lang).toBeUndefined();
  });

  describe("length", () => {
    const texts = (chars: number) => [theirs("a".repeat(chars)), theirs("b".repeat(chars))];
    it("is short up to its limit, long from its limit, and medium between", () => {
      expect(personProfile(session(), texts(SHORT_MAX)).length).toBe("short");
      expect(personProfile(session(), texts(SHORT_MAX + 1)).length).toBe("medium");
      expect(personProfile(session(), texts(LONG_MIN - 1)).length).toBe("medium");
      expect(personProfile(session(), texts(LONG_MIN)).length).toBe("long");
    });

    it("uses the median, so one long text among short ones stays short", () => {
      expect(personProfile(session(), [theirs("ok"), theirs("sure"), theirs("x".repeat(400))]).length).toBe("short");
    });

    it("counts only their texts, never reactions, call lines or the agent's", () => {
      const events = [theirs("ok"), row("text", "user", "Loved", 0, "reaction"), row("voice", "user", "hello", 0, "transcript"), ours("a".repeat(300))];
      expect(personProfile(session(), events).length).toBeUndefined();
    });
  });

  describe("tone", () => {
    it("reads emoji, slang and bare lowercase as casual", () => {
      expect(casualText("Sounds great 🙌")).toBe(true);
      expect(casualText("Idk, maybe tomorrow.")).toBe(true);
      expect(casualText("sure call me")).toBe(true);
      expect(casualText("Sure, call me.")).toBe(false);
      expect(casualText("My name is Dana")).toBe(false);
      expect(casualText("sure.")).toBe(false);
    });

    it("is casual when at least half their texts are, plain otherwise", () => {
      expect(personProfile(session(), [theirs("yeah"), theirs("My name is Dana.")]).tone).toBe("casual");
      expect(personProfile(session(), [theirs("Hello there."), theirs("My name is Dana."), theirs("ok lol")]).tone).toBe("plain");
    });
  });

  describe("pace", () => {
    const replies = (wait: number) => [ours("hi", 0), theirs("hey", wait), ours("so?", wait + 1_000), theirs("yes", 2 * wait + 1_000)];
    it("is quick up to its limit, slow from its limit, and unsaid between", () => {
      expect(personProfile(session(), replies(QUICK_MS)).pace).toBe("quick");
      expect(personProfile(session(), replies(QUICK_MS + 1)).pace).toBeUndefined();
      expect(personProfile(session(), replies(SLOW_MS - 1)).pace).toBeUndefined();
      expect(personProfile(session(), replies(SLOW_MS)).pace).toBe("slow");
    });

    it("needs two replies, counts a burst once, and skips a wait a call sat in", () => {
      expect(personProfile(session(), [ours("hi", 0), theirs("hey", 5_000)]).pace).toBeUndefined();
      const burst = [ours("hi", 0), theirs("hey", 5_000), theirs("so", 20 * 60_000), theirs("anyway", 40 * 60_000)];
      expect(personProfile(session(), burst).pace).toBeUndefined();
      const call = [ours("hi", 0), theirs("hey", 5_000), ours("calling", 6_000), system("call_started", "user", 7_000), theirs("back", 30 * 60_000)];
      expect(personProfile(session(), call).pace).toBeUndefined();
    });
  });

  describe("hour", () => {
    it("is the local hour they text at most, in the session's zone", () => {
      // 15:00 UTC is 11 am in New York in September.
      const events = [theirs("hey", 0), theirs("ok", 60_000), theirs("later", 3 * 3_600_000)];
      expect(personProfile(session({ timeZone: "America/New_York" }), events).hour).toBe(11);
    });

    it("takes the latest hour when two tie, and says nothing without a zone", () => {
      const events = [theirs("hey", 0), theirs("ok", 3 * 3_600_000)];
      expect(personProfile(session({ timeZone: "America/New_York" }), events).hour).toBe(14);
      expect(personProfile(session(), events).hour).toBeUndefined();
    });
  });

  it("keeps a saved field the thread no longer reaches, and lets what it shows now win", () => {
    const saved = session({ profile: { channel: "call", hour: 9 } });
    const now = withProfile(saved, [system("call_declined", "declined")]);
    expect(now.profile).toEqual({ channel: "text", hour: 9 });
  });

  it("says it in one short line, naming only a language other than english", () => {
    expect(profileLine({ channel: "text", lang: "es", length: "short", tone: "casual", pace: "quick", hour: 23 })).toBe(
      "person: prefers text, writes in spanish, short casual texts, replies fast, usually texts around 11 pm",
    );
    expect(profileLine({ channel: "call", tone: "plain", pace: "slow", hour: 0 })).toBe(
      "person: likes calls, plain texts, replies slowly, usually texts around 12 am",
    );
    expect(profileLine({ lang: "en" })).toBeNull();
  });
});
