import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "@/lib/session/schema";
import type { ServerEvent } from "@/lib/voice/transport";
import { CHECK_IN_AT, CUT_OFF_NOTE, GOODBYE_AT, GOODBYE_AT_SIGNING_IN, HELLO_SAID_NOTE, UNSPOKEN_END_CALL } from "@/lib/voice/notes";
import { createWebRtcTransport, DEAD_AIR_NOTE, isEcho, opensWithHello, SAY_AGAIN_NOTE, TOOL_OWED_NOTE, UNHEARD_NOTE } from "@/lib/voice/webrtc";

// No AudioContext outside a browser; the meter only has to exist.
vi.mock("@/lib/voice/audio-level", () => ({ meterStream: () => ({ read: () => 0, db: () => -Infinity, close: () => undefined }) }));

const NOW = "2026-09-27T16:00:00.000Z";
const SILENCE_MS = 7_000;
// The opening's wait for the audio path, at its cap, and the settle after it.
const OPEN_WAIT_MS = 1_500;
const OPEN_SETTLE_MS = 300;
const ECHO_TAIL_MS = 600;
// "hey, it's Buddy." at about 60 ms a character.
const HELLO_SENTENCE_MS = 960;
// Their words with nothing heard back: asked once more at once when nothing is on its way, and a silent reply on its
// way is cancelled and asked once more at this.
const DEAD_AIR_MS = 5_000;
const STUCK_MS = 10_000;

type Sent = { type: string; event_id?: string; item_id?: string; item?: { role?: string; content?: { text: string }[] } };

