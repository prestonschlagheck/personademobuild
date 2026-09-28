import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session, type SessionEvent, type Snapshot } from "@/lib/session/schema";
import { CUT_OFF } from "@/lib/agent/messages";
import { DIAG_CAP, voiceDiag } from "@/lib/client/dev-trace";
import { callView } from "@/lib/voice/call-state";
import { CallController } from "@/lib/voice/controller";
import { valueNote } from "@/lib/voice/notes";
import type { CallNote, ServerEvent, TransportHandlers } from "@/lib/voice/transport";

// The transport is faked so each test can play Realtime's events in the exact order it wants.
const fake = vi.hoisted(() => ({
  handlers: null as TransportHandlers | null,
  notes: [] as CallNote[],
  outputs: [] as [string, unknown][],
  mics: [] as MediaStream[],
  sounds: [] as string[],
  /** How the transport's start behaves; by default the line is up at once. */
  start: (async () => undefined) as (connection: unknown, session: unknown, live?: () => void) => Promise<void>,
}));
// The live transport is the same fake, so a live call's own record (its diag codes) can be tested too.
const fakeTransport = vi.hoisted(() => (handlers: TransportHandlers) => {
  fake.handlers = handlers;
  return {
    offer: async () => undefined,
    start: (connection: unknown, session: unknown, live?: () => void) => fake.start(connection, session, live),
    sendToolOutput: (callId: string, output: unknown) => void fake.outputs.push([callId, output]),
    sendNote: (note: CallNote) => void fake.notes.push(note),
    sendUserText: () => undefined,
    setMuted: () => undefined,
    setVolume: () => undefined,
    replaceMic: async (mic: MediaStream) => void fake.mics.push(mic),
    resume: () => undefined,
    agentLevel: () => 0,
    close: () => undefined,
  };
});
vi.mock("@/lib/voice/mock", () => ({ primeSpeech: () => undefined, createMockTransport: fakeTransport }));
vi.mock("@/lib/voice/webrtc", () => ({ createWebRtcTransport: (_mic: MediaStream, handlers: TransportHandlers) => fakeTransport(handlers) }));
vi.mock("@/lib/voice/audio-level", () => ({
  meterStream: () => ({ read: () => 0, close: () => undefined }),
  speechEnvelope: () => {
    let speaking = false;
    return { setSpeaking: (on: boolean) => void (speaking = on), accent: () => undefined, read: () => (speaking ? 0.5 : 0) };
  },
}));
vi.mock("@/lib/client/sounds", () => ({
  sounds: {
    play: (cue: string) => void fake.sounds.push(cue),
    stopRing: () => void fake.sounds.push("stop_ring"),
    unlock: () => void fake.sounds.push("unlock"),
  },
}));

const NOW = "2026-09-27T01:00:00.000Z";
const MISSED_AFTER_MS = 25_000;

function snapshotOf(sessionId: string, call?: Snapshot["session"]["call"]): Snapshot {
  const session = newSession(sessionId, NOW);
  return {
    session: call ? { ...session, version: call.attempts, call } : session,
    events: [],
    lastSeq: 0,
    modes: { text: "mock", voice: "mock", gmail: "mock", store: "memory" },
  };
}

const ringing = (sessionId: string, attempts: number, initiator: "agent" | "user" = "agent") =>
  snapshotOf(sessionId, { status: "ringing", attempts, initiator, ringingAt: NOW });

// Enough of a mic for the controller: one audio track the device can end.
class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = "live";
  muted = false;
  enabled = true;
  stop() {
    this.readyState = "ended";
  }
  /** Ended by the device, not by us: another app took the mic, or the headset was unplugged. */
  lose() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

function fakeMic() {
  const track = new FakeTrack();
  return { track, stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream };
}

const posted = (fetchMock: { mock: { calls: [string, RequestInit?][] } }) =>
  fetchMock.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body ?? "null"))]);

