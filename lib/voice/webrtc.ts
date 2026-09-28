import { callGreeting } from "@/lib/agent/messages";
import { fold } from "@/lib/agent/policy";
import { traceRealtime, traceSent } from "@/lib/client/dev-trace";
import type { Session } from "@/lib/session/schema";
import { meterStream, type StreamMeter } from "@/lib/voice/audio-level";
import { createLiveCaptions, type LiveCaptions } from "@/lib/voice/live-captions";
import {
  askUnsaid,
  callNote,
  CUT_OFF_NOTE,
  HELLO_SAID_NOTE,
  isFarewell,
  keepsCallOpen,
  linkUnsaid,
  needsAnswer,
  openingNote,
  SILENCE_MS,
  silenceNote,
  silenceStep,
} from "@/lib/voice/notes";
import { LOCAL_CALL, parseServerEvent, type ServerEvent, type TransportHandlers, type VoiceTransport } from "@/lib/voice/transport";

// OpenAI Realtime over raw WebRTC (unified interface). The server posts our SDP offer to
// /v1/realtime/calls and returns the answer, so no key ever reaches the browser.

const OPEN_TIMEOUT_MS = 15_000;
// The opening waits for the agent's audio to be flowing (the element playing, the peer connected, the remote track
// carrying sound), then settles a moment, so its first words play at their own pace instead of arriving in a burst
// the browser has to time-stretch. Capped, so a line that never reports ready still hears the agent this soon.
const OPEN_SETTLE_MS = 300;
const OPEN_WAIT_MS = 1_500;
// Realtime's own idle timeout answers however the model likes. Timing silence here (SILENCE_MS, lib/voice/notes.ts)
// lets the transport hold the rule: one check-in, patience while Google sign-in is open, then a goodbye and a hangup.

// How long after they stop talking held news waits for the server's own reply to start before going out anyway.
const SPEECH_SETTLE_MS = 1_500;
// Above this the agent's voice is sounding; the gaps between its clauses decode well below it.
const AUDIBLE_DB = -45;
// How long after they stop, speech that cut the agent off waits for its words before the agent carries on anyway.
// Real words that land even later are still put back and answered.
const CUT_HOLD_MS = 4_000;
// How long a response.create the server refused waits before it is sent once more.
const CREATE_RETRY_MS = 500;
// How long a reply OpenAI refused for its rate limit waits before the next ask, growing with each refusal in a row.
const RATE_BACKOFF_MS = [1_500, 3_000, 5_000];
// How long their words go without the agent being heard before it is asked for an answer once more, when nothing is
// on its way. A reply that is on its way but still silent this long after their words, or after it was asked for when
// a lookup ran first, is cancelled and asked for once more. Until then a busy line is looked at again every second.
const DEAD_AIR_MS = 5_000;
const STUCK_MS = 10_000;
const DEAD_AIR_CHECK_MS = 1_000;
// A hello said as more than one line can stop between them: quiet this long after a stop, with lines still unheard, and
// the hello is out.
const HELLO_GAP_MS = 350;
// About how long each character of the hello sentence takes to say. Only that sentence is kept from barge-in and
// being cut off; the rest of the opening turn can be talked over like any other line.
const HELLO_MS_PER_CHAR = 60;
// Early in the call the echo canceller is still learning the room, so speech that starts this soon after the opening's
// audio stops may be the tail of its own voice: it waits for its words like speech over the agent.
const ECHO_TAIL_MS = 600;
// How many times in a row a reply that says the hello again is taken back and asked for once more.
const MAX_RETAKES = 2;
// How long a reply's audio stays muted waiting on its first words before it plays anyway.
const FIRST_WORDS_MS = 1_200;
// The longest any reply is held, words or not, and the longest a cut voice stays muted waiting for its audio to clear:
// past these the line plays on, so nothing held can leave the call silent.
const HOLD_CAP_MS = 2_500;
const SILENCED_CAP_MS = 2_000;
// A hello opens with one of these, and the agent's name comes within this many words of it.
const HELLO_START = new Set(["hey", "hi", "hello", "hiya", "heya", "hola"]);
const NAME_WITHIN = 3;
// Words said over the hello that need no answer of their own, since the hello's question is already waiting on them.
const PICKUP = /^(?:hi|hey|hello|hiya|yo|yeah|yes|yep|ok|okay|sure|hi there|hey there|hello there)[\s.!?,]*$/i;
const wordsOf = (text: string) => fold(text).replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter(Boolean);
// What the agent says and does in a reply, as opposed to what the caller's side of the line reports.
const REPLY_EVENTS = new Set<ServerEvent["type"]>([
  "response.created",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.function_call_arguments.done",
  "response.done",
  "output_audio_buffer.started",
  "output_audio_buffer.stopped",
  "output_audio_buffer.cleared",
]);

/**
 * Heard while the agent was talking, and nothing but the agent's own words: its voice leaking from a speaker into the
 * mic. Real words from the caller are mostly not in what the agent is saying.
 */