class FakeChannel {
  readyState = "open";
  sent: Sent[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  addEventListener(type: string, listener: () => void) {
    if (type === "open") queueMicrotask(listener);
  }
  close() {}
}

class FakePeer extends EventTarget {
  static last: FakePeer | null = null;
  channel = new FakeChannel();
  connectionState = "connected";
  localDescription = { sdp: "offer" };
  ontrack: ((event: { track: FakeTrack; streams: object[] }) => void) | null = null;
  onconnectionstatechange = null;
  constructor() {
    super();
    FakePeer.last = this;
  }
  /** The agent's audio track arriving, silent until its first packets unmute it. */
  track(muted: boolean) {
    const track = new FakeTrack(muted);
    this.ontrack?.({ track, streams: [{}] });
    return track;
  }
  connect() {
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  createDataChannel() {
    return this.channel;
  }
  sender = { track: null as unknown, replaceTrack: async (track: unknown) => void (this.sender.track = track) };
  addTrack() {
    return this.sender;
  }
  async createOffer() {
    return { type: "offer", sdp: "offer" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
}

class FakeTrack extends EventTarget {
  constructor(public muted: boolean) {
    super();
  }
  unmute() {
    this.muted = false;
    this.dispatchEvent(new Event("unmute"));
  }
}

class FakeAudio {
  static last: FakeAudio | null = null;
  // iOS Safari: the page's volume is ignored and always reads 1.
  static fixedVolume = false;
  autoplay = false;
  srcObject = null;
  muted = false;
  private level = 1;
  constructor() {
    FakeAudio.last = this;
  }
  get volume() {
    return this.level;
  }
  set volume(next: number) {
    if (!FakeAudio.fixedVolume) this.level = next;
  }
  setAttribute() {}
  play() {
    return Promise.resolve();
  }
}

// No MediaStream exists outside a browser; the transport only reads its audio tracks.
const mic = { getAudioTracks: () => [] } as unknown as MediaStream;

describe("createWebRtcTransport", () => {
  let session: Session;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("Audio", FakeAudio);
    FakeAudio.fixedVolume = false;
    session = {
      ...newSession("s1", NOW),
      agentName: { value: "Buddy", source: "text", setAt: NOW },
      call: { status: "active", attempts: 1, startedAt: NOW },
      consent: { firstCallAt: NOW },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function connect(stream = mic) {
    const events: ServerEvent[] = [];
    // What the transport reports for the call's production record.
    const codes: string[] = [];
    const transport = createWebRtcTransport(
      stream,
      { onEvent: (e) => events.push(e), onConnectionState: () => undefined, onDiag: (code) => codes.push(code) },
      () => session,
    );
    await transport.offer();
    // No remote track ever arrives here, so the opening goes out at the cap.
    const started = transport.start({ mode: "live", sdp: "answer", callId: "rtc_1" }, session);
    await vi.advanceTimersByTimeAsync(OPEN_WAIT_MS);
    await started;
    const channel = FakePeer.last?.channel;
    if (!channel) throw new Error("no data channel");
    const server = (...batch: ServerEvent[]) => batch.forEach((event) => channel.onmessage?.({ data: JSON.stringify(event) }));
    // One whole spoken response, the way Realtime reports it over WebRTC.
    const speaks = () =>
      server({ type: "response.created" }, { type: "output_audio_buffer.started" }, { type: "response.done" }, { type: "output_audio_buffer.stopped" });
    // The opening, said in full, and the moment after it when its echo could still come back.
    const greets = async () => {
      server(
        { type: "response.created" },
        { type: "output_audio_buffer.started" },
        { type: "response.output_audio_transcript.delta", item_id: "hello", delta: "hey, it's Buddy. what should i call you?" },
        { type: "response.output_audio_transcript.done", item_id: "hello", transcript: "hey, it's Buddy. what should i call you?" },
        { type: "response.done" },
        { type: "output_audio_buffer.stopped" },
      );
      await vi.advanceTimersByTimeAsync(ECHO_TAIL_MS);
    };
    const said = () => channel.sent.flatMap((e) => (e.item?.role === "system" ? (e.item.content ?? []).map((c) => c.text) : []));
    const creates = () => channel.sent.filter((e) => e.type === "response.create").length;
    // The event_id of the last response.create, which an error the server sends for it carries back.
    const lastCreate = () => channel.sent.filter((e) => e.type === "response.create").at(-1)?.event_id;
    // Speech into silence, answered the moment it stops.
    const speech = (itemId: string) =>
      server({ type: "input_audio_buffer.speech_started", item_id: itemId }, { type: "input_audio_buffer.speech_stopped", item_id: itemId });
    const cancels = () => channel.sent.filter((e) => e.type === "response.cancel");
    return { transport, events, codes, channel, server, speaks, greets, said, creates, lastCreate, cancels, speech };
  }

  // A call past its hello, with the agent's next line playing.
  async function talking() {
    const call = await connect();
    await call.greets();
    call.server({ type: "response.created" }, { type: "output_audio_buffer.started" });
    call.server({ type: "response.output_audio_transcript.delta", item_id: "a2", delta: "got it. what should i call you?" });
    const audio = FakeAudio.last;
    if (!audio) throw new Error("no audio element");
    return { ...call, audio };
  }

  it("opens with the model's own hello, with no line handed to it, then the first missing piece", async () => {
    const { channel, said } = await connect();
    expect(said()[0]).toContain("introduce yourself once, in your own words: a quick hi and that you're Buddy.");
    expect(said()[0]).not.toMatch(/hey, it's|exactly/);
    expect(said()[0]).toContain("ask what to call them.");
    expect(said()[0]).not.toContain("sorry");
    expect(channel.sent.at(-1)).toMatchObject({ type: "response.create", event_id: expect.any(String) });
  });

  it("never cuts off the hello or says it twice, and answers once what they really said over it", async () => {
    const { channel, server, events } = await connect();
    const creates = () => channel.sent.filter((e) => e.type === "response.create").length;
    server({ type: "response.created" }, { type: "output_audio_buffer.started" });
    server({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "hey, it's Buddy. calling to get your name." });
    // Its own voice through the speaker, then a hello back: neither cuts it off or gets an answer of its own.
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" }, { type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "calling to get your name" });
    server({ type: "input_audio_buffer.speech_started", item_id: "u2" }, { type: "input_audio_buffer.speech_stopped", item_id: "u2" });
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "hello?" });
    server({ type: "response.done" });
    expect(channel.sent.some((e) => e.type === "response.cancel" || e.type === "output_audio_buffer.clear")).toBe(false);
    expect(events.some((e) => e.type === "conversation.item.input_audio_transcription.completed" && e.item_id === "u1")).toBe(false);
    server({ type: "output_audio_buffer.stopped" });
    expect(creates()).toBe(1);

    // Real words said over it get one answer, once its audio is done.
    const again = await connect();
    const count = () => again.channel.sent.filter((e) => e.type === "response.create").length;
    again.server({ type: "response.created" }, { type: "output_audio_buffer.started" });
    again.server({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "hey, it's Buddy. what should i call you?" });
    again.server({ type: "input_audio_buffer.speech_started", item_id: "u3" }, { type: "input_audio_buffer.speech_stopped", item_id: "u3" });
    again.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u3", transcript: "it's preston" });
    again.server({ type: "response.done" });
    expect(count()).toBe(1);
    again.server({ type: "output_audio_buffer.stopped" });
    expect(count()).toBe(2);
  });

  it("answers speech into silence at once", async () => {
    const { server, greets, creates } = await connect();
    await greets();
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" }, { type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    expect(creates()).toBe(2);
  });

  it("answers them knowing a text that landed while they were talking", async () => {
    const { transport, channel, server, greets } = await connect();
    await greets();
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    const before = channel.sent.length;
    transport.sendNote({ note: "user_texted", text: "eggs, milk, bread" });
    expect(channel.sent).toHaveLength(before);
    server({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    const tail = channel.sent.slice(-3);
    expect(tail.map((e) => e.type)).toEqual(["conversation.item.create", "conversation.item.create", "response.create"]);
    expect(tail[1]?.item?.content?.[0]?.text).toBe("eggs, milk, bread");
  });

  it("stops the agent the moment they speak over it, before their words are in, and answers the words", async () => {
    const { channel, server, audio, creates } = await talking();
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(channel.sent.slice(-2).map((e) => e.type)).toEqual(["response.cancel", "output_audio_buffer.clear"]);
    expect(audio.muted).toBe(true);
    server({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "wait, it's pres" });
    server({ type: "response.done", response: { status: "cancelled" } });
    expect(channel.sent.at(-1)).toMatchObject({ type: "response.create" });
    // The opening, then the one answer to their words.
    expect(creates()).toBe(2);
    server({ type: "output_audio_buffer.cleared" });
    expect(audio.muted).toBe(false);
  });

  it("carries on from where it stopped when what cut it off was its own echo", async () => {
    const { channel, server, said } = await talking();
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" }, { type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    server({ type: "response.done", response: { status: "cancelled" } }, { type: "output_audio_buffer.cleared" });
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "what should i call you" });
    expect(channel.sent).toContainEqual({ type: "conversation.item.delete", item_id: "u1" });
    expect(said().at(-1)).toBe(CUT_OFF_NOTE);
    expect(channel.sent.at(-1)).toMatchObject({ type: "response.create" });
  });

  it("carries on when no words arrive a moment after the sound that cut it off", async () => {
    const { channel, server, said } = await talking();
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" }, { type: "response.done", response: { status: "cancelled" } });
    await vi.advanceTimersByTimeAsync(5_000);
    server({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(said()).not.toContain(CUT_OFF_NOTE);
    await vi.advanceTimersByTimeAsync(1);
    expect(said().at(-1)).toBe(CUT_OFF_NOTE);
    expect(channel.sent.at(-1)).toMatchObject({ type: "response.create" });
  });

  it("never cuts off the hello, even through the audio still playing after it is generated", async () => {
    const { channel, server } = await connect();
    const audio = FakeAudio.last;
    server({ type: "response.created" }, { type: "output_audio_buffer.started" });
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    server({ type: "response.done" }, { type: "input_audio_buffer.speech_started", item_id: "u2" });
    expect(audio?.muted).toBe(false);
    expect(channel.sent.some((e) => e.type === "response.cancel" || e.type === "output_audio_buffer.clear")).toBe(false);
  });

  it("keeps the call volume the caller chose through a cut", async () => {
    const { transport, server, audio } = await talking();
    transport.setVolume(0.6);
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(audio.muted).toBe(true);
    expect(audio.volume).toBe(0.6);
    server({ type: "output_audio_buffer.cleared" });
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.6);
  });

  it("tells the agent's own words coming back from their own", () => {
    expect(isEcho("", "anything")).toBe(true);
    expect(isEcho("what should i call you", "got it. What should I call you?")).toBe(true);
    expect(isEcho("so i can start on your inbox for you", "calling to hook up gmail so i can start on your inbox for you today")).toBe(true);
    expect(isEcho("it's preston", "what should i call you?")).toBe(false);
    expect(isEcho("call me pres", "what should i call you?")).toBe(false);
  });

  it("never counts a mic the device took away as silence, and counts again once a new one goes out", async () => {
    const lost = { readyState: "ended", muted: false };
    const { transport, events, speaks } = await connect({ getAudioTracks: () => [lost] } as unknown as MediaStream);
    speaks();
    await vi.advanceTimersByTimeAsync(SILENCE_MS * GOODBYE_AT * 2);
    expect(events.filter((e) => e.type === "input_audio_buffer.timeout_triggered")).toEqual([]);

    const fresh = { readyState: "live", muted: false };
    await transport.replaceMic({ getAudioTracks: () => [fresh] } as unknown as MediaStream);
    expect(FakePeer.last?.sender.track).toBe(fresh);
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(events.filter((e) => e.type === "input_audio_buffer.timeout_triggered")).toHaveLength(1);
  });

  it("waits through silence, checks in once, then says goodbye at about 45 s and ends the call even if the model only says it", async () => {
    const { transport, events, channel, server, speaks, said } = await connect();
    speaks();
    const opening = said().length;
    await vi.advanceTimersByTimeAsync(SILENCE_MS * (CHECK_IN_AT - 1));
    expect(said()).toHaveLength(opening);
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(said().at(-1)).toContain("that there's no rush");
    expect(events.filter((e) => e.type === "input_audio_buffer.timeout_triggered")).toHaveLength(CHECK_IN_AT);

    speaks();
    const checkedIn = said().length;
    await vi.advanceTimersByTimeAsync(SILENCE_MS * (GOODBYE_AT - CHECK_IN_AT - 1));
    expect(said()).toHaveLength(checkedIn);
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(said().at(-1)).toContain("call end_call with reason silence");

    events.length = 0;
    server({ type: "response.created" }, { type: "output_audio_buffer.started" }, { type: "response.done" });
    const types = events.map((e) => e.type);
    expect(types.slice(-2)).toEqual(["response.function_call_arguments.done", "response.done"]);
    expect(events.at(-2)).toMatchObject({ name: "end_call", arguments: JSON.stringify({ reason: "silence" }) });

    // Nothing more is said while the goodbye plays out, and the transport's own end_call never reaches Realtime.
    const before = channel.sent.length;
    const endCall = events.at(-2);
    if (endCall?.type === "response.function_call_arguments.done") transport.sendToolOutput(endCall.call_id, { ok: true, state: "" });
    transport.sendNote({ note: "user_texted", text: "wait" });
    expect(channel.sent).toHaveLength(before);
  });

  it("waits quietly while google sign-in is open, then says goodbye", async () => {
    session = { ...session, gmail: { status: "link_sent", linkSentAt: NOW, openedAt: NOW } };
    const { speaks, said } = await connect();
    speaks();
    await vi.advanceTimersByTimeAsync(SILENCE_MS * CHECK_IN_AT);
    expect(said().at(-1)).toContain("signing in to google");
    speaks();
    const count = said().length;
    await vi.advanceTimersByTimeAsync(SILENCE_MS * (GOODBYE_AT_SIGNING_IN - CHECK_IN_AT - 1));
    expect(said()).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(said().at(-1)).toContain("call end_call with reason silence");
  });

  it("gives a link that was only sent the usual goodbye at about 45 s", async () => {
    session = { ...session, gmail: { status: "link_sent", linkSentAt: NOW } };
    const { speaks, said } = await connect();
    speaks();
    await vi.advanceTimersByTimeAsync(SILENCE_MS * CHECK_IN_AT);
    speaks();
    const count = said().length;
    await vi.advanceTimersByTimeAsync(SILENCE_MS * (GOODBYE_AT - CHECK_IN_AT - 1));
    expect(said()).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(said().at(-1)).toContain("call end_call with reason silence");
  });

  it("never says goodbye right after they spoke: their words restart the count", async () => {
    const { server, speaks, said } = await connect();
    speaks();
    await vi.advanceTimersByTimeAsync(SILENCE_MS * CHECK_IN_AT);
    speaks();
    await vi.advanceTimersByTimeAsync(SILENCE_MS * (GOODBYE_AT - CHECK_IN_AT - 1));
    server({ type: "input_audio_buffer.speech_started" }, { type: "input_audio_buffer.speech_stopped" });
    speaks();
    const count = said().length;
    // The next silence is the first again, so the goodbye is a whole check-in away.
    await vi.advanceTimersByTimeAsync(SILENCE_MS * (CHECK_IN_AT - 1));
    expect(said()).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(said().at(-1)).toContain("that there's no rush");
  });

  it("restarts the silence clock whenever they speak", async () => {
    const { server, speaks, said } = await connect();
    speaks();
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1_000);
    server({ type: "input_audio_buffer.speech_started" });
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(said()).toHaveLength(1);
  });

  it("ends the call when the model says goodbye back to theirs but forgets end_call", async () => {
    const { events, server, greets } = await connect();
    await greets();
    server(
      { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "perfect, that's everything for now. bye!" },
      { type: "response.created" },
      { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Bye, Preston. Talk soon." },
      { type: "response.done" },
    );
    expect(events.at(-2)).toMatchObject({ type: "response.function_call_arguments.done", name: "end_call", arguments: JSON.stringify({ reason: "user_request" }) });

    const other = await connect();
    await other.greets();
    other.server(
      { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "that's all i need" },
      { type: "response.created" },
      { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "got it. want me to text you the gmail link?" },
      { type: "response.done" },
    );
    expect(other.events.some((e) => e.type === "response.function_call_arguments.done")).toBe(false);
  });

  it("says nothing more once the model calls end_call itself", async () => {
    const { transport, events, channel, server } = await connect();
    server(
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "end_call", arguments: JSON.stringify({ reason: "done" }) },
      { type: "response.done" },
    );
    transport.sendToolOutput("c1", { ok: true, state: "" });
    const before = channel.sent.length;
    transport.sendNote({ note: "value_moment", text: "you've got 3 unread." });
    await vi.advanceTimersByTimeAsync(SILENCE_MS * 3);
    expect(channel.sent).toHaveLength(before);
    expect(events.filter((e) => e.type === "response.function_call_arguments.done")).toHaveLength(1);
  });

  it("takes a refused end_call back, so the model answers the refusal and the call goes on", async () => {
    const { transport, channel, server } = await connect();
    server(
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "end_call", arguments: JSON.stringify({ reason: "done" }) },
      { type: "response.done" },
    );
    transport.sendToolOutput("c1", UNSPOKEN_END_CALL);
    expect(channel.sent.at(-2)).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1" } });
    expect(channel.sent.at(-1)).toMatchObject({ type: "response.create" });
  });

  it("asks for the silence goodbye again after a silent end_call, and still ends the call if the model only says it", async () => {
    const { transport, events, server, speaks } = await connect();
    speaks();
    await vi.advanceTimersByTimeAsync(SILENCE_MS * CHECK_IN_AT);
    speaks();
    await vi.advanceTimersByTimeAsync(SILENCE_MS * (GOODBYE_AT - CHECK_IN_AT));

    events.length = 0;
    server(
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "end_call", arguments: JSON.stringify({ reason: "silence" }) },
      { type: "response.done" },
    );
    transport.sendToolOutput("c1", UNSPOKEN_END_CALL);
    // The refused response is not the goodbye, so the transport does not hang up on it.
    expect(events.filter((e) => e.type === "response.function_call_arguments.done")).toHaveLength(1);

    server({ type: "response.created" }, { type: "output_audio_buffer.started" }, { type: "response.done" });
    const hangups = events.filter((e) => e.type === "response.function_call_arguments.done");
    expect(hangups.at(-1)).toMatchObject({ name: "end_call", arguments: JSON.stringify({ reason: "silence" }) });
    expect(hangups).toHaveLength(2);
  });

  it("asks for no second response after one that spoke over its tools, unless a result needs an answer", async () => {
    const { transport, channel, server, greets } = await connect();
    await greets();
    const toolTurn = (callId: string, said: string) =>
      server(
        { type: "response.created" },
        ...(said ? [{ type: "response.output_audio_transcript.done" as const, item_id: `a_${callId}`, transcript: said }] : []),
        { type: "response.function_call_arguments.done", call_id: callId, name: "skip_slot", arguments: JSON.stringify({ slot: "userName" }) },
        { type: "response.done" },
      );

    toolTurn("c1", "no problem. what can i take off your plate?");
    transport.sendToolOutput("c1", { ok: true, state: "" });
    expect(channel.sent.at(-1)).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output" } });

    // The link it just said it sent needs no second telling, whatever the result hints.
    toolTurn("c2", "okay, i just sent you a link so you can connect gmail securely.");
    transport.sendToolOutput("c2", { ok: true, hint: "the link is in their messages now. say you just texted it", state: "" });
    expect(channel.sent.at(-1)).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output" } });

    // What a lookup found, and a refusal, still get their answer.
    toolTurn("c3", "one sec, checking.");
    transport.sendToolOutput("c3", { ok: true, result: "3 unread from delta", state: "" });
    expect(channel.sent.at(-1)).toMatchObject({ type: "response.create" });
    server({ type: "response.done" });
    toolTurn("c4", "sure, saving that.");
    transport.sendToolOutput("c4", { ok: false, error: "not_allowed", hint: "ask for a different name", state: "" });
    expect(channel.sent.at(-1)).toMatchObject({ type: "response.create" });
    server({ type: "response.done" });

    toolTurn("c5", "");
    transport.sendToolOutput("c5", { ok: true, state: "" });
    expect(channel.sent.at(-1)).toMatchObject({ type: "response.create" });
    server({ type: "response.done" });

    // A link the server sent on its own with a saved need is news when the words never mentioned it.
    const LINK = { ok: true, hint: "the link is in their messages now. in your own words, tie it to their need", state: "" };
    toolTurn("c6", "got it, bills it is.");
    transport.sendToolOutput("c6", LINK);
    expect(channel.sent.at(-1)).toMatchObject({ type: "response.create" });
    server({ type: "response.done" });
    toolTurn("c7", "got it. i just texted you a google link for that.");
    transport.sendToolOutput("c7", LINK);
    expect(channel.sent.at(-1)).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output" } });
  });

  it("holds the gmail news while they are talking and shares it once their reply is done", async () => {
    const { transport, server, speaks, said } = await connect();
    speaks();
    server({ type: "input_audio_buffer.speech_started" });
    transport.sendNote({ note: "value_moment", text: "you've got 3 unread." });
    expect(said()).toHaveLength(1);
    // The server answers what they said first; the news goes out right after.
    server({ type: "input_audio_buffer.speech_stopped" }, { type: "response.created" });
    expect(said()).toHaveLength(1);
    server({ type: "response.done" });
    expect(said().at(-1)).toContain("you've got 3 unread.");
  });

  it("shares held news after they stop even when the server starts no reply", async () => {
    const { transport, server, speaks, said } = await connect();
    speaks();
    server({ type: "input_audio_buffer.speech_started" });
    transport.sendNote({ note: "value_moment", text: "you've got 3 unread." });
    server({ type: "input_audio_buffer.speech_stopped" });
    expect(said()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(said().at(-1)).toContain("you've got 3 unread.");
  });

  it("takes a rename by text on board without asking for a response", async () => {
    const { transport, channel, speaks } = await connect();
    speaks();
    transport.sendNote({ note: "renamed", text: "Max" });
    expect(channel.sent.at(-1)).toMatchObject({ type: "conversation.item.create", item: { role: "system" } });
    expect(JSON.stringify(channel.sent.at(-1))).toContain("your name is now Max");
  });

  it("sends the opening only once the audio is flowing and has settled a moment, with the line shown live first", async () => {
    const transport = createWebRtcTransport(mic, { onEvent: () => undefined, onConnectionState: () => undefined }, () => session);
    await transport.offer();
    const peer = FakePeer.last;
    if (!peer) throw new Error("no peer");
    peer.connectionState = "connecting";
    peer.setRemoteDescription = async () => void track.push(peer.track(true));
    const track: FakeTrack[] = [];
    let live = 0;
    void transport.start({ mode: "live", sdp: "answer", callId: "rtc_1" }, session, () => void (live += 1));
    const creates = () => peer.channel.sent.filter((e) => e.type === "response.create").length;
    await vi.advanceTimersByTimeAsync(400);
    peer.connect();
    await vi.advanceTimersByTimeAsync(100);
    expect(live).toBe(0);
    // The track carries sound: the call shows live, and the hello follows a short settle later.
    track[0]?.unmute();
    await vi.advanceTimersByTimeAsync(0);
    expect(live).toBe(1);
    await vi.advanceTimersByTimeAsync(OPEN_SETTLE_MS - 1);
    expect(creates()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(creates()).toBe(1);
  });

  it("never keeps the call waiting on the audio path for more than about a second and a half", async () => {
    const transport = createWebRtcTransport(mic, { onEvent: () => undefined, onConnectionState: () => undefined }, () => session);
    await transport.offer();
    const peer = FakePeer.last;
    if (!peer) throw new Error("no peer");
    peer.connectionState = "connecting";
    // A note before the opening waits for it.
    void transport.start({ mode: "live", sdp: "answer", callId: "rtc_1" }, session);
    transport.sendNote({ note: "value_moment", text: "you've got 3 unread." });
    await vi.advanceTimersByTimeAsync(OPEN_WAIT_MS - 1);
    expect(peer.channel.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(peer.channel.sent.map((e) => e.type)).toEqual(["conversation.item.create", "response.create"]);
    expect(peer.channel.sent[0]?.item?.content?.[0]?.text).toContain("introduce yourself once");
  });

  it("plays the opening as soon as its words start, however it says hello", async () => {
    const { channel, server, events, creates } = await connect();
    const audio = FakeAudio.last;
    server({ type: "response.created" }, { type: "output_audio_buffer.started" });
    expect(audio?.muted).toBe(true);
    server({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "hi there, Buddy here" });
    expect(audio?.muted).toBe(false);
    expect(channel.sent.map((e) => e.type)).not.toContain("response.cancel");
    expect(creates()).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["response.created", "output_audio_buffer.started", "response.output_audio_transcript.delta"]);
  });

  it("takes back every reply after the opening that says the hello again, and asks without it", async () => {
    const { channel, server, events, greets, said, creates } = await connect();
    await greets();
    events.length = 0;
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" }, { type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    expect(creates()).toBe(2);
    server({ type: "response.created" }, { type: "response.output_audio_transcript.delta", item_id: "r1", delta: "hey, it's Buddy again. so" });
    expect(channel.sent.slice(-2).map((e) => e.type)).toEqual(["response.cancel", "output_audio_buffer.clear"]);
    server({ type: "response.done", response: { status: "cancelled" } });
    expect(said().at(-1)).toBe(HELLO_SAID_NOTE);
    expect(creates()).toBe(3);

    // The retry is checked too: a second hello is never heard, whichever greeting it uses.
    server({ type: "response.created" }, { type: "response.output_audio_transcript.delta", item_id: "r2", delta: "hi, Buddy here. sure" });
    expect(channel.sent.filter((e) => e.type === "response.cancel")).toHaveLength(2);
    server({ type: "response.done", response: { status: "cancelled" } });
    expect(creates()).toBe(4);
    expect(events.some((e) => e.type.startsWith("response."))).toBe(false);

    // Past the cap the line plays rather than stay silent.
    server({ type: "response.created" }, { type: "response.output_audio_transcript.delta", item_id: "r3", delta: "hey, it's Buddy. sure" });
    expect(events.some((e) => e.type === "response.output_audio_transcript.delta" && e.item_id === "r3")).toBe(true);
  });

  it("plays a later reply at once when its first word is not the hello, even one that starts with hey", async () => {
    const { server, events, greets } = await connect();
    await greets();
    const audio = FakeAudio.last;
    events.length = 0;
    server({ type: "response.created" }, { type: "output_audio_buffer.started" });
    expect(audio?.muted).toBe(true);
    server({ type: "response.output_audio_transcript.delta", item_id: "r1", delta: "hey, no worries at all" });
    expect(audio?.muted).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["response.created", "output_audio_buffer.started", "response.output_audio_transcript.delta"]);
  });

  it("holds only the reply right after the opening and its retries, so every later reply plays as it comes", async () => {
    const { channel, server, events, greets } = await connect();
    await greets();
    const audio = FakeAudio.last;
    server({ type: "response.created" }, { type: "output_audio_buffer.started" });
    server({ type: "response.output_audio_transcript.delta", item_id: "r1", delta: "one sec, checking." }, { type: "response.done" });
    expect(events.some((e) => e.type === "response.output_audio_transcript.delta" && e.item_id === "r1")).toBe(true);
    server({ type: "response.created" });
    expect(audio?.muted).toBe(false);
    server({ type: "output_audio_buffer.stopped" });
    expect(events.at(-1)).toEqual({ type: "output_audio_buffer.stopped" });
    expect(audio?.muted).toBe(false);
    server({ type: "output_audio_buffer.started" }, { type: "response.output_audio_transcript.delta", item_id: "r2", delta: "hey, it's Buddy. " });
    expect(channel.sent.map((e) => e.type)).not.toContain("response.cancel");
  });

  it("never holds a reply longer than the cap, words or not", async () => {
    const { server } = await connect();
    const audio = FakeAudio.last;
    server({ type: "response.created" });
    expect(audio?.muted).toBe(true);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(audio?.muted).toBe(false);
  });

  it("plays a reply whose words never arrive once its audio has waited a moment", async () => {
    const { server, greets } = await connect();
    await greets();
    const audio = FakeAudio.last;
    server({ type: "response.created" }, { type: "output_audio_buffer.started" });
    await vi.advanceTimersByTimeAsync(1_199);
    expect(audio?.muted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(audio?.muted).toBe(false);
  });

  it("needs real words to answer speech that starts right after the hello, since it may be the hello's echo", async () => {
    const { server, creates } = await connect();
    server(
      { type: "response.created" },
      { type: "output_audio_buffer.started" },
      { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "hey, it's Buddy again." },
      { type: "response.done" },
      { type: "output_audio_buffer.stopped" },
    );
    await vi.advanceTimersByTimeAsync(200);
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" }, { type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    expect(creates()).toBe(1);
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "" });
    server({ type: "input_audio_buffer.speech_started", item_id: "u2" }, { type: "input_audio_buffer.speech_stopped", item_id: "u2" });
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "it's Buddy again" });
    expect(creates()).toBe(1);
    server({ type: "input_audio_buffer.speech_started", item_id: "u3" }, { type: "input_audio_buffer.speech_stopped", item_id: "u3" });
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u3", transcript: "oh hey, it's preston" });
    expect(creates()).toBe(2);
  });

