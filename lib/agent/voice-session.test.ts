import { afterEach, describe, expect, it, vi } from "vitest";
import { newSession, type SessionEvent } from "@/lib/session/schema";

vi.mock("server-only", () => ({}));

const { buildVoiceSession, liveTurnDetection, priorConversation } = await import("@/lib/agent/voice-session");

const NOW = "2026-09-27T20:00:00.000Z";
let seq = 0;
const row = (content: string, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  seq: ++seq,
  id: `e${seq}`,
  at: NOW,
  channel: "text",
  role: "user",
  content,
  ...extra,
});

describe("a call's view of the conversation", () => {
  const session = { ...newSession("s1", NOW), call: { status: "active" as const, attempts: 2 } };

  it("opens knowing the text thread and earlier calls, oldest first", () => {
    const events = [
      row("i need to cancel my gym"),
      row("got it, first on my list.", { role: "agent" }),
      row("my name is dana", { channel: "voice", meta: { kind: "transcript", callAttempt: 1 } }),
    ];
    const context = priorConversation(session, events);
    expect(context).toContain("them: i need to cancel my gym\nyou: got it, first on my list.\nthem (on an earlier call): my name is dana");
    expect(buildVoiceSession(session, events).instructions).toContain("## the conversation so far");
  });

  it("leaves out this call's own words, reactions and tool records", () => {
    const events = [
      row("hello there", { channel: "voice", meta: { kind: "transcript", callAttempt: 2 } }),
      row("Loved", { meta: { kind: "reaction" } }),
      row("set_agent_name", { role: "tool", meta: { kind: "tool_call" } }),
    ];
    expect(priorConversation(session, events)).toBeNull();
    expect(buildVoiceSession(session, events).instructions).not.toContain("## the conversation so far");
  });
});

describe("the latest texts a call opens on", () => {
  const session = { ...newSession("s1", NOW), call: { status: "active" as const, attempts: 1 } };
  const need = { value: "my rent bill", source: "text" as const, setAt: NOW, category: "bills" as const };

  it("leads with a text that raises a topic, as somewhere to start", () => {
    const context = priorConversation(session, [row("hey"), row("can you look at my rent bill")]);
    expect(context).toContain('their latest texts, newest last: "hey", "can you look at my rent bill". if one raises something they want to talk about or get help with, start there');
    expect(context).not.toContain("picks up");
    expect(priorConversation(session, [row("call me to talk about my bills")])).toContain("their latest texts");
  });

  it("leaves out texts that only ask for the call, and leads with nothing when that is all there is", () => {
    for (const ask of ["call me", "Call me now!", "ok call me back", "ring me", "can you call me?", "call me to set up", "call me to setup", "call me back pls"]) {
      expect(priorConversation(session, [row(ask)]), ask).not.toContain("their latest texts");
    }
    expect(priorConversation(session, [row("call me"), row("it's about my gym")])).toContain('their latest texts, newest last: "it\'s about my gym".');
  });

  it("leads with nothing once a need is saved, since that is what the call is about", () => {
    const context = priorConversation({ ...session, helpNeed: need }, [row("can you look at my rent bill")]);
    expect(context).toContain("them: can you look at my rent bill");
    expect(context).not.toContain("their latest texts");
  });
});

describe("stock phrases the thread already used", () => {
  it("are named in the call's instructions, so the call never says them again", () => {
    const session = { ...newSession("s1", NOW), call: { status: "active" as const, attempts: 1 } };
    const events = [row("Buddy it is. save my contact card so you'll know it's me when i call.", { role: "agent" })];
    expect(buildVoiceSession(session, events).instructions).toContain('never say them on this call: "(a name) it is"');
    expect(buildVoiceSession(session, [row("buddy")]).instructions).not.toContain("## already said");
  });
});

describe("the person card", () => {
  it("goes in the call's instructions once, from the thread as the call starts", () => {
    const session = { ...newSession("s1", NOW), call: { status: "active" as const, attempts: 1 }, profile: { channel: "text" as const } };
    const events = [row("hey", { meta: { kind: "chat" } }), row("sure", { meta: { kind: "chat" } }), row("", { channel: "system", role: "system", content: "Calling", meta: { kind: "call_ringing" } })];
    const { instructions } = buildVoiceSession(session, events);
    expect(instructions).toContain("\n\nperson: likes calls, short casual texts");
    expect(instructions.match(/person:/g)).toHaveLength(1);
    expect(buildVoiceSession(newSession("s1", NOW)).instructions).not.toContain("person:");
  });
});

describe("turn detection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("leaves every answer and every cut-off to the browser, which can tell an echo from the caller", () => {
    vi.stubEnv("VOICE_TURN_DETECTION", "");
    const live = { type: "server_vad", threshold: 0.6, silence_duration_ms: 400, prefix_padding_ms: 300, create_response: false, interrupt_response: false };
    expect(liveTurnDetection()).toEqual(live);
    expect(buildVoiceSession(newSession("s1", NOW)).audio.input.turn_detection).toEqual(live);
  });

  it("waits for the words to sound finished only when asked to", () => {
    vi.stubEnv("VOICE_TURN_DETECTION", "semantic");
    expect(liveTurnDetection()).toEqual({ type: "semantic_vad", eagerness: "auto", create_response: false, interrupt_response: false });
  });
});