describe("CallController", () => {
  const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(() => new Promise(() => {}));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockClear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts each session's call bookkeeping fresh, even across the null a reset publishes", () => {
    const controller = new CallController(() => {});
    const first = ringing("s1", 1);
    controller.sync(first);
    expect(callView(first.session, controller.getState()).screen).toBe("incoming");
    controller.decline("decline");
    expect(callView(first.session, controller.getState()).screen).toBe("none");

    controller.sync(null);
    const second = ringing("s2", 1);
    controller.sync(second);
    expect(callView(second.session, controller.getState()).screen).toBe("incoming");

    // The new ring times out on its own clock rather than being mistaken for the declined one.
    vi.advanceTimersByTime(MISSED_AFTER_MS);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/call/decline",
      expect.objectContaining({ body: JSON.stringify({ attempt: 1, action: "missed" }) }),
    );
  });

  it("never picks up a ring the user placed from another tab or before a reload", () => {
    const controller = new CallController(() => {});
    const placedElsewhere = ringing("s1", 1, "user");
    controller.sync(placedElsewhere);
    expect(controller.getState().phase).toBe("idle");
    expect(callView(placedElsewhere.session, controller.getState()).screen).toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("connects the ring it dialed, and ends it through the end route even before the accept answers", async () => {
    const controller = new CallController(() => {});
    controller.sync(snapshotOf("s1"));
    fetchMock.mockImplementationOnce(async () => Response.json(ringing("s1", 1, "user")));
    controller.dial();
    await vi.waitFor(() => expect(controller.getState().phase).toBe("connecting"));
    expect(controller.getState().initiator).toBe("user");
    // The accept goes out at once; the "calling" floor runs beside it rather than ahead of it.
    await vi.waitFor(() => expect(posted(fetchMock).map(([path]) => path)).toContain("/api/call/accept"));

    controller.hangUp();
    // The ring is pinged from the moment it is answered, so a slow mic prompt never lets it ring out.
    expect(posted(fetchMock)).toEqual([
      ["/api/call/start", { initiator: "user" }],
      ["/api/call/heartbeat", { attempt: 1 }],
      ["/api/call/accept", { attempt: 1 }],
      ["/api/call/end", { attempt: 1, reason: "user_hangup" }],
    ]);
  });
});

const MODES = { text: "mock", voice: "mock", gmail: "mock", store: "memory" } as const;

function onCallSnapshot(version: number, patch: Partial<Session> = {}, events: SessionEvent[] = []): Snapshot {
  const session: Session = {
    ...newSession("s1", NOW),
    agentName: { value: "Buddy", source: "text", setAt: NOW },
    call: { status: "active", attempts: 1, initiator: "agent", ringingAt: NOW, startedAt: NOW },
    ...patch,
    version,
  };
  return { session, events, lastSeq: events.at(-1)?.seq ?? 0, modes: MODES };
}