  it("protects only the hello sentence: words over it cut off the rest of the opening once it is heard", async () => {
    const { channel, server, creates } = await connect();
    const audio = FakeAudio.last;
    server({ type: "response.created" }, { type: "output_audio_buffer.started" });
    server({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "hey, it's Buddy. i'm calling to get your name, so i know what to call you." });
    // They talk over the hello: no cut, and no answer yet.
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" }, { type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "all right, so" });
    expect(audio?.muted).toBe(false);
    expect(channel.sent.some((e) => e.type === "response.cancel" || e.type === "output_audio_buffer.clear")).toBe(false);
    server({ type: "response.done" });
    expect(creates()).toBe(1);
    // The hello is heard: the reason and the ask give way to them.
    await vi.advanceTimersByTimeAsync(HELLO_SENTENCE_MS);
    expect(channel.sent.slice(-2).map((e) => e.type)).toEqual(["output_audio_buffer.clear", "response.create"]);
  });

  it("lets the rest of the opening be talked over like any other line", async () => {
    const { channel, server } = await connect();
    const audio = FakeAudio.last;
    server({ type: "response.created" }, { type: "output_audio_buffer.started" });
    server({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "hey, it's Buddy. i'm calling to get your name, so i know what to call you." });
    await vi.advanceTimersByTimeAsync(HELLO_SENTENCE_MS);
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(channel.sent.slice(-2).map((e) => e.type)).toEqual(["response.cancel", "output_audio_buffer.clear"]);
    expect(audio?.muted).toBe(true);
    server({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "stop talking, i'm talking" });
    server({ type: "response.done", response: { status: "cancelled" } });
    expect(channel.sent.at(-1)).toMatchObject({ type: "response.create" });
  });