export function isEcho(heard: string, agentSaid: string): boolean {
  const words = wordsOf(heard);
  if (words.length === 0) return true;
  const said = wordsOf(agentSaid);
  if (` ${said.join(" ")} `.includes(` ${words.join(" ")} `)) return true;
  const known = new Set(said);
  return words.length >= 4 && words.filter((word) => known.has(word)).length / words.length >= 0.8;
}

/**
 * Whether a reply that starts with `text` opens with the hello: "hey" or "hola", then one of `names` within the first
 * few words. Null while too few whole words are in to tell; `final` means no more of the text is coming.
 */
export function opensWithHello(text: string, names: string[], final: boolean): boolean | null {
  const all = wordsOf(text);
  // The last word may still be arriving, unless something already follows it.
  const words = final || /[^\p{L}\p{N}']$/u.test(text) ? all : all.slice(0, -1);
  if (words.length === 0) return final ? false : null;
  if (!HELLO_START.has(words[0] ?? "")) return false;
  const wanted = names.map(wordsOf).filter((name) => name.length > 0);
  for (const name of wanted) {
    const head = words.slice(0, NAME_WITHIN + name.length);
    for (let i = 0; i + name.length <= head.length; i++) if (name.every((word, j) => head[i + j] === word)) return true;
  }
  const longest = Math.max(0, ...wanted.map((name) => name.length));
  return final || words.length >= NAME_WITHIN + longest ? false : null;
}

/** Rides along with the next reply after one that was asked to speak to a tool result but was never heard saying it. */
export const TOOL_OWED_NOTE =
  "you haven't said out loud yet what your last tool call returned. answer what they last said, and fold in that result if it still matters.";

/** Asks once more after a reply to them that failed, broke off, or came back with nothing, so nothing reached them. */
export const UNHEARD_NOTE = "your last reply never reached them, so they heard nothing. answer them out loud now.";

/** Answers speech that cut the agent off when its words could not be made out. */
export const SAY_AGAIN_NOTE = "they talked over you, but their words didn't come through. ask them briefly to say that again.";

/** Asked once when their words have gone several seconds with nothing heard back. */
export const DEAD_AIR_NOTE = "they're still waiting on an answer to what they last said and have heard nothing yet. answer it out loud now.";

/** A reply's outcome as a code with no words in it, for the call's production record. */
function doneCode(event: Extract<ServerEvent, { type: "response.done" }>): string {
  const { status, status_details: details, output } = event.response ?? {};
  const parts = [status ?? "none", details?.type !== status ? details?.type : undefined, details?.reason, details?.error?.code ?? details?.error?.type];
  if (Array.isArray(output)) parts.push(`n${output.length}`);
  return ["done", ...parts.filter(Boolean)].join(":");
}

const message = (role: "system" | "user", text: string) => ({
  type: "conversation.item.create",
  item: { type: "message", role, content: [{ type: "input_text", text }] },
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves once `ready()` holds, checked now and on every `type` event from `target`. */
function when(target: EventTarget, type: string, ready: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (ready()) return resolve();
    const check = () => {
      if (!ready()) return;
      target.removeEventListener(type, check);
      resolve();
    };
    target.addEventListener(type, check);
  });
}

export function createWebRtcTransport(mic: MediaStream, handlers: TransportHandlers, latestSession: () => Session): VoiceTransport {
  const pc = new RTCPeerConnection();
  const channel = pc.createDataChannel("oai-events");
  const audio = new Audio();
  audio.autoplay = true;
  audio.setAttribute("playsinline", "");
  let remote: StreamMeter | null = null;
  let gotTrack: (track: MediaStreamTrack) => void = () => undefined;
  const remoteTrack = new Promise<MediaStreamTrack>((resolve) => (gotTrack = resolve));
  let captions: LiveCaptions | null = null;
  let micMuted = false;
  // The track going out now: the controller swaps in a new one when the device takes the mic away.
  let micTrack: MediaStreamTrack | null = mic.getAudioTracks()[0] ?? null;
  let closed = false;
  // Typed items become transcript rows, whose ids are idempotency keys on the server, so they never repeat across calls.
  const tag = crypto.randomUUID().slice(0, 8);
  let typed = 0;
  // The session the call opened with, and whether its opening has been asked for: nothing else is said before it.
  let first: Session | null = null;
  let greeted = false;

  // Realtime rejects response.create while a response is running, so follow-ups and notes wait
  // until the current response is done and every function call in it has its output.
  let responding = false;
  let playing = false;
  let followUp = false;
  // A result of the response's tool calls that the model has to speak to (needsAnswer). Without one, a response that
  // already spoke over its tools gets no second response.
  let answerTools = false;
  // Tool results whose link news the response's words may not have covered, judged once all of its words are in.
  let linkResults: unknown[] = [];
  // What the agent owes them until its voice is heard (audio playing, not just its transcript, which runs ahead): an
  // answer to their words, and a tool result it was asked to speak to. A reply that is cut before it is heard, or comes
  // to nothing, leaves the debt standing, and a reply that comes to nothing is asked for once more.
  let wordsOwed = false;
  let toolOwed = false;
  let reasked = false;
  // The response.create waiting on its response.created, so an error the server sends for it can be told apart, and
  // whether it is already the one retry of a refused create.
  let pendingCreate: { id: string; retry: boolean } | null = null;
  let createCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // OpenAI refused a reply for its rate limit: the next ask waits out a growing pause instead of being refused again at
  // once, and a rate-limited reply may be asked for again more than the usual once.
  let limited = 0;
  let holdUntil = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  // When the latest response.create went out.
  let askedAt = 0;
  // Since when their words have waited on the agent being heard, while the watchdog still has its one re-ask for them,
  // and the event_id of a cancel it sent, until the reply it cancelled is done.
  let deadAirFrom: number | null = null;
  let deadAirTimer: ReturnType<typeof setTimeout> | undefined;
  let deadAirCancel: string | null = null;
  // Whether the reply going out now was asked for after the words the watchdog waits on, and whether a wait on
  // something else past the stuck limit has been recorded for them.
  let answering = false;
  let deadAirWaited = false;
  // Once end_call is called nothing else is said: the controller lets the goodbye finish, then hangs up. A refused
  // end_call (a silent one, or one on the call's own opening) takes that back, and the model answers the refusal.
  let ending = false;
  let endCall: { id: string; goodbye: boolean } | null = null;
  // A refused silence goodbye still owes one: the next response is the goodbye again.
  let goodbyeNext = false;
  const awaiting = new Set<string>();
  // Each entry is the items for one response, sent together before it is requested.
  const queued: object[][] = [];
  // News that lands while they are talking, like Gmail connecting, waits for them to finish instead of cutting in.
  // Their words get the server's own reply first; the news follows once it is done.
  let userSpeaking = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  let silences = 0;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  // The next response is the silence goodbye, which must end the call even if the model only says it.
  let goodbye = false;
  // What they last said and what the current response says, so a goodbye to their goodbye ends the call too.
  let lastHeard = "";
  let replying = "";
  // The server only marks where speech starts and stops (lib/voice/turn-detection.ts); this decides what gets an
  // answer. Speech into silence is answered the moment it stops. Speech that starts while the agent is talking cuts it
  // off at once, but may be that voice coming back through a speaker, so the answer waits for its words: real words
  // get it, and an echo, or nothing at all, has the agent carry on from where it stopped. Nothing cuts off the hello
  // sentence: real words said over it are answered once it has been heard, and a hello back needs no answer.
  let hello = true;
  let helloGenerated = false;
  // The hello's lines, and how many times its audio has stopped: each line can have its own start and stop.
  const helloLines = new Set<string>();
  let helloStops = 0;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let sentenceTimer: ReturnType<typeof setTimeout> | undefined;
  let owed = false;
  const overAgent = new Set<string>();
  let saying = "";
  let lastReply = "";
  // When the agent's audio last stopped, and whether a reply after the opening has started since.
  let stoppedAt = -Infinity;
  let pastOpening = false;
  // The call volume the caller chose.
  let volume = audio.volume;
  // The agent was cut off by speech over it: its voice stays silent until the cut audio is gone, and the speech
  // decides, once its words are in, whether it gets an answer or the agent carries on.
  let silenced = false;
  let silencedTimer: ReturnType<typeof setTimeout> | undefined;
  let cutFor: string | null = null;
  let cutTimer: ReturnType<typeof setTimeout> | undefined;
  // Speech over the agent that carryOn took out of the conversation, with what the agent was saying then: words that
  // turn out to be real after all are put back and answered.
  const cutAway = new Map<string, string>();

  // A reply's first words decide whether it is heard. Until they are in, its audio stays muted and its events wait.
  // The opening is the model's own hello, in its own words, and plays as soon as it has any. The reply after it may
  // not say the hello again: one that does is taken back unheard and asked for once more, and so is each retry that
  // still does, up to MAX_RETAKES times.
  type Held = {
    opening: boolean;
    retakes: number;
    text: string;
    events: ServerEvent[];
    items: Set<string>;
    done: boolean;
    timer?: ReturnType<typeof setTimeout>;
    cap?: ReturnType<typeof setTimeout>;
  };
  let held: Held | null = null;
  // A reply being taken back: its events are dropped until the next reply starts, and `then` runs once it is done.
  let dropped: { items: Set<string>; done: boolean; then: () => void } | null = null;
  // The opening's hello got through, so every later reply is checked for a second one instead.
  let helloPassed = false;
  // How many replies in a row were taken back for saying the hello again.
  let retakes = 0;

  const send = (event: object) => {
    if (channel.readyState !== "open") return;
    channel.send(JSON.stringify(event));
    traceSent(event);
  };
  const report = (code: string) => handlers.onDiag?.(code);
  const idle = () => !responding && !playing && !followUp && awaiting.size === 0 && queued.length === 0 && !ending && !closed;
  const quiet = () => clearTimeout(silenceTimer);
  const listen = () => {
    quiet();
    if (idle()) silenceTimer = setTimeout(onSilence, SILENCE_MS);
  };
  const respond = (retry = false) => {
    responding = true;
    quiet();
    clearTimeout(retryTimer);
    const wait = holdUntil - Date.now();
    if (wait > 0) {
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => !closed && respond(retry), wait);
      return;
    }
    askedAt = Date.now();
    pendingCreate = { id: `create_${tag}_${++createCount}`, retry };
    send({ type: "response.create", event_id: pendingCreate.id });
  };
  const advance = () => {
    if (!greeted || responding || awaiting.size > 0 || closed || ending) return;
    if (followUp) {
      followUp = false;
      // A turn of tools alone said nothing, so its follow-up is owed to them like a lookup's answer: one that comes back
      // with nothing is asked for once more, and one cut before it is heard carries the debt on.
      const silent = !replying.trim();
      const owesTools = answerTools || silent;
      const answer = owesTools || linkResults.some((output) => linkUnsaid(output, replying) || askUnsaid(output, replying));
      answerTools = false;
      linkResults = [];
      if (answer) {
        toolOwed ||= owesTools;
        respond();
        return;
      }
    }
    if (userSpeaking) return;
    const items = queued.shift();
    if (!items) return listen();
    // A tool result that was never heard rides along with the next reply, so it still gets said if it matters.
    if (toolOwed) send(message("system", TOOL_OWED_NOTE));
    for (const item of items) send(item);
    respond();
  };
  const applyVolume = () => {
    audio.volume = volume;
    // A reply whose first words are not in yet is muted, once the audio of the one before it has played out. A cut
    // voice is muted here at once, since the audio already on its way would otherwise play on after the cut.
    const withheld = (held !== null || dropped !== null) && !playing;
    audio.muted = withheld || silenced;
  };
  const heard = () => {
    silences = 0;
    goodbye = false;
    goodbyeNext = false;
    quiet();
  };
  const echoTail = () => !pastOpening && Date.now() - stoppedAt < ECHO_TAIL_MS;

  // Ended or muted by the device (another app or tab took it, a headset unplugged) until the controller opens it again.
  const micLost = () => micTrack !== null && (micTrack.readyState !== "live" || micTrack.muted);

  function onSilence() {
    if (!idle()) return;
    // A mic that hears nothing is not the caller going quiet, so it never counts toward the goodbye.
    if (micLost()) return listen();
    silences += 1;
    handlers.onEvent({ type: "input_audio_buffer.timeout_triggered" });
    const session = latestSession();
    const step = silenceStep(session, silences);
    if (step === "wait") return listen();
    goodbye = step === "goodbye";
    queued.push([message("system", silenceNote(step, session))]);
    advance();
  }

  // One answer to their words that also takes in everything held, like a text they just sent, so a question about
  // it ("look at my text") is answered knowing it.
  const answer = () => {
    const items = queued.splice(0).flat();
    queued.push(items);
    advance();
  };
  // Their words need an answer they can hear: the watchdog starts over for them, with its one re-ask. Never for the
  // opening, and never once the call is ending.
  const watch = () => {
    clearTimeout(deadAirTimer);
    answering = false;
    deadAirWaited = false;
    deadAirFrom = hello || !greeted || ending || goodbye || closed ? null : Date.now();
    if (deadAirFrom !== null) deadAirTimer = setTimeout(deadAir, DEAD_AIR_MS);
  };
  const unwatch = () => {
    clearTimeout(deadAirTimer);
    deadAirFrom = null;
  };
  // Their words are getting an answer, owed until the agent is heard, and a new answer can be asked for once more.
  const owe = () => {
    wordsOwed = true;
    reasked = false;
    watch();
  };
  // Their words have had nothing back for a while. A line busy with something the answer waits on (the agent still
  // playing, a lookup out, them talking, words that cut the agent still coming in, a reply on its way that is not stuck
  // yet) is looked at again in a moment. Otherwise the agent is asked once more, a tool result it owes riding along
  // (advance): at once when nothing is on its way, or once the stuck reply is cancelled. A response.create the server
  // never answered at all, not even with an error, is nothing on its way; if a reply was running after all, the server
  // refuses the new one and that reply's done moves the call on.
  function deadAir() {
    const from = deadAirFrom;
    if (from === null || closed || ending || goodbye || hello) return unwatch();
    const now = Date.now();
    const unanswered = pendingCreate !== null && now - askedAt >= DEAD_AIR_MS;
    const stuck = responding && !unanswered && now - Math.max(from, askedAt) >= STUCK_MS;
    if (playing || userSpeaking || awaiting.size > 0 || cutFor !== null || (responding && !unanswered && !stuck)) {
      // Still waiting this long is recorded once, with what it waits on, so a call that stays quiet says why.
      if (!deadAirWaited && now - from >= STUCK_MS) {
        deadAirWaited = true;
        const on = [playing && "playing", userSpeaking && "speaking", awaiting.size > 0 && "tool", cutFor !== null && "cut", responding && "reply"];
        report(["dead_air:wait", ...on.filter(Boolean)].join(":"));
      }
      deadAirTimer = setTimeout(deadAir, DEAD_AIR_CHECK_MS);
      return;
    }
    unwatch();
    queued.unshift([message("system", DEAD_AIR_NOTE), ...(queued.shift() ?? [])]);
    report(`dead_air:${stuck ? "cancel" : unanswered ? "unanswered" : "ask"}${toolOwed ? ":tool" : ""}`);
    if (unanswered) {
      pendingCreate = null;
      responding = false;
    }
    if (!stuck) return advance();
    if (held) return takeBack(advance);
    // Its done asks for the answer. A cancel the server refuses means nothing was running after all (the error case).
    deadAirCancel = `cancel_${tag}_${++createCount}`;
    send({ type: "response.cancel", event_id: deadAirCancel });
  }
  // Stops whatever the agent is saying. A reply still waiting on its first words was never heard, so it goes whole.
  const interrupt = () => {
    if (held) takeBack(advance);
    else if (responding) send({ type: "response.cancel" });
    // The voice stays silent until the audio it was cut from is gone.
    if (playing) {
      silenced = true;
      applyVolume();
      send({ type: "output_audio_buffer.clear" });
      clearTimeout(silencedTimer);
      silencedTimer = setTimeout(() => {
        silenced = false;
        applyVolume();
      }, SILENCED_CAP_MS);
    }
  };
  // Speech over the agent turned out to be its own echo or no words at all: that speech is taken out of the
  // conversation and the agent carries on from where it stopped.
  const carryOn = (itemId: string) => {
    clearTimeout(cutTimer);
    cutFor = null;
    report("carry_on");
    send({ type: "conversation.item.delete", item_id: itemId });
    cutAway.set(itemId, `${saying} ${lastReply}`);
    queued.unshift([message("system", CUT_OFF_NOTE)]);
    answer();
  };
  // Real words over the agent: it stops where it is and answers them.
  const bargeIn = () => {
    interrupt();
    owe();
    answer();
  };
  // The hello sentence has been heard. What they said over it cuts off the rest of the opening and gets its answer
  // now, once.
  const helloOut = () => {
    clearTimeout(helloTimer);
    clearTimeout(sentenceTimer);
    hello = false;
    if (!owed) return;
    owed = false;
    bargeIn();
  };

  // The hello's audio plays on for seconds after it is generated; it is out once every line of it has stopped playing.
  const helloDone = () => {
    clearTimeout(helloTimer);
    if (!hello || !helloGenerated || playing) return;
    if (helloStops >= helloLines.size) helloOut();
    else helloTimer = setTimeout(helloOut, HELLO_GAP_MS);
  };

  // Said as the model's own end_call, so the controller drains the goodbye and the server records why it ended.
  const endFor = (reason: "silence" | "user_request"): ServerEvent => ({
    type: "response.function_call_arguments.done",
    call_id: `${LOCAL_CALL}${tag}_${reason}`,
    name: "end_call",
    arguments: JSON.stringify({ reason }),
  });

  const itemOf = (event: ServerEvent) =>
    event.type === "response.output_audio_transcript.delta" ||
    event.type === "response.output_audio_transcript.done" ||
    event.type === "response.function_call_arguments.done"
      ? event.item_id
      : undefined;

  // Its first words are in and it is the reply it should be: it plays, and everything it held happens now, in order.
  function release() {
    const reply = held;
    if (!reply) return;
    held = null;
    clearTimeout(reply.timer);
    clearTimeout(reply.cap);
    retakes = 0;
    if (reply.opening && wordsOf(reply.text).length > 0) helloPassed = true;
    else if (helloPassed) pastOpening = true;
    applyVolume();
    for (const event of reply.events) dispatch(event);
  }

  // Never heard, so never said: the reply is cancelled, its audio cut, and its items taken out of the conversation.
  function takeBack(then: () => void) {
    const reply = held;
    if (!reply) return;
    held = null;
    clearTimeout(reply.timer);
    clearTimeout(reply.cap);
    if (!reply.done) send({ type: "response.cancel" });
    // Audio still playing is the reply before it, heard as it should be.
    if (!playing) send({ type: "output_audio_buffer.clear" });
    dropped = { items: reply.items, done: false, then };
    if (reply.done) dropDone();
  }

  function dropDone() {
    const drop = dropped;
    if (!drop || drop.done) return;
    drop.done = true;
    responding = false;
    // The model never builds on words nobody heard.
    for (const id of drop.items) send({ type: "conversation.item.delete", item_id: id });
    drop.then();
  }

  function judge(reply: Held, final: boolean) {
    // The opening says hello however the model likes: it plays once its words start (or it turns out to have none).
    if (reply.opening) {
      if (final || wordsOf(reply.text).length > 0) release();
      return;
    }
    const names = [first?.agentName?.value ?? "Persona", latestSession().agentName?.value ?? "Persona"];
    const verdict = opensWithHello(reply.text, names, final);
    if (verdict === null) return;
    // A reply with no words at all, like one that only calls a tool, has nothing to hold back.
    if (!verdict || reply.retakes >= MAX_RETAKES) return release();
    takeBack(() => {
      retakes = reply.retakes + 1;
      queued.unshift([message("system", HELLO_SAID_NOTE)]);
      answer();
    });
  }

  // The reply's own events wait with it until its first words are judged, and a taken-back reply's are dropped.
  function withhold(event: ServerEvent): boolean {
    if (!REPLY_EVENTS.has(event.type)) return false;
    // The audio of a reply already let through can still be playing out as the next one starts: its stop is its own.
    if (playing && (event.type === "output_audio_buffer.stopped" || event.type === "output_audio_buffer.cleared")) return false;
    if (dropped) {
      if (event.type !== "response.created") {
        const item = itemOf(event);
        if (item) dropped.items.add(item);
        if (event.type === "response.done") dropDone();
        return true;
      }
      dropped = null;
    }
    if (!held) {
      // The opening, the reply right after it, and any retry of a reply taken back for its hello are held until their
      // first words are in; every later reply plays as it comes.
      if (event.type !== "response.created" || (pastOpening && retakes === 0)) return false;
      held = { opening: !helloPassed, retakes, text: "", events: [], items: new Set(), done: false };
      held.cap = setTimeout(release, HOLD_CAP_MS);
      applyVolume();
    }
    const reply = held;
    reply.events.push(event);
    const item = itemOf(event);
    if (item) reply.items.add(item);
    if (event.type === "response.output_audio_transcript.delta") reply.text += event.delta;
    if (event.type === "response.output_audio_transcript.done" && !reply.text) reply.text = event.transcript;
    if (event.type === "output_audio_buffer.started") reply.timer ??= setTimeout(release, FIRST_WORDS_MS);
    if (event.type === "response.done") reply.done = true;
    judge(reply, event.type === "response.output_audio_transcript.done" || event.type === "response.done");
    return true;
  }

  const sender = micTrack ? pc.addTrack(micTrack, mic) : null;

  pc.ontrack = ({ track, streams: [stream] }) => {
    if (!stream) return;
    audio.srcObject = stream;
    remote?.close();
    remote = meterStream(stream);
    gotTrack(track);
  };
  pc.onconnectionstatechange = () => {
    if (!closed) handlers.onConnectionState(pc.connectionState);
  };
  channel.onmessage = ({ data }) => {
    traceRealtime(String(data));
    const event = parseServerEvent(String(data));
    if (!event || closed) return;
    // A reply started, so the create that asked for it went through, even when the reply is held or dropped below.
    if (event.type === "response.created") {
      pendingCreate = null;
      clearTimeout(retryTimer);
    }
    // Every reply's outcome and every error is recorded as it arrives, held and dropped replies included.
    if (event.type === "response.done") {
      deadAirCancel = null;
      report(doneCode(event));
    }
    if (event.type === "error") {
      const about = event.error?.event_id?.match(/^(create|cancel)_/)?.[1];
      report(["error", event.error?.code ?? "none", about].filter(Boolean).join(":"));
    }
    // The recognizer is already writing this line; the server's words replace it whole when they complete.
    if (event.type === "conversation.item.input_audio_transcription.delta" && captions?.owns(event.item_id)) return;
    if (!withhold(event)) dispatch(event);
  };

  function dispatch(event: ServerEvent) {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        userSpeaking = true;
        clearTimeout(settleTimer);
        // Its live caption waits for its words too, so an echo never shows as something they said.
        if (event.item_id && (hello || responding || playing || echoTail())) {
          overAgent.add(event.item_id);
          // They talk, it stops: no waiting on their words to be transcribed.
          if (!hello && (responding || playing)) {
            clearTimeout(cutTimer);
            cutFor = event.item_id;
            interrupt();
          }
          break;
        }
        heard();
        if (event.item_id) captions?.speechStarted(event.item_id);
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const said = event.transcript.trim();
        if (overAgent.delete(event.item_id)) {
          const cut = event.item_id === cutFor;
          if (isEcho(said, `${saying} ${lastReply}`)) {
            if (cut) carryOn(event.item_id);
            return;
          }
          heard();
          if (cut) {
            clearTimeout(cutTimer);
            cutFor = null;
            owe();
            answer();
          } else if (!hello) bargeIn();
          else if (!PICKUP.test(said)) owed = true;
        } else {
          // Words that came in after the agent had already carried on without them: the model never heard them, so
          // they go back in as text and get their answer.
          const cutOver = cutAway.get(event.item_id);
          cutAway.delete(event.item_id);
          if (cutOver !== undefined && !isEcho(said, `${cutOver} ${saying} ${lastReply}`)) {
            heard();
            queued.push([message("user", said)]);
            owe();
            answer();
          }
        }
        lastHeard = event.transcript;
        captions?.settled(event.item_id);
        break;
      }
      case "conversation.item.input_audio_transcription.failed": {
        // Speech that cut the agent off whose words could not be made out: they are asked to say it again. Any other
        // speech needs nothing.
        const id = event.item_id;
        const cut = id === cutFor;
        if (!cut && !cutAway.delete(id)) break;
        if (cut) {
          clearTimeout(cutTimer);
          cutFor = null;
          overAgent.delete(id);
        }
        heard();
        queued.push([message("system", SAY_AGAIN_NOTE)]);
        owe();
        answer();
        break;
      }
      case "response.created":
        responding = true;
        answering = deadAirFrom !== null;
        goodbye ||= goodbyeNext;
        goodbyeNext = false;
        replying = "";
        saying = "";
        quiet();
        break;
      case "response.output_audio_transcript.delta":
        saying += event.delta;
        if (hello) helloLines.add(event.item_id);
        // The answer's words joining audio still playing out may never report a start of their own: they are heard.
        if (answering && playing) unwatch();
        break;
      case "response.output_audio_transcript.done":
        replying = `${replying} ${event.transcript}`;
        lastReply = event.transcript;
        break;
      case "response.function_call_arguments.done":
        awaiting.add(event.call_id);
        followUp = true;
        if (event.name === "end_call") {
          ending = true;
          endCall = { id: event.call_id, goodbye };
          unwatch();
        }
        break;
      case "response.done": {
        responding = false;
        // The hello is out only once a reply that said it is: one with no words leaves it still to come.
        if (hello && helloPassed) helloGenerated = true;
        helloDone();
        if ((goodbye || isFarewell(lastHeard, replying)) && !ending) {
          ending = true;
          handlers.onEvent(endFor(goodbye ? "silence" : "user_request"));
        }
        // A reply that owed them an answer and came to nothing (it failed, broke off, or finished with no output at
        // all) is asked for once more, with whatever else is waiting. A cancel is decided by whoever cancelled, a
        // reply that called tools gets its answer once they return, and speech that cut it gets the next reply anyway.
        const status = event.response?.status;
        const output = event.response?.output;
        const nothing = status === "failed" || status === "incomplete" || (status === "completed" && Array.isArray(output) && output.length === 0);
        if (status === "failed" && event.response?.status_details?.error?.code === "rate_limit_exceeded") {
          limited += 1;
          holdUntil = Date.now() + (RATE_BACKOFF_MS[Math.min(limited, RATE_BACKOFF_MS.length) - 1] ?? 5_000);
          if (limited <= RATE_BACKOFF_MS.length) reasked = false;
        } else if (status === "completed") limited = 0;
        if (nothing && (wordsOwed || toolOwed) && !reasked && !followUp && !cutFor && !ending && !goodbye) {
          reasked = true;
          queued.unshift([message("system", UNHEARD_NOTE), ...(queued.shift() ?? [])]);
        }
        goodbye = false;
        break;
      }
      case "output_audio_buffer.started":
        playing = true;
        // They hear the agent now, so what it owed them is being said.
        wordsOwed = false;
        toolOwed = false;
        unwatch();
        clearTimeout(helloTimer);
        if (hello && helloPassed && first) sentenceTimer ??= setTimeout(helloOut, callGreeting(first).length * HELLO_MS_PER_CHAR);
        quiet();
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        playing = false;
        stoppedAt = Date.now();
        silenced = false;
        clearTimeout(silencedTimer);
        applyVolume();
        if (hello) helloStops += 1;
        helloDone();
        break;
      case "error": {
        // The watchdog's cancel of a stuck reply was refused, so nothing was running: its answer goes out now.
        if (deadAirCancel && event.error?.event_id === deadAirCancel) {
          deadAirCancel = null;
          pendingCreate = null;
          responding = false;
          advance();
          break;
        }
        // Only a refused response.create is handled: nothing else sent leaves the line waiting on a reply.
        const create = pendingCreate;
        if (!create || event.error?.event_id !== create.id) break;
        pendingCreate = null;
        // A reply is already running, and its done moves the call on.
        if (event.error?.code === "conversation_already_has_active_response") break;
        if (event.error?.code === "rate_limit_exceeded") holdUntil = Date.now() + (RATE_BACKOFF_MS[0] ?? 1_500);
        responding = false;
        report(create.retry ? "create_failed" : "create_retry");
        // Asked once more a moment later. If that is refused too, the line opens again, so the next thing they say is
        // answered and silence is timed again.
        if (!create.retry) retryTimer = setTimeout(() => !responding && !closed && !ending && respond(true), CREATE_RETRY_MS);
        else advance();
        break;
      }
    }
    handlers.onEvent(event);
    if (event.type === "response.done") advance();
    else if (event.type === "output_audio_buffer.stopped" || event.type === "output_audio_buffer.cleared") listen();
    else if (event.type === "input_audio_buffer.speech_stopped") {
      userSpeaking = false;
      // Said into silence, so it can only be them: answered now, without waiting for its words.
      if (event.item_id && !overAgent.has(event.item_id) && !hello) {
        owe();
        answer();
      }
      // Words that never arrive were not them talking either.
      const itemId = event.item_id;
      if (itemId && itemId === cutFor) cutTimer = setTimeout(() => overAgent.delete(itemId) && carryOn(itemId), CUT_HOLD_MS);
      listen();
      // The server answers what they said on its own; if it never starts a response (noise, an empty turn),
      // held news goes out anyway.
      clearTimeout(settleTimer);
      if (queued.length) settleTimer = setTimeout(advance, SPEECH_SETTLE_MS);
    }
  }

  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("realtime data channel did not open")), OPEN_TIMEOUT_MS);
    const settle = (error?: Error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    channel.addEventListener("open", () => settle(), { once: true });
    channel.addEventListener("close", () => settle(new Error("realtime data channel closed")), { once: true });
  });
  // start() awaits this; until then a close must not surface as an unhandled rejection.
  opened.catch(() => undefined);

  // The agent's audio can be heard: the element is playing, the peer is connected, and the remote track carries sound.
  const flowing = () =>
    Promise.all([
      audio.play().catch(() => undefined),
      when(pc, "connectionstatechange", () => pc.connectionState === "connected"),
      remoteTrack.then((track) => when(track, "unmute", () => !track.muted)),
    ]);

  return {
    async offer() {
      await pc.setLocalDescription(await pc.createOffer());
      return pc.localDescription?.sdp;
    },
    async start(connection, session, live) {
      if (connection.mode !== "live") throw new Error("expected a live connection");
      first = session;
      await pc.setRemoteDescription({ type: "answer", sdp: connection.sdp });
      await opened;
      if (closed) return;
      // The recognizer opens a capture of its own, which can reconfigure the audio devices, so it starts well before
      // the agent's first words rather than with them.
      captions = createLiveCaptions((itemId, text) => handlers.onEvent({ type: "local.user_caption", item_id: itemId, text }));
      if (micMuted) captions?.setMuted(true);
      await Promise.race([flowing(), delay(OPEN_WAIT_MS - OPEN_SETTLE_MS)]);
      if (closed) return;
      live?.();
      await delay(OPEN_SETTLE_MS);
      if (closed) return;
      greeted = true;
      send(message("system", openingNote(session)));
      respond();
    },
    sendToolOutput(callId, output) {
      if (callId.startsWith(LOCAL_CALL)) return;
      if (callId === endCall?.id && keepsCallOpen(output)) {
        ending = false;
        // The refused response may still be running; its end must not count as the goodbye being said.
        goodbye = false;
        goodbyeNext = endCall.goodbye;
        endCall = null;
        // The call goes on, so words of theirs still waiting on an answer get the watchdog back.
        if (wordsOwed && !goodbyeNext) watch();
      }
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
      answerTools ||= needsAnswer(output);
      linkResults.push(output);
      awaiting.delete(callId);
      advance();
    },
    sendNote(note) {
      const { system, user, respond: speak } = callNote(note, replying);
      // News from the thread restarts the patience for silence, as it does in the mock.
      silences = 0;
      if (!speak) {
        send(message("system", system));
        return;
      }
      queued.push([message("system", system), ...(user === undefined ? [] : [message("user", user)])]);
      // A text they sent mid-call is waiting on an answer too.
      if (note.note === "user_texted") watch();
      advance();
    },
    // Typed speech interrupts the agent the way the server's VAD does for spoken words: stop the response, cut
    // the audio still playing, then answer. It is reported as speech so barge-ins, latency and the transcript
    // count it exactly like something said out loud.
    sendUserText(text) {
      const itemId = `typed_${tag}_${++typed}`;
      heard();
      interrupt();
      handlers.onEvent({ type: "input_audio_buffer.speech_started" });
      handlers.onEvent({ type: "input_audio_buffer.speech_stopped" });
      handlers.onEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: text });
      lastHeard = text;
      queued.push([message("user", text)]);
      owe();
      advance();
    },
    // The controller owns the mic and disables its track; the server VAD simply hears silence. The recognizer
    // has a capture of its own, so it stops.
    setMuted(muted) {
      micMuted = muted;
      captions?.setMuted(muted);
    },
    setVolume(next) {
      volume = next;
      applyVolume();
    },
    async replaceMic(next) {
      const track = next.getAudioTracks()[0];
      if (!track || closed) return;
      micTrack = track;
      await sender?.replaceTrack(track);
    },
    resume() {
      if (!closed && audio.srcObject && audio.paused) void audio.play().catch(() => undefined);
    },
    agentLevel() {
      return remote?.read() ?? 0;
    },
    agentAudible() {
      return (remote?.db() ?? -Infinity) > AUDIBLE_DB;
    },
    close() {
      closed = true;
      quiet();
      clearTimeout(settleTimer);
      clearTimeout(cutTimer);
      clearTimeout(retryTimer);
      clearTimeout(holdTimer);
      clearTimeout(deadAirTimer);
      clearTimeout(helloTimer);
      clearTimeout(sentenceTimer);
      clearTimeout(held?.timer);
      clearTimeout(held?.cap);
      clearTimeout(silencedTimer);
      captions?.close();
      remote?.close();
      channel.close();
      pc.close();
      audio.srcObject = null;
    },
  };
}