describe("CallController on a call", () => {
  const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
  const bodies = (path: string) => fetchMock.mock.calls.filter(([p]) => p === path).map(([, init]) => JSON.parse(String(init?.body ?? "null")));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fake.handlers = null;
    fake.notes = [];
    fake.outputs = [];
    fake.sounds = [];
    fake.start = async () => undefined;
    fetchMock.mockImplementation(async (path) => {
      if (path === "/api/call/accept") return Response.json({ ...onCallSnapshot(2), connection: { mode: "mock", callId: "mock_1" } });
      if (path === "/api/tool") return Response.json({ ...onCallSnapshot(3), output: { ok: true, state: "" } });
      if (path === "/api/call/end") return Response.json(onCallSnapshot(4, { call: { status: "ended", attempts: 1 } }));
      return new Response(null, { status: 204 });
    });
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function answer() {
    const controller = new CallController(() => {});
    controller.sync(ringing("s1", 1));
    controller.accept();
    await vi.waitFor(() => expect(controller.getState().phase).toBe("active"));
    const handlers = fake.handlers;
    if (!handlers) throw new Error("no transport");
    const emit = (...events: ServerEvent[]) => events.forEach((event) => handlers.onEvent(event));
    return { controller, emit };
  }

  it("starts the page's audio on the answering tap, and shows the call live with its cue before the agent speaks", async () => {
    let live: (() => void) | undefined;
    fake.start = (_connection, _session, onLive) => {
      live = onLive;
      return new Promise(() => {});
    };
    const controller = new CallController(() => {});
    controller.sync(ringing("s1", 1));
    controller.accept();
    expect(fake.sounds).toEqual(["unlock", "stop_ring"]);
    await vi.waitFor(() => expect(live).toBeDefined());
    expect(controller.getState().phase).toBe("connecting");
    live?.();
    expect(controller.getState().phase).toBe("active");
    expect(fake.sounds.at(-1)).toBe("connect");
  });

  it("keeps the island waveform moving while the agent talks, even when its audio meter reads silence", async () => {
    const { controller, emit } = await answer();
    expect(controller.level()).toBe(0);
    emit({ type: "output_audio_buffer.started" });
    expect(controller.level()).toBeGreaterThan(0);
    emit({ type: "output_audio_buffer.stopped" });
    expect(controller.level()).toBe(0);
  });

  const GOODBYE = "you're all set, preston. i'll text you a quick recap.";
  const goodbyeResponse: ServerEvent[] = [
    { type: "response.created" },
    { type: "response.output_audio_transcript.delta", item_id: "bye", delta: GOODBYE },
    { type: "response.output_audio_transcript.done", item_id: "bye", transcript: GOODBYE },
    { type: "response.function_call_arguments.done", call_id: "c1", name: "end_call", arguments: JSON.stringify({ reason: "done" }) },
  ];

  it("lets a goodbye whose audio starts after the response is done play out before hanging up", async () => {
    const { emit } = await answer();
    emit(...goodbyeResponse, { type: "response.done" });
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies("/api/call/end")).toEqual([]);

    emit({ type: "output_audio_buffer.started" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(bodies("/api/call/end")).toEqual([]);
    emit({ type: "output_audio_buffer.stopped" });
    await vi.waitFor(() => expect(bodies("/api/call/end")).toEqual([{ attempt: 1, reason: "agent_end" }]));
  });

  it("hangs up at once when the goodbye already played, as the mock transport orders it", async () => {
    const { emit } = await answer();
    emit(
      { type: "response.created" },
      { type: "output_audio_buffer.started" },
      { type: "response.output_audio_transcript.delta", item_id: "bye", delta: GOODBYE },
      { type: "output_audio_buffer.stopped" },
      { type: "response.output_audio_transcript.done", item_id: "bye", transcript: GOODBYE },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "end_call", arguments: JSON.stringify({ reason: "done" }) },
    );
    expect(bodies("/api/call/end")).toEqual([]);
    emit({ type: "response.done" });
    // The goodbye is saved first, so the end is judged knowing it was said.
    expect(bodies("/api/call/transcript").map(({ text }) => text)).toEqual([GOODBYE]);
    await vi.waitFor(() => expect(bodies("/api/call/end")).toEqual([{ attempt: 1, reason: "agent_end" }]));
  });

  it("saves the agent's lines once they are heard, as far as the voice got, and never one that never played", async () => {
    const { emit } = await answer();
    const saved = () => bodies("/api/call/transcript").map(({ role, text }) => [role, text]);
    emit(
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "okay." },
      { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "okay." },
      { type: "response.output_audio_transcript.delta", item_id: "a2", delta: "hey, it's Buddy again. what should i call you?" },
      { type: "response.output_audio_transcript.done", item_id: "a2", transcript: "hey, it's Buddy again. what should i call you?" },
      { type: "response.done" },
    );
    // Generated is not said: nothing is saved before the audio plays.
    expect(saved()).toEqual([]);
    emit({ type: "output_audio_buffer.started" });
    await vi.advanceTimersByTimeAsync(600);
    expect(saved()).toEqual([["agent", "okay."]]);

    // They talk over the second line: it is cut where the voice was, and their words save after it.
    emit({ type: "input_audio_buffer.speech_started", item_id: "u1" }, { type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "wait, what?" });
    expect(saved()).toEqual([["agent", "okay."]]);
    emit({ type: "output_audio_buffer.cleared" });
    expect(saved()).toEqual([
      ["agent", "okay."],
      ["agent", "hey, it's..."],
      ["user", "wait, what?"],
    ]);

    // A reply cancelled before any of it played is never saved or shown.
    emit(
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", item_id: "a3", delta: "sure, go" },
      { type: "response.done", response: { status: "cancelled" } },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(saved()).toHaveLength(3);
  });

  it("shows the agent's words live cleaned up the way the saved line is", async () => {
    const { controller, emit } = await answer();
    const line = "Okay, fun. I have mine already\u2014Persona. And you\u2019re?";
    emit(
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", item_id: "a1", delta: line },
      { type: "response.output_audio_transcript.done", item_id: "a1", transcript: line },
      { type: "output_audio_buffer.started" },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.getCaptions()).toEqual([{ id: "a1", role: "agent", text: "okay, fun. i have mine already, persona. and you're?" }]);
  });

  it("answers an end_call with nothing said in its response itself, and the call goes on", async () => {
    const { controller, emit } = await answer();
    emit(
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "end_call", arguments: JSON.stringify({ reason: "done" }) },
      { type: "response.done" },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bodies("/api/tool")).toEqual([]);
    expect(fake.outputs).toEqual([["c1", expect.objectContaining({ ok: false, error: "say_goodbye_first" })]]);
    expect(bodies("/api/call/end")).toEqual([]);
    expect(controller.getState().phase).toBe("active");
  });

  const silentEnd = (callId: string): ServerEvent[] => [
    { type: "response.created" },
    { type: "response.function_call_arguments.done", call_id: callId, name: "end_call", arguments: JSON.stringify({ reason: "user_request" }) },
    { type: "response.done" },
  ];

  it("lets a wordless end_call through once they asked to hang up, and the call ends", async () => {
    const { emit } = await answer();
    emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "Hang up now." });
    emit(...silentEnd("c1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies("/api/tool")).toEqual([{ attempt: 1, toolCallId: "c1", name: "end_call", args: { reason: "user_request" } }]);
    expect(fake.outputs).toEqual([["c1", { ok: true, state: "" }]]);
    await vi.waitFor(() => expect(bodies("/api/call/end")).toEqual([{ attempt: 1, reason: "agent_end" }]));
  });

  it("sends a wordless end_call back after a plain goodbye, so the goodbye gets said", async () => {
    const { emit } = await answer();
    emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "nice, that's it for now" });
    emit(...silentEnd("c1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies("/api/tool")).toEqual([]);
    expect(fake.outputs).toEqual([["c1", expect.objectContaining({ error: "say_goodbye_first" })]]);
  });

  it("sends a wordless end_call back once, and lets the second in a row through", async () => {
    const { controller, emit } = await answer();
    emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "what can you do?" });
    emit(...silentEnd("c1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies("/api/tool")).toEqual([]);
    expect(fake.outputs).toEqual([["c1", expect.objectContaining({ error: "say_goodbye_first" })]]);
    expect(controller.getState().phase).toBe("active");

    emit(...silentEnd("c2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies("/api/tool").map((b) => b.toolCallId)).toEqual(["c2"]);
    await vi.waitFor(() => expect(bodies("/api/call/end")).toEqual([{ attempt: 1, reason: "agent_end" }]));
  });

  it("sends a wordless end_call back again once they've spoken since the last one", async () => {
    const { emit } = await answer();
    emit(...silentEnd("c1"));
    emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "wait, one more thing" });
    emit(...silentEnd("c2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies("/api/tool")).toEqual([]);
    expect(fake.outputs.map(([id]) => id)).toEqual(["c1", "c2"]);
  });

  it("tells the call once when gmail connects on it: what else was granted, and no calendar or drive details", async () => {
    const { controller } = await answer();
    const gmail: Session["gmail"] = {
      status: "connected",
      email: "p@gmail.com",
      connectedAt: "2026-09-27T01:00:30.000Z",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/drive.metadata.readonly"],
      valueFact: "you've got 11 unread. want me to flag mail from real people?",
      calendarFact: "20+ events on your calendar this week.",
      driveFact: "7 folders at the top of your drive.",
    };
    const snapshot = onCallSnapshot(5, { gmail });
    controller.sync(snapshot);
    const values = () => fake.notes.filter((n) => n.note === "value_moment");
    expect(values()).toEqual([valueNote(snapshot.session)]);
    expect(values()[0]).toEqual({ note: "value_moment", extras: "calendar and drive" });

    const row: SessionEvent = { seq: 1, id: "v1", at: NOW, channel: "text", role: "agent", content: "gmail's connected.", meta: { kind: "value_moment" } };
    controller.sync(onCallSnapshot(6, { gmail }, [row]));
    expect(values()).toHaveLength(1);
  });

  it("keeps the line open when the server refuses a hangup before they've said anything", async () => {
    fetchMock.mockImplementation(async (path) => {
      if (path === "/api/call/accept") return Response.json({ ...onCallSnapshot(2), connection: { mode: "mock", callId: "mock_1" } });
      if (path === "/api/tool") return Response.json({ ...onCallSnapshot(3), output: { ok: false, error: "call_just_started", state: "" } });
      return new Response(null, { status: 204 });
    });
    const { controller, emit } = await answer();
    emit(...goodbyeResponse, { type: "output_audio_buffer.started" }, { type: "response.done" });
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: "output_audio_buffer.stopped" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bodies("/api/call/end")).toEqual([]);
    expect(fake.outputs).toEqual([["c1", expect.objectContaining({ error: "call_just_started" })]]);
    expect(controller.getState().phase).toBe("active");
  });

  it("caps the wait a few seconds past the goodbye's length when the audio never reports stopping", async () => {
    const { emit } = await answer();
    emit(...goodbyeResponse, { type: "output_audio_buffer.started" }, { type: "response.done" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(bodies("/api/call/end")).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(bodies("/api/call/end")).toEqual([{ attempt: 1, reason: "agent_end" }]);
  });

  it("saves both sides' unfinished words as cut off before reporting a hangup", async () => {
    const { controller, emit } = await answer();
    // Only what the caller heard counts: the caption keeps pace with the voice (lib/voice/caption-pace.ts).
    emit({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "so what could i take off" }, { type: "output_audio_buffer.started" });
    await vi.advanceTimersByTimeAsync(3_000);
    emit({ type: "input_audio_buffer.speech_started" });
    controller.hangUp();
    const saved = bodies("/api/call/transcript").map(({ role, text }) => [role, text]);
    expect(saved).toEqual([
      ["agent", `so what could i take off... ${CUT_OFF}`],
      ["user", CUT_OFF],
    ]);
    await vi.waitFor(() => expect(bodies("/api/call/end")).toEqual([{ attempt: 1, reason: "user_hangup" }]));
  });

  it("gives the call a rename by text before the text that asked for it, and pushes texts into the call", async () => {
    const { controller } = await answer();
    const text: SessionEvent = { seq: 1, id: "t1", at: NOW, channel: "text", role: "user", content: "actually call yourself max", meta: { kind: "chat" } };
    controller.sync(onCallSnapshot(5, { agentName: { value: "Max", source: "text", setAt: NOW } }, [text]));
    expect(fake.notes).toEqual([
      { note: "renamed", text: "Max" },
      { note: "user_texted", text: "actually call yourself max" },
    ]);

    // A rename the call made itself needs no note.
    controller.sync(onCallSnapshot(6, { agentName: { value: "Jo", source: "voice", setAt: NOW } }, [text]));
    expect(fake.notes).toHaveLength(2);
  });

  it("hands a text sent mid-call to the call only once its own turn has answered, saying what that turn saved", async () => {
    const { controller } = await answer();
    // Sent after the agent was named, so the name set before it is not this text's turn.
    const SENT = "2026-09-27T01:00:05.000Z";
    const texts = () => fake.notes.filter((n) => n.note === "user_texted");
    const row = (seq: number, role: "user" | "agent", content: string): SessionEvent => ({ seq, id: `t${seq}`, at: SENT, channel: "text", role, content, meta: { kind: "chat" } });
    const texted = row(1, "user", "it's preston, texting because loud here");
    controller.sync(onCallSnapshot(5, {}, [texted]));
    // Its turn is still running: the call would answer first and save the name itself, as said on the call.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts()).toEqual([]);

    const preston = { value: "Preston", source: "text" as const, setAt: SENT };
    controller.sync(onCallSnapshot(6, { userName: preston }, [texted, row(2, "agent", "got it, preston.")]));
    expect(texts()).toEqual([{ note: "user_texted", text: "it's preston, texting because loud here", saved: ["userName"] }]);

    // A turn that answered without saving anything (a fallback) still lets the text through, with nothing claimed.
    const next = { ...row(3, "user", "hmm"), at: "2026-09-27T01:00:09.000Z" };
    controller.sync(onCallSnapshot(7, { userName: preston }, [texted, row(2, "agent", "got it, preston."), next]));
    expect(texts()).toHaveLength(1);
    controller.sync(onCallSnapshot(8, { userName: preston }, [next, row(4, "agent", "not sure i follow.")]));
    expect(texts().at(-1)).toEqual({ note: "user_texted", text: "hmm" });
  });

  it("waits about 4 s at most for a text's turn before the call hears it", async () => {
    const { controller } = await answer();
    const texted: SessionEvent = { seq: 1, id: "t1", at: "2026-09-27T01:00:05.000Z", channel: "text", role: "user", content: "still there?", meta: { kind: "chat" } };
    const texts = () => fake.notes.filter((n) => n.note === "user_texted");
    controller.sync(onCallSnapshot(5, {}, [texted]));
    await vi.advanceTimersByTimeAsync(3_900);
    expect(texts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(texts()).toEqual([{ note: "user_texted", text: "still there?" }]);
  });
});

// Each route answers from its own queue, then falls back to what a healthy server says.
type Reply = number | "network" | { status: number; error: string };

describe("CallController when requests fail", () => {
  const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
  const bodies = (path: string) => fetchMock.mock.calls.filter(([p]) => p === path).map(([, init]) => JSON.parse(String(init?.body ?? "null")));
  let replies: Record<string, Reply[]> = {};
  let modes: Snapshot["modes"] = MODES;

  const respond = (reply: Reply) => {
    if (reply === "network") return Promise.reject(new TypeError("fetch failed"));
    if (typeof reply === "number") return Promise.resolve(new Response(null, { status: reply }));
    return Promise.resolve(Response.json({ error: reply.error }, { status: reply.status }));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fake.handlers = null;
    replies = {};
    modes = MODES;
    fetchMock.mockImplementation(async (path) => {
      const queued = replies[path]?.shift();
      if (queued !== undefined) return respond(queued);
      if (path === "/api/call/start") return Response.json({ ...ringing("s1", 1, "user"), modes });
      if (path === "/api/call/accept") return Response.json({ ...onCallSnapshot(2), modes, connection: { mode: "mock", callId: "mock_1" } });
      if (path === "/api/call/end") return Response.json({ ...onCallSnapshot(4, { call: { status: "ended", attempts: 1 } }), modes });
      return new Response(null, { status: 204 });
    });
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function answer() {
    const controller = new CallController(() => {});
    controller.sync({ ...ringing("s1", 1), modes });
    controller.accept();
    await vi.waitFor(() => expect(controller.getState().phase).toBe("active"));
    return controller;
  }

  it("retries a failed end with backoff, by attempt, until it lands", async () => {
    const controller = await answer();
    replies["/api/call/end"] = ["network", { status: 500, error: "internal_error" }];
    controller.hangUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies("/api/call/end")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(bodies("/api/call/end")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bodies("/api/call/end")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(bodies("/api/call/end")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(bodies("/api/call/end")).toEqual([
      { attempt: 1, reason: "user_hangup" },
      { attempt: 1, reason: "user_hangup" },
      { attempt: 1, reason: "user_hangup" },
    ]);
    // Landed, so nothing more goes out, not even when an older poll still shows the call live.
    await vi.advanceTimersByTimeAsync(10_000);
    controller.sync(onCallSnapshot(3));
    expect(bodies("/api/call/end")).toHaveLength(3);
  });

  it("gives up after three retries, then ends the call again when a poll still shows it live, never as another tab's", async () => {
    const controller = await answer();
    replies["/api/call/end"] = Array(4).fill("network");
    controller.hangUp();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bodies("/api/call/end")).toHaveLength(4);
    expect(controller.getState().phase).toBe("idle");

    const stillLive = onCallSnapshot(5);
    expect(callView(stillLive.session, controller.getState()).otherTab).toBe(false);
    controller.sync(stillLive);
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies("/api/call/end")).toEqual(Array(5).fill({ attempt: 1, reason: "user_hangup" }));
    // Settled: a later poll never sends it again.
    controller.sync(onCallSnapshot(6, { call: { status: "ended", attempts: 1 } }));
    controller.sync(onCallSnapshot(7));
    expect(bodies("/api/call/end")).toHaveLength(5);
  });

  it("keeps the call through a 429 or a failed ping, retrying at once, and lets go on a 409", async () => {
    const controller = await answer();
    const pings = () => bodies("/api/call/heartbeat").length;
    // Pinged from the answer on, before the accept went out.
    expect(fetchMock.mock.calls.map(([path]) => path).slice(0, 2)).toEqual(["/api/call/heartbeat", "/api/call/accept"]);
    expect(pings()).toBe(1);

    replies["/api/call/heartbeat"] = [{ status: 429, error: "rate_limited" }, "network", "network", { status: 409, error: "call_not_active" }];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pings()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings()).toBe(3);
    expect(controller.getState().phase).toBe("active");
    // A failed retry waits for the next beat instead of retrying again.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pings()).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings()).toBe(4);
    expect(controller.getState().phase).toBe("active");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings()).toBe(5);
    expect(controller.getState().phase).toBe("ended");
    expect(bodies("/api/call/end")).toEqual([]);
  });

  it.each([
    ["NotFoundError", "missing", "mic_missing"],
    ["NotReadableError", "busy", "mic_busy"],
    ["NotAllowedError", "blocked", "mic_denied"],
  ])("reports a mic that fails with %s as %s, ending with %s", async (name, failure, reason) => {
    modes = { ...MODES, voice: "live" };
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("", name)));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const controller = new CallController(() => {});
    controller.sync({ ...ringing("s1", 1), modes });
    controller.accept();
    // Only a busy mic is asked for again, in case the app holding it lets go.
    if (failure === "busy") await vi.advanceTimersByTimeAsync(2_500);
    expect(getUserMedia).toHaveBeenCalledTimes(failure === "busy" ? 4 : 1);
    await vi.waitFor(() => expect(controller.getState().phase).toBe("ended"));
    expect(controller.getState().failure).toBe(failure);
    expect(bodies("/api/call/end")).toEqual([{ attempt: 1, reason }]);
    expect(bodies("/api/call/accept")).toEqual([]);
  });

  it.each([
    [{ status: 409, error: "call_ringing" }, "ringing"],
    [{ status: 409, error: "call_active" }, "elsewhere"],
    [{ status: 429, error: "rate_limited" }, "rate_limited"],
    ["network" as const, "failed"],
  ])("shows a dial refused with %o as a failed call, %s, and never opens the mic", async (reply, failure) => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("", "NotAllowedError")));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    replies["/api/call/start"] = [reply];
    const controller = new CallController(() => {});
    const idle = snapshotOf("s1");
    controller.sync(idle);
    controller.dial();
    await vi.waitFor(() => expect(controller.getState().phase).toBe("ended"));
    expect(controller.getState()).toMatchObject({ initiator: "user", failure });
    expect(callView(idle.session, controller.getState())).toMatchObject({ screen: "ended", fullscreen: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/call/start"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getState()).toMatchObject({ phase: "idle", initiator: null, failure: null });
  });

  it("opens only one mic when two tabs dial at once", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("", "NotSupportedError")));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    // The first dial wins the ring on the server; the second arrives while it rings.
    fetchMock.mockImplementationOnce(async () => Response.json(ringing("s1", 1, "user")));
    replies["/api/call/start"] = [{ status: 409, error: "call_ringing" }];
    const first = new CallController(() => {});
    const second = new CallController(() => {});
    first.sync(snapshotOf("s1"));
    second.sync(snapshotOf("s1"));
    first.dial();
    second.dial();
    await vi.waitFor(() => expect(second.getState().phase).toBe("ended"));
    await vi.waitFor(() => expect(first.getState().phase).not.toBe("idle"));
    expect(first.getState()).toMatchObject({ initiator: "user", failure: null });
    expect(second.getState().failure).toBe("ringing");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("says who has the line when an answer is refused, and ends a ring nobody may take", async () => {
    replies["/api/call/accept"] = [{ status: 409, error: "call_in_other_tab" }];
    const taken = new CallController(() => {});
    taken.sync(ringing("s1", 1));
    taken.accept();
    await vi.waitFor(() => expect(taken.getState().phase).toBe("ended"));
    expect(taken.getState().failure).toBe("elsewhere");
    // The server already has the record, so nothing is reported, and the other tab's call shows once the hold ends.
    expect(bodies("/api/call/end")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callView(onCallSnapshot(3).session, taken.getState()).otherTab).toBe(true);

    replies["/api/call/accept"] = [{ status: 429, error: "rate_limited" }];
    const limited = new CallController(() => {});
    limited.sync(ringing("s2", 1));
    limited.accept();
    await vi.waitFor(() => expect(limited.getState().phase).toBe("ended"));
    expect(limited.getState().failure).toBe("rate_limited");
    expect(bodies("/api/call/end")).toEqual([{ attempt: 1, reason: "error" }]);
  });
  it("keeps the call when the device takes the mic away, and sends a new one in its place", async () => {
    const first = fakeMic();
    const second = fakeMic();
    const getUserMedia = vi.fn().mockRejectedValueOnce(new DOMException("", "NotReadableError"));
    getUserMedia.mockResolvedValueOnce(first.stream).mockRejectedValueOnce(new DOMException("", "NotReadableError"));
    getUserMedia.mockResolvedValueOnce(second.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    fake.mics = [];
    // Busy as the call is answered: asked again rather than failed, since the other app often lets go a moment later.
    const controller = new CallController(() => {});
    controller.sync({ ...ringing("s1", 1), modes });
    controller.accept();
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(controller.getState().phase).toBe("active"));
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    // Taken mid-call, and busy on the first try to open it again: the call carries on and the new mic goes out.
    first.track.lose();
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(fake.mics).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(getUserMedia).toHaveBeenCalledTimes(4);
    expect(fake.mics).toEqual([second.stream]);
    expect(controller.getState().phase).toBe("active");
    expect(bodies("/api/call/end")).toEqual([]);

    // Only a hangup ends it, and the mic it had by then is let go.
    controller.hangUp();
    expect(bodies("/api/call/end")).toEqual([{ attempt: 1, reason: "user_hangup" }]);
    expect(second.track.readyState).toBe("ended");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getUserMedia).toHaveBeenCalledTimes(4);
  });

});