  it("owes a heard answer after a turn of tools alone, like a card it texted, and asks once more when it comes back empty", async () => {
    const { transport, server, said, creates, greets, speech } = await connect();
    await greets();
    speech("u1");
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "can you see where i am?" });
    server(
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "set_help_need", arguments: "{}" },
      { type: "response.function_call_arguments.done", call_id: "c2", name: "request_location", arguments: "{}" },
      { type: "response.done" },
    );
    transport.sendToolOutput("c1", { ok: true, state: "" });
    expect(creates()).toBe(2);
    transport.sendToolOutput("c2", { ok: true, hint: "the location request is in their messages now.", state: "" });
    // The follow-up goes out at once, without waiting for them to share.
    expect(creates()).toBe(3);
    server({ type: "response.created" }, { type: "response.done", response: { status: "completed", output: [] } });
    expect(creates()).toBe(4);
    expect(said().slice(-2)).toEqual([TOOL_OWED_NOTE, UNHEARD_NOTE]);
  });

  it("tells a reply that opens with the hello from one that doesn't", () => {
    const names = ["Buddy"];
    expect(opensWithHello("hey, it's Buddy.", names, false)).toBe(true);
    expect(opensWithHello("hey, it's Buddy again.", names, false)).toBe(true);
    expect(opensWithHello("hola, soy Buddy otra vez.", names, false)).toBe(true);
    expect(opensWithHello("hey there, it's Buddy", names, true)).toBe(true);
    expect(opensWithHello("hi, Buddy here.", names, false)).toBe(true);
    expect(opensWithHello("hello, it's Buddy calling back.", names, false)).toBe(true);
    expect(opensWithHello("hi Preston, sure thing.", names, false)).toBe(false);
    expect(opensWithHello("hey, it's Mr Buddy.", ["Mr. Buddy"], false)).toBe(true);
    // Still arriving: a word cut mid-way, or the name not reached yet.
    expect(opensWithHello("he", names, false)).toBeNull();
    expect(opensWithHello("hey, it's", names, false)).toBeNull();
    expect(opensWithHello("hey, it's Bud", names, false)).toBeNull();
    expect(opensWithHello("okay, let me", names, false)).toBe(false);
    expect(opensWithHello("hey, no worries at all", names, false)).toBe(false);
    expect(opensWithHello("hey, it's", names, true)).toBe(false);
    expect(opensWithHello("", names, true)).toBe(false);
  });

  // Their words, then a lookup the reply called without saying anything, whose result the follow-up has to speak to.
  async function lookedUp() {
    const call = await connect();
    await call.greets();
    call.speech("u1");
    call.server(
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "gmail_search", arguments: "{}" },
      { type: "response.done" },
    );
    call.transport.sendToolOutput("c1", { ok: true, result: "2 in the applications folder", state: "" });
    expect(call.creates()).toBe(3);
    return call;
  }
  const noteCount = (texts: string[], note: string) => texts.filter((text) => text === note).length;

  it("still owes a lookup its follow-up was cut from before a word was heard, and brings it to the one answer to their words", async () => {
    const { channel, server, said, creates, speech } = await lookedUp();
    // The follow-up is thinking, and its transcript has started, but none of its audio has played.
    server({ type: "response.created" }, { type: "response.output_audio_transcript.delta", item_id: "r5", delta: "so i found" });
    server({ type: "input_audio_buffer.speech_started", item_id: "u2" });
    expect(channel.sent.at(-1)).toEqual({ type: "response.cancel" });
    server({ type: "response.done", response: { status: "cancelled" } }, { type: "input_audio_buffer.speech_stopped", item_id: "u2" });
    expect(creates()).toBe(3);
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "hello?" });
    expect(creates()).toBe(4);
    expect(channel.sent.at(-2)?.item?.content?.[0]?.text).toBe(TOOL_OWED_NOTE);
    expect(noteCount(said(), TOOL_OWED_NOTE)).toBe(1);

    // Once the agent is heard the lookup is said, so the next answer carries no note.
    server({ type: "response.created" }, { type: "output_audio_buffer.started" }, { type: "response.done" }, { type: "output_audio_buffer.stopped" });
    speech("u3");
    expect(creates()).toBe(5);
    expect(noteCount(said(), TOOL_OWED_NOTE)).toBe(1);
  });

  it("asks once more after a follow-up to a lookup that fails, and still owes the lookup to their next words", async () => {
    const { channel, server, said, creates, speech } = await lookedUp();
    server({ type: "response.created" }, { type: "response.done", response: { status: "failed" } });
    expect(creates()).toBe(4);
    expect(said().slice(-2)).toEqual([TOOL_OWED_NOTE, UNHEARD_NOTE]);
    // The one retry fails too: nothing more is asked for on its own.
    server({ type: "response.created" }, { type: "response.done", response: { status: "failed" } });
    expect(creates()).toBe(4);

    speech("u2");
    expect(creates()).toBe(5);
    expect(channel.sent.at(-2)?.item?.content?.[0]?.text).toBe(TOOL_OWED_NOTE);
  });

  it("sends a refused response.create once more, and opens the line again if that is refused too", async () => {
    const { events, server, greets, speaks, said, creates, lastCreate, speech } = await connect();
    await greets();
    speech("u1");
    expect(creates()).toBe(2);
    server({ type: "error", error: { code: "server_error", event_id: lastCreate() } });
    await vi.advanceTimersByTimeAsync(499);
    expect(creates()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(creates()).toBe(3);

    server({ type: "error", error: { code: "server_error", event_id: lastCreate() } });
    await vi.advanceTimersByTimeAsync(500);
    expect(creates()).toBe(3);
    // The line is open again, so 5 s after their words the watchdog asks once more.
    await vi.advanceTimersByTimeAsync(DEAD_AIR_MS - 1_000);
    expect(creates()).toBe(4);
    expect(said().at(-1)).toBe(DEAD_AIR_NOTE);
    // Once the agent is heard, silence is timed again, and the next thing they say is answered.
    speaks();
    events.length = 0;
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(events.filter((e) => e.type === "input_audio_buffer.timeout_triggered")).toHaveLength(1);
    speech("u2");
    expect(creates()).toBe(5);
  });

  it("waits out a growing pause after each reply refused for the rate limit, instead of asking again at once", async () => {
    const { server, greets, creates, speech } = await connect();
    await greets();
    speech("u1");
    expect(creates()).toBe(2);
    const limited = { type: "response.done" as const, response: { status: "failed", status_details: { type: "failed", error: { type: "requests", code: "rate_limit_exceeded" } }, output: [] } };
    server({ type: "response.created" }, limited);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(creates()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(creates()).toBe(3);
    server({ type: "response.created" }, limited);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(creates()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(creates()).toBe(4);
  });

  it("ignores an error that is not about the response.create still waiting to start", async () => {
    const { transport, server, greets, said, creates, lastCreate, speech } = await connect();
    await greets();
    speech("u1");
    const asked = lastCreate();
    expect(asked).toEqual(expect.any(String));
    server(
      { type: "error", error: { code: "item_delete_invalid_item_id", event_id: "evt_delete_1" } },
      { type: "error", error: { message: "something else" } },
      { type: "error" },
    );
    // A create that already started is not refused by an error that comes after it.
    server({ type: "response.created" }, { type: "error", error: { code: "rate_limit_exceeded", event_id: asked } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(creates()).toBe(2);
    // The reply is still running, so news waits for it.
    transport.sendNote({ note: "value_moment", text: "you've got 3 unread." });
    expect(creates()).toBe(2);
    server({ type: "response.done" });
    expect(creates()).toBe(3);
    expect(said().at(-1)).toContain("you've got 3 unread.");
  });

  it("waits out a reply the server says is already running, until that reply is done", async () => {
    const { transport, server, greets, said, creates, lastCreate, speech } = await connect();
    await greets();
    speech("u1");
    const asked = lastCreate();
    expect(asked).toEqual(expect.any(String));
    server({ type: "error", error: { code: "conversation_already_has_active_response", event_id: asked } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(creates()).toBe(2);
    transport.sendNote({ note: "value_moment", text: "you've got 3 unread." });
    expect(creates()).toBe(2);
    server({ type: "response.done" });
    expect(creates()).toBe(3);
    expect(said().at(-1)).toContain("you've got 3 unread.");
  });

  it("answers real words over the agent that come in after it already carried on without them, once", async () => {
    const { channel, server, speaks, creates } = await talking();
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    server({ type: "response.done", response: { status: "cancelled" } }, { type: "output_audio_buffer.cleared" });
    server({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(channel.sent).toContainEqual({ type: "conversation.item.delete", item_id: "u1" });
    expect(creates()).toBe(2);
    speaks();
    await vi.advanceTimersByTimeAsync(1_000);

    const words = "can you look outside my inbox too";
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: words });
    expect(creates()).toBe(3);
    expect(channel.sent.at(-2)).toMatchObject({ type: "conversation.item.create", item: { role: "user", content: [{ text: words }] } });
    speaks();
    expect(creates()).toBe(3);
  });

  it("asks them to say it again when the words that cut the agent off could not be made out", async () => {
    const { channel, server, speaks, said, creates, speech } = await talking();
    server({ type: "input_audio_buffer.speech_started", item_id: "u1" }, { type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    server({ type: "response.done", response: { status: "cancelled" } }, { type: "output_audio_buffer.cleared" });
    server({ type: "conversation.item.input_audio_transcription.failed", item_id: "u1" });
    expect(creates()).toBe(2);
    expect(said().at(-1)).toBe(SAY_AGAIN_NOTE);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(creates()).toBe(2);
    expect(channel.sent.some((e) => e.type === "conversation.item.delete")).toBe(false);

    // Speech into silence was already answered, so its failed words need nothing more.
    speaks();
    speech("u2");
    expect(creates()).toBe(3);
    server({ type: "conversation.item.input_audio_transcription.failed", item_id: "u2" });
    expect(creates()).toBe(3);

    // Words that fail after the agent already carried on without them are asked for again too.
    const late = await talking();
    late.server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    late.server({ type: "response.done", response: { status: "cancelled" } }, { type: "output_audio_buffer.cleared" });
    late.server({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    await vi.advanceTimersByTimeAsync(4_000);
    late.speaks();
    late.server({ type: "conversation.item.input_audio_transcription.failed", item_id: "u1" });
    expect(late.creates()).toBe(3);
    expect(late.said().at(-1)).toBe(SAY_AGAIN_NOTE);
  });

  it("asks once more, and only once, after a reply to their words that comes back with nothing", async () => {
    const { transport, server, greets, speaks, said, creates, speech } = await connect();
    await greets();
    // A reply that owed them nothing is not asked for again.
    transport.sendNote({ note: "value_moment", text: "you've got 3 unread." });
    server({ type: "response.created" }, { type: "response.done", response: { status: "failed" } });
    expect(creates()).toBe(2);

    speech("u1");
    expect(creates()).toBe(3);
    server({ type: "response.created" }, { type: "response.done", response: { status: "completed", output: [] } });
    expect(creates()).toBe(4);
    expect(said().at(-1)).toBe(UNHEARD_NOTE);
    server({ type: "response.created" }, { type: "response.done", response: { status: "completed", output: [] } });
    expect(creates()).toBe(4);

    // New words can be asked for once more again, and a reply that broke off counts too.
    speech("u2");
    expect(creates()).toBe(5);
    server({ type: "response.created" }, { type: "response.done", response: { status: "incomplete" } });
    expect(creates()).toBe(6);
    speaks();

    // A reply that was heard before it failed, or one that was cancelled, never is.
    speech("u3");
    expect(creates()).toBe(7);
    server({ type: "response.created" }, { type: "output_audio_buffer.started" }, { type: "response.done", response: { status: "failed" } });
    server({ type: "output_audio_buffer.stopped" });
    expect(creates()).toBe(7);
    speech("u4");
    expect(creates()).toBe(8);
    server({ type: "response.created" }, { type: "response.done", response: { status: "cancelled", output: [] } });
    expect(creates()).toBe(8);
  });

  it("answers new words that cut off a reply which then failed once, not once for each", async () => {
    const { server, greets, speaks, said, creates, speech } = await connect();
    await greets();
    speech("u1");
    speaks();
    speech("u2");
    expect(creates()).toBe(3);
    // They talk over the reply while it is still thinking, and it fails before the cancel lands.
    server({ type: "response.created" }, { type: "input_audio_buffer.speech_started", item_id: "u3" });
    server({ type: "response.done", response: { status: "failed" } }, { type: "input_audio_buffer.speech_stopped", item_id: "u3" });
    // Their words come in slowly, well past the wait for held news.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(creates()).toBe(3);
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u3", transcript: "actually can you check my calendar" });
    expect(creates()).toBe(4);
    speaks();
    expect(creates()).toBe(4);
    expect(said()).not.toContain(UNHEARD_NOTE);
  });

  it("asks once more, and only once, when their words get nothing back at all for 5 s", async () => {
    const { greets, speech, said, creates, cancels, codes } = await connect();
    await greets();
    speech("u1");
    expect(creates()).toBe(2);
    // The server never answers that response.create, not even with an error.
    await vi.advanceTimersByTimeAsync(DEAD_AIR_MS - 1);
    expect(creates()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(creates()).toBe(3);
    expect(said().at(-1)).toBe(DEAD_AIR_NOTE);
    expect(codes.at(-1)).toBe("dead_air:unanswered");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(creates()).toBe(3);
    expect(cancels()).toEqual([]);
  });

  it("asks once more 5 s after their words when every reply to them came back with nothing", async () => {
    const { server, greets, speech, said, creates, codes } = await connect();
    await greets();
    speech("u1");
    server({ type: "response.created" }, { type: "response.done", response: { status: "completed", output: [] } });
    server({ type: "response.created" }, { type: "response.done", response: { status: "completed", output: [] } });
    expect(creates()).toBe(3);
    await vi.advanceTimersByTimeAsync(DEAD_AIR_MS - 1);
    expect(creates()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(creates()).toBe(4);
    expect(said().at(-1)).toBe(DEAD_AIR_NOTE);
    expect(codes.at(-1)).toBe("dead_air:ask");
    server({ type: "response.created" }, { type: "response.done", response: { status: "completed", output: [] } });
    await vi.advanceTimersByTimeAsync(DEAD_AIR_MS);
    expect(creates()).toBe(4);
  });

  it("never cancels or doubles a slow reply that is heard within 10 s of their words", async () => {
    const { server, greets, speech, creates, cancels } = await connect();
    await greets();
    speech("u1");
    await vi.advanceTimersByTimeAsync(1_000);
    server({ type: "response.created" });
    await vi.advanceTimersByTimeAsync(2_000);
    server({ type: "output_audio_buffer.started" }, { type: "response.output_audio_transcript.delta", item_id: "r1", delta: "sure, one sec." });
    await vi.advanceTimersByTimeAsync(2_000);
    server({ type: "response.done" });
    await vi.advanceTimersByTimeAsync(2_000);
    server({ type: "output_audio_buffer.stopped" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(creates()).toBe(2);
    expect(cancels()).toEqual([]);

    // A reply still thinking at 5 s is on its way, so it is waited on.
    speech("u2");
    await vi.advanceTimersByTimeAsync(4_000);
    server({ type: "response.created" });
    await vi.advanceTimersByTimeAsync(5_000);
    server(
      { type: "output_audio_buffer.started" },
      { type: "response.output_audio_transcript.delta", item_id: "r2", delta: "found it." },
      { type: "response.done" },
      { type: "output_audio_buffer.stopped" },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(creates()).toBe(3);
    expect(cancels()).toEqual([]);
  });

  it("cancels a reply that started but never makes a sound 10 s after their words, and asks once more, only once", async () => {
    const { server, greets, speech, said, creates, cancels, codes } = await connect();
    await greets();
    speech("u1");
    await vi.advanceTimersByTimeAsync(1_000);
    server({ type: "response.created" });
    await vi.advanceTimersByTimeAsync(STUCK_MS - 1_001);
    expect(cancels()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cancels()).toEqual([{ type: "response.cancel", event_id: expect.any(String) }]);
    expect(creates()).toBe(2);
    server({ type: "response.done", response: { status: "cancelled" } });
    expect(creates()).toBe(3);
    expect(said().at(-1)).toBe(DEAD_AIR_NOTE);
    expect(codes).toContain("dead_air:cancel");
    // The one re-ask is silent too: nothing more is cancelled or asked for.
    server({ type: "response.created" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(creates()).toBe(3);
    expect(cancels()).toHaveLength(1);
  });

  it("asks at once when the server refuses the watchdog's cancel, since nothing was running", async () => {
    const { server, greets, speech, said, creates, cancels } = await connect();
    await greets();
    speech("u1");
    server({ type: "response.created" });
    await vi.advanceTimersByTimeAsync(STUCK_MS);
    const cancel = cancels()[0];
    expect(cancel?.event_id).toEqual(expect.any(String));
    server({ type: "error", error: { code: "response_cancel_not_active", event_id: cancel?.event_id } });
    expect(creates()).toBe(3);
    expect(said().at(-1)).toBe(DEAD_AIR_NOTE);
  });

  it("waits out a lookup and times its silent follow-up from when it was asked, then asks once with the lookup still owed", async () => {
    const { transport, server, greets, speech, said, creates, cancels, codes } = await connect();
    await greets();
    speech("u1");
    server(
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "gmail_search", arguments: "{}" },
      { type: "response.done" },
    );
    // The lookup takes 8 s, and nothing is asked for while it is out.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(creates()).toBe(2);
    transport.sendToolOutput("c1", { ok: true, result: "2 in the applications folder", state: "" });
    expect(creates()).toBe(3);
    server({ type: "response.created" });
    // 10 s after their words is only 2 s after the follow-up was asked for.
    await vi.advanceTimersByTimeAsync(STUCK_MS - 1);
    expect(cancels()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cancels()).toHaveLength(1);
    server({ type: "response.done", response: { status: "cancelled" } });
    expect(creates()).toBe(4);
    expect(said().slice(-2)).toEqual([TOOL_OWED_NOTE, DEAD_AIR_NOTE]);
    expect(codes).toContain("dead_air:cancel:tool");
  });

  it("never runs the watchdog on the opening, even when they talk over it or text and it never gets going", async () => {
    const { transport, server, speech, creates, cancels, codes } = await connect();
    server({ type: "response.created" });
    speech("u1");
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "hi, it's preston" });
    transport.sendNote({ note: "user_texted", text: "hi" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(creates()).toBe(1);
    expect(cancels()).toEqual([]);
    expect(codes.filter((code) => code.startsWith("dead_air"))).toEqual([]);
  });

  it("never runs the watchdog once end_call is called", async () => {
    const { transport, server, greets, speech, creates, cancels, codes } = await connect();
    await greets();
    speech("u1");
    server(
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "end_call", arguments: JSON.stringify({ reason: "user_request" }) },
      { type: "response.done" },
    );
    await vi.advanceTimersByTimeAsync(STUCK_MS);
    transport.sendToolOutput("c1", { ok: true, state: "" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(creates()).toBe(2);
    expect(cancels()).toEqual([]);
    expect(codes.filter((code) => code.startsWith("dead_air"))).toEqual([]);
  });

  it("watches their words again when a wordless end_call is sent back, since the call goes on", async () => {
    const { transport, server, greets, speech, said, creates, codes } = await connect();
    await greets();
    speech("u1");
    server(
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "end_call", arguments: JSON.stringify({ reason: "done" }) },
      { type: "response.done" },
    );
    transport.sendToolOutput("c1", UNSPOKEN_END_CALL);
    expect(creates()).toBe(3);
    // The answer to the refusal never gets going.
    await vi.advanceTimersByTimeAsync(DEAD_AIR_MS);
    expect(creates()).toBe(4);
    expect(said().at(-1)).toBe(DEAD_AIR_NOTE);
    expect(codes.at(-1)).toBe("dead_air:unanswered:tool");
  });

  it("never asks again for an answer heard joining audio still playing, even with no start of its own", async () => {
    const { transport, server, creates, cancels, codes } = await talking();
    server({ type: "response.done" });
    // A text lands mid-sentence, and its answer goes out while the line before it is still playing.
    transport.sendNote({ note: "user_texted", text: "look at my text" });
    expect(creates()).toBe(2);
    server(
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", item_id: "r3", delta: "got your text, sure." },
      { type: "response.output_audio_transcript.done", item_id: "r3", transcript: "got your text, sure." },
      { type: "response.done" },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    server({ type: "output_audio_buffer.stopped" });
    // Past the watchdog's 5 s, and short of the check-in on the silence after it.
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1);
    expect(creates()).toBe(2);
    expect(cancels()).toEqual([]);
    expect(codes.filter((code) => code.startsWith("dead_air"))).toEqual([]);
  });

  it("records once what a watchdog still waits on 10 s after their words", async () => {
    const { transport, server, greets, speech, creates, codes } = await connect();
    await greets();
    speech("u1");
    server(
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "gmail_search", arguments: "{}" },
      { type: "response.done" },
    );
    await vi.advanceTimersByTimeAsync(STUCK_MS + 5_000);
    expect(codes.filter((code) => code.startsWith("dead_air"))).toEqual(["dead_air:wait:tool"]);
    expect(creates()).toBe(2);
    transport.sendToolOutput("c1", { ok: true, result: "nothing found", state: "" });
    expect(creates()).toBe(3);
  });

  it("reports how each reply went and what went wrong as codes, never words", async () => {
    const { server, greets, speech, codes, lastCreate } = await connect();
    await greets();
    speech("u1");
    server({ type: "error", error: { code: "rate_limit_exceeded", message: "slow down, preston", event_id: lastCreate() } });
    await vi.advanceTimersByTimeAsync(1_500);
    server({ type: "error", error: { code: "rate_limit_exceeded", event_id: lastCreate() } });
    server(
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", item_id: "r1", delta: "sure, preston" },
      { type: "response.done", response: { status: "failed", status_details: { type: "failed", error: { type: "server_error", code: "internal" } }, output: [] } },
    );
    server({ type: "response.done", response: { status: "cancelled", status_details: { type: "cancelled", reason: "client_cancelled" }, output: [{}] } });
    expect(codes).toEqual([
      "done:none",
      "error:rate_limit_exceeded:create",
      "create_retry",
      "error:rate_limit_exceeded:create",
      "create_failed",
      "done:failed:internal:n0",
      "done:cancelled:client_cancelled:n1",
    ]);

    const cut = await talking();
    cut.server({ type: "input_audio_buffer.speech_started", item_id: "u1" }, { type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    cut.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "what should i call you" });
    expect(cut.codes.at(-1)).toBe("carry_on");
    expect(JSON.stringify([...codes, ...cut.codes])).not.toMatch(/preston|slow down|call you/);
  });
});