describe("CallController's record of how a live call's replies went", () => {
  const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
  const bodies = (path: string) => fetchMock.mock.calls.filter(([p]) => p === path).map(([, init]) => JSON.parse(String(init?.body ?? "null")));
  const LIVE = { ...MODES, voice: "live" } as const;
  let failPing = false;
  // Each batch's codes, without the seconds each one is stamped with.
  const batches = () => bodies("/api/call/heartbeat").flatMap((b) => (b.diag ? [(b.diag as string[]).map((e) => e.replace(/^\d+\.\d:/, ""))] : []));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => fakeMic().stream) } });
    fake.handlers = null;
    fake.outputs = [];
    fake.start = async () => undefined;
    failPing = false;
    fetchMock.mockImplementation(async (path) => {
      if (path === "/api/call/heartbeat" && failPing) {
        failPing = false;
        throw new TypeError("fetch failed");
      }
      if (path === "/api/call/accept") return Response.json({ ...onCallSnapshot(2), modes: LIVE, connection: { mode: "live", sdp: "answer", callId: "rtc_1" } });
      if (path === "/api/call/end") return Response.json({ ...onCallSnapshot(4, { call: { status: "ended", attempts: 1 } }), modes: LIVE });
      return new Response(null, { status: 204 });
    });
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function answer(modes: Snapshot["modes"] = LIVE) {
    const controller = new CallController(() => {});
    controller.sync({ ...ringing("s1", 1), modes });
    controller.accept();
    await vi.waitFor(() => expect(controller.getState().phase).toBe("active"));
    const handlers = fake.handlers;
    if (!handlers) throw new Error("no transport");
    return { controller, handlers };
  }

  it("sends its codes with the next heartbeat once something went wrong, and the rest before the end", async () => {
    const { controller, handlers } = await answer();
    handlers.onDiag?.("done:completed:n1");
    await vi.advanceTimersByTimeAsync(5_000);
    // A reply that went as it should is no reason to send anything early.
    expect(batches()).toEqual([]);
    handlers.onDiag?.("done:failed:rate_limit_exceeded:n0");
    handlers.onDiag?.("dead_air:ask");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(batches()).toEqual([["done:completed:n1", "done:failed:rate_limit_exceeded:n0", "dead_air:ask"]]);
    expect(bodies("/api/call/heartbeat").at(-1)?.diag[0]).toMatch(/^\d+\.\d:done:completed:n1$/);

    // Another batch goes out early no sooner than 30 s after the last, so a call that keeps tripping never floods the
    // thread. A batch whose ping fails goes out with the retry a moment later.
    handlers.onDiag?.("error:rate_limit_exceeded:create");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(batches()).toHaveLength(1);
    failPing = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(batches()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(batches()).toHaveLength(3);
    expect(batches().at(-1)).toEqual(["error:rate_limit_exceeded:create"]);

    // Everything left goes before the end does, routine or not.
    handlers.onDiag?.("done:cancelled:turn_detected:n1");
    controller.hangUp();
    await vi.waitFor(() => expect(bodies("/api/call/end")).toEqual([{ attempt: 1, reason: "user_hangup" }]));
    expect(batches().at(-1)).toEqual(["done:cancelled:turn_detected:n1"]);
    const paths = fetchMock.mock.calls.map(([path]) => path);
    expect(paths.lastIndexOf("/api/call/heartbeat")).toBeLessThan(paths.indexOf("/api/call/end"));
  });

  it("records a wordless end_call it sends back, and never a word of the call", async () => {
    const { controller, handlers } = await answer();
    const emit = (...events: ServerEvent[]) => events.forEach((event) => handlers.onEvent(event));
    emit(
      { type: "input_audio_buffer.speech_started", item_id: "u1" },
      { type: "input_audio_buffer.speech_stopped", item_id: "u1" },
      { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "i need help booking an appointment" },
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "sure, preston" },
      { type: "response.done" },
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "end_call", arguments: JSON.stringify({ reason: "done" }) },
      { type: "response.done" },
    );
    handlers.onDiag?.("done:completed:n1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(batches()).toEqual([["silent_end_call", "done:completed:n1"]]);
    controller.hangUp();
    await vi.waitFor(() => expect(bodies("/api/call/end")).toHaveLength(1));
    expect(JSON.stringify(bodies("/api/call/heartbeat"))).not.toMatch(/appointment|preston|sure|booking/);
  });

  it("keeps no record of a mock call", async () => {
    const { controller, handlers } = await answer(MODES);
    handlers.onDiag?.("dead_air:ask");
    handlers.onEvent({ type: "response.created" });
    handlers.onEvent({ type: "response.function_call_arguments.done", call_id: "c1", name: "end_call", arguments: JSON.stringify({ reason: "done" }) });
    await vi.advanceTimersByTimeAsync(10_000);
    controller.hangUp();
    await vi.waitFor(() => expect(bodies("/api/call/end")).toHaveLength(1));
    expect(bodies("/api/call/heartbeat").every((b) => b.diag === undefined)).toBe(true);
  });

  it("caps a batch, counting what it had no room for, and keeps codes to plain identifiers", () => {
    let now = 0;
    const diag = voiceDiag(() => now);
    now = 12_345;
    diag.add("Error:Rate Limit, 'Preston'?");
    expect(diag.take(false)).toEqual(["12.3:error:rate_limit___preston__"]);
    now += 30_000;
    for (let i = 0; i < DIAG_CAP + 10; i++) diag.add("done:completed:n1");
    expect(diag.take(false)).toHaveLength(DIAG_CAP);
    now += 30_000;
    for (let i = 0; i < DIAG_CAP + 10; i++) diag.add("dead_air:ask");
    const batch = diag.take(false);
    expect(batch).toHaveLength(DIAG_CAP);
    expect(batch.at(-1)).toBe("72.3:lost:11");
    // Put back after a failed ping: still capped, the oldest kept.
    diag.add("carry_on");
    diag.restore(batch);
    const again = diag.take(false);
    expect(again).toHaveLength(DIAG_CAP);
    expect(again[0]).toBe(batch[0]);
  });

  it("sends a reply that came back empty early, but not one that went as it should", () => {
    let now = 0;
    const diag = voiceDiag(() => now);
    diag.add("done:completed:n1");
    diag.add("done:cancelled:client_cancelled:n1");
    expect(diag.take(false)).toEqual([]);
    diag.add("done:completed:n0");
    expect(diag.take(false)).toEqual(["0.0:done:completed:n1", "0.0:done:cancelled:client_cancelled:n1", "0.0:done:completed:n0"]);
    // Something wrong right after a batch waits for the next one, unless the call ends first.
    now = 1_000;
    diag.add("dead_air:ask");
    expect(diag.take(false)).toEqual([]);
    expect(diag.take(true)).toEqual(["1.0:dead_air:ask"]);
  });
});
