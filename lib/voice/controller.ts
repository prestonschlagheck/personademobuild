import { CUT_OFF } from "@/lib/agent/messages";
import { missingSlots } from "@/lib/agent/policy";
import { parseToolArgs } from "@/lib/agent/tools";
import type { CallAcceptResponse, ToolResponse } from "@/lib/api/contract";
import { api, ApiRequestError, beacon } from "@/lib/client/api";
import { voiceDiag, type VoiceDiag } from "@/lib/client/dev-trace";
import { sounds } from "@/lib/client/sounds";
import { callVolume, gainOf } from "@/lib/client/volume";
import { MIC_END_REASONS, type CallEndReason, type Filled, type Session, type SessionEvent, type Snapshot } from "@/lib/session/schema";
import { meterStream, speechEnvelope, type LevelSource } from "@/lib/voice/audio-level";
import {
  callView,
  INITIAL_CALL_STATE,
  micEndReason,
  micFailure,
  type Banner,
  type Caption,
  type CallFailure,
  type CallState,
  type DeclineAction,
  type LineFailure,
} from "@/lib/voice/call-state";
import { asksToHangUp, keepsCallOpen, threadNote, UNSPOKEN_END_CALL, valueNote } from "@/lib/voice/notes";
import { CaptionPace } from "@/lib/voice/caption-pace";
import { LOCAL_CALL, voiced, VOICE_SPEED, type ServerEvent, type TransportHandlers, type VoiceTransport } from "@/lib/voice/transport";
import { createWebRtcTransport } from "@/lib/voice/webrtc";

// The mock brain (lib/agent/mock/brain.ts and everything under it) never reaches a production bundle: only a call
// in mock mode loads it, and getModes() in lib/server/config.ts throws before mock mode is possible there. Loaded
// once and shared, so priming speechSynthesis on a gesture and building the call's own transport never race each
// other into two separate fetches of the same module.
let mockVoice: Promise<typeof import("@/lib/voice/mock")> | null = null;
const loadMockVoice = () => (mockVoice ??= import("@/lib/voice/mock"));

// The one owner of a call in this tab: the mic, the transport, the heartbeat, every way a call can
// end, and the screen state around it. The server stays the source of truth; this follows each
// snapshot and only ever reports intents to the call routes.

// How long a hangup waits for its last words to save before reporting the end.
const FLUSH_MS = 800;
// Inside the server's own ring timeout (RING_TIMEOUT_MS, 30 s in lib/server/call-timers.ts), which the answering tab
// keeps pinging past for as long as ANSWER_HOLD_MS (60 s) holds the ring while the mic prompt and offer are pending.
const MISSED_AFTER_MS = 25_000;
const OUTGOING_MIN_MS = 1_500;
const HEARTBEAT_MS = 5_000;
// The server gives a quiet call 10 s, room for one missed ping. A ping that fails (a blip, a 429) is tried again at
// once rather than a beat later, and each gives up on a half-open connection soon enough to leave room for that.
const HEARTBEAT_RETRY_MS = 1_000;
const HEARTBEAT_REQUEST_MS = 3_000;
// An end that fails is sent again after each of these waits (the route settles by attempt, so repeats are harmless),
// so the server never keeps a call this tab already hung up.
const END_RETRY_MS = [500, 1_000, 2_000];
const DISCONNECT_GRACE_MS = 8_000;
// How long past the goodbye's expected end the line stays open if the audio never reports that it stopped.
const GOODBYE_CAP_MS = 3_000;
// Speech runs about this long per transcript character at the voice's pace, to know when a goodbye should end.
const SPEECH_MS_PER_CHAR = 65;
const DONE_FLASH_MS = 900;
const ENDED_HOLD_MS = 1_000;
const BANNER_MS = 5_000;
// The recent lines the stage transcript can hold; older ones have scrolled up into its fade by then.
const CAPTION_LINES = 16;
// Speaker off: the agent drops to a quarter of the call volume, as if the phone were held to the ear.
const EARPIECE_VOLUME = 0.25;
// Accepting a live call waits on OpenAI creating it, which can take several seconds.
const ACCEPT_TIMEOUT_MS = 30_000;
// A text sent during the call reaches it once that text's own turn has answered, so whatever the turn saved is saved
// by text and the call only hears that it's done. A turn that runs long is waited on no longer than this.
const TEXT_HOLD_MS = 4_000;
// Another app holding the mic as a call is answered (a dictation tool, another call) often lets go in a moment.
const MIC_BUSY_RETRY_MS = [300, 700, 1_500];
// A mic the device takes away mid-call is opened again at once, then after each of these waits, then every last one
// for as long as the call lasts.
const MIC_REOPEN_MS = [500, 1_000, 2_000, 4_000];
// Back in the tab, a mic the phone muted while it was away gets this long to come back by itself.
const MIC_SETTLE_MS = 1_000;

type Call = {
  attempt: number;
  sessionId: string;
  accepted: boolean;
  connectedAt: number;
  mic: MediaStream | null;
  micLevel: LevelSource | null;
  transport: VoiceTransport | null;
  seenSeq: number;
  missing: number;
  valueNoted: boolean;
  speechStoppedAt: number | null;
  latencyMs: number | null;
  /** Transcript items already saved, so a hangup can flush only the words still in flight. */
  saved: Set<string>;
  /** The agent line each of their utterances started over, so their words save after what they talked over. */
  over: Map<string, string | null>;
  /** Their words waiting on the agent line they talked over to be heard out and saved first. */
  waiting: { id: string; text: string; after: string }[];
  /** Transcript saves still on their way, which a hangup waits for so the end is judged on every line. */
  inFlight: Set<Promise<void>>;
  /** The name the call goes by, so a rename by text reaches it. */
  agentName: string | null;
  /** The current response has speech that has not finished playing, even if playback has not started yet. */
  unplayed: boolean;
  spokenChars: number;
  playbackStartedAt: number | null;
  ending: "requested" | "draining" | null;
  /** Their latest finished words, which say whether an end_call with nothing said is them asking to hang up. */
  lastHeard: string;
  /** A wordless end_call was already sent back since their last words, so the next one goes through. */
  silentEndRefused: boolean;
  /** Texts sent during the call, in order, waiting for their turn to answer before the call hears them. */
  held: { event: SessionEvent; at: number }[];
  heldTimer?: ReturnType<typeof setTimeout>;
  /** A live call's record of how its replies went, as codes with no words, sent with the heartbeat and at the end. */
  diag: VoiceDiag | null;
  /** A mic being opened again right now, so a second trigger never opens two. */
  reopening: boolean;
  micRetry?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  heartbeatRetry?: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
  goodbye?: ReturnType<typeof setTimeout>;
};

function requestMic() {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new DOMException("no media devices", "NotSupportedError"));
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const stopMic = (mic: MediaStream | null) => mic?.getTracks().forEach((track) => track.stop());

// Asks again while the mic is busy, so a mic another app lets go of a moment later still answers the call.
async function openMic(first: Promise<MediaStream>, current: () => boolean) {
  let failure: unknown;
  try {
    return await first;
  } catch (error) {
    failure = error;
  }
  for (const wait of MIC_BUSY_RETRY_MS) {
    if (micFailure(failure) !== "busy" || !current()) break;
    await delay(wait);
    try {
      return await requestMic();
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

// Saved by a text turn since `at`: the turn that answered a text sent then.
const savedByText = (slot: Filled | null, at: string) => slot?.source === "text" && slot.setAt >= at;

/** A call this tab ended, kept until the server has settled it. */
type EndedCall = { sessionId: string; attempt: number; reason: CallEndReason; sending: boolean };

/** Why the server refused a dial or an answer, when it was the line that said no rather than the connection. */
function lineFailure(error: unknown): LineFailure | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.status === 429) return "rate_limited";
  if (error.status !== 409) return null;
  switch (error.body?.error) {
    case "call_active":
    case "call_in_other_tab":
      return "elsewhere";
    case "call_ringing":
      return "ringing";
    default:
      return "gone";
  }
}

export class CallController {
  private state = INITIAL_CALL_STATE;
  private readonly listeners = new Set<() => void>();
  // Captions change with every word, so they have their own subscribers: a delta repaints the transcript, not the phone.
  private captions: Caption[] = [];
  private readonly captionListeners = new Set<() => void>();
  // The agent's words show as it says them, not as soon as Realtime sends them (lib/voice/caption-pace.ts), cleaned up
  // the way the saved line is, and a line is saved once it has been heard, as much of it as was.
  private readonly pace = new CaptionPace(
    (id, text) => this.caption(id, "agent", voiced(text), "replace"),
    VOICE_SPEED,
    undefined,
    (id, text, cut) => this.agentHeard(id, text, cut),
  );
  private snapshot: Snapshot | null = null;
  // Attempt numbers restart with every session, so all per-call bookkeeping is keyed by it.
  private sessionId: string | null = null;
  private call: Call | null = null;
  // The ring this tab placed and has not connected yet. Only it may open the mic for a call the user dialed.
  private dialed: number | null = null;
  private ended: EndedCall | null = null;
  private ringAttempt = 0;
  private bannerSeq = -1;
  private tickFrom = 0;
  private ticker?: ReturnType<typeof setInterval>;
  private missedTimer?: ReturnType<typeof setTimeout>;
  private bannerTimer?: ReturnType<typeof setTimeout>;
  private flashTimer?: ReturnType<typeof setTimeout>;
  private holdTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly publish: (next: Snapshot | null) => void) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getState = () => this.state;

  subscribeCaptions = (listener: () => void) => {
    this.captionListeners.add(listener);
    return () => void this.captionListeners.delete(listener);
  };

  getCaptions = () => this.captions;

  /** Wires page lifecycle and audio unlocking. Returns the cleanup. */
  mount = () => {
    const onPageHide = (event: PageTransitionEvent) => {
      const call = this.call;
      if (event.persisted || !call || !this.live()) return;
      beacon("/api/call/end", { attempt: call.attempt, reason: "tab_closed" });
    };
    // Back from another tab or app, which on a phone can pause the agent's audio or mute the mic without ending the call.
    const onVisible = () => {
      const call = this.call;
      if (document.hidden || !call || !this.live()) return;
      call.transport?.resume();
      this.reopenMic(call, MIC_SETTLE_MS);
    };
    const onGesture = () => {
      sounds.unlock();
      // Only the mock voice speaks through speechSynthesis; a live call never needs it primed.
      if (this.snapshot?.modes.voice === "mock") void loadMockVoice().then((m) => m.primeSpeech());
      window.removeEventListener("click", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("click", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
    const unsubscribeVolume = callVolume.subscribe(() => this.call && this.applyVolume(this.call));
    return () => {
      unsubscribeVolume();
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("click", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      this.teardown();
    };
  };

  /** Follows every new snapshot: remote hangups, notes for the agent, rings, banners, the timer. */
  sync = (snapshot: Snapshot | null) => {
    const previous = this.snapshot;
    // A render can lag behind a snapshot this controller already adopted from its own request.
    if (previous && snapshot && previous.session.id === snapshot.session.id && snapshot.session.version < previous.session.version) return;
    this.snapshot = snapshot;
    if (!snapshot) return;
    // A reset publishes null before the new session arrives, so the id is tracked apart from the snapshot.
    if (snapshot.session.id !== this.sessionId) {
      if (this.sessionId !== null) this.teardown();
      this.sessionId = snapshot.session.id;
    }

    const call = this.call;
    if (call && this.live()) this.follow(call, snapshot);
    this.watchEnded(snapshot.session);
    this.watchRing(snapshot.session);
    this.watchBanner(snapshot);
    this.updateTicker();
  };

  /** Places a call from this tab. Another tab, or this one after a reload, sees the ring but never picks it up. */
  dial = () => {
    // The tap that dials starts the page's audio, so it runs well before the call's does.
    sounds.unlock();
    const before = this.snapshot?.session.call.attempts ?? 0;
    api<Snapshot>("/api/call/start", { body: { initiator: "user" } }).then(
      (next) => {
        if (!next) return;
        const { call } = next.session;
        if (call.status === "ringing" && call.initiator === "user" && call.attempts > before) this.dialed = call.attempts;
        this.apply(next);
        // A poll may have delivered this ring first, and the provider never syncs the same snapshot twice.
        this.sync(this.snapshot);
      },
      (error: unknown) => this.refuseDial(lineFailure(error) ?? "failed"),
    );
  };

  accept = () => {
    const session = this.snapshot?.session;
    if (!session || session.call.status !== "ringing" || this.state.phase !== "idle") return;
    // As on a dial, the answering tap starts the page's audio well before the call's.
    sounds.unlock();
    sounds.stopRing();
    if (this.snapshot?.modes.voice === "mock") void loadMockVoice().then((m) => m.primeSpeech());
    this.begin(session, "agent");
  };

  decline = (action: DeclineAction) => {
    const session = this.snapshot?.session;
    if (!session || session.call.status !== "ringing" || this.state.phase !== "idle") return;
    const attempt = session.call.attempts;
    if (this.state.dismissed === attempt) return;
    sounds.stopRing();
    clearTimeout(this.missedTimer);
    this.set({ dismissed: attempt });
    api<Snapshot>("/api/call/decline", { body: { attempt, action } }).then(this.apply, () => undefined);
  };

  hangUp = () => {
    if (this.call) this.end(this.call, "user_hangup");
  };

  toggleMute = () => {
    if (!this.live()) return;
    this.set({ muted: !this.state.muted });
    if (this.call) this.applyMute(this.call);
  };

  toggleSpeaker = () => {
    this.set({ speaker: !this.state.speaker });
    if (this.call) this.applyVolume(this.call);
  };

  /** Typed speech, from "Type to talk" or a simulation. Both transports treat it like a recognized utterance, barge-in included. */
  say = (text: string) => {
    if (this.state.phase === "active") this.call?.transport?.sendUserText(text);
  };

  showMessages = () => this.set({ minimized: true, banner: null });

  returnToCall = () => this.set({ minimized: false });

  dismissBanner = () => {
    clearTimeout(this.bannerTimer);
    if (this.state.banner) this.set({ banner: null });
  };

  /** The loudness the island waveform shows: the agent while it talks, otherwise the mic. Read every frame. */
  level = () => {
    const call = this.call;
    if (!call || this.state.phase !== "active") return 0;
    const { agentSpeaking, userSpeaking, muted } = this.state;
    // A meter the browser starves (a context it holds suspended) reads exactly 0, so while someone is talking the
    // waveform falls back to a speech envelope instead of lying flat.
    this.envelope.setSpeaking(agentSpeaking || (userSpeaking && !muted));
    const stand = this.envelope.read();
    const agent = call.transport?.agentLevel() ?? 0;
    const mic = call.micLevel?.read() ?? 0;
    if (agentSpeaking) return agent || stand;
    return muted ? 0 : mic || stand;
  };
  private envelope = speechEnvelope();

  private set(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // Snapshots from our own requests are adopted at once, so the mock brain's next turn never reads
  // state older than the tool result it just caused. Everything still flows out through the provider.
  private apply = (next: Snapshot | null) => {
    if (next && (!this.snapshot || next.session.version >= this.snapshot.session.version)) this.snapshot = next;
    this.publish(next);
  };

  private live() {
    return this.state.phase === "connecting" || this.state.phase === "active";
  }

  // A dial the server turned down (another tab has the line, too many calls) never opens the mic. The call screen says
  // why for a moment, the way a phone shows "Call Failed", then steps aside.
  private refuseDial(failure: CallFailure) {
    if (this.state.phase !== "idle") return;
    clearTimeout(this.holdTimer);
    this.set({ phase: "ended", initiator: "user", minimized: false, failure });
    sounds.play("end");
    this.holdTimer = setTimeout(() => {
      if (this.call || this.state.phase !== "ended") return;
      this.set({ phase: "idle", initiator: null, failure: null });
      this.sync(this.snapshot);
    }, ENDED_HOLD_MS);
  }

  private begin(session: Session, initiator: "agent" | "user") {
    // First, so the permission prompt belongs to the click that answered.
    const mic = requestMic();
    const call: Call = {
      attempt: session.call.attempts,
      sessionId: session.id,
      accepted: false,
      connectedAt: 0,
      mic: null,
      micLevel: null,
      transport: null,
      seenSeq: 0,
      missing: 0,
      valueNoted: false,
      speechStoppedAt: null,
      latencyMs: null,
      saved: new Set(),
      over: new Map(),
      waiting: [],
      inFlight: new Set(),
      agentName: session.agentName?.value ?? null,
      unplayed: false,
      spokenChars: 0,
      playbackStartedAt: null,
      ending: null,
      lastHeard: "",
      silentEndRefused: false,
      held: [],
      diag: null,
      reopening: false,
    };
    clearTimeout(this.holdTimer);
    clearTimeout(this.missedTimer);
    this.call = call;
    this.setCaptions([]);
    this.set({
      phase: "connecting",
      initiator,
      minimized: false,
      muted: false,
      speaker: true,
      agentSpeaking: false,
      userSpeaking: false,
      toolsInFlight: 0,
      flashing: false,
      seconds: 0,
      failure: null,
    });
    // Pinged from the answer on: a ring is held while its mic prompt is up, and a live call's clock runs from the accept.
    this.startHeartbeat(call);
    void this.connect(call, session, mic, initiator === "user" ? OUTGOING_MIN_MS : 0);
  }

  private async connect(call: Call, session: Session, micRequest: Promise<MediaStream>, minMs: number) {
    // A dialed call shows "calling" for a beat, but that floor runs alongside the connect instead of ahead of it.
    const floor = delay(minMs);
    // Every await can outlive the call: a hangup, a remote end or a reset may land in between.
    const current = () => this.call === call && this.live();
    // Only a server that says it has no OpenAI key gets the local stand-in; anything else is a real Realtime call.
    const live = this.snapshot?.modes.voice !== "mock";
    if (live) call.diag = voiceDiag();
    let mic: MediaStream | null;
    try {
      mic = await openMic(micRequest, current);
    } catch (error) {
      if (!current()) return;
      // The mock agent needs no audio in: it still speaks, and the user can type to talk.
      if (!live) mic = null;
      else {
        // Each mic problem is reported as itself, so the text after says the right fix.
        const failure = micFailure(error);
        this.set({ failure });
        this.end(call, micEndReason(failure));
        return;
      }
    }
    if (!current()) {
      stopMic(mic);
      return;
    }

    try {
      // The mic is claimed by the call before the transport exists, so a failure below still lets go of it.
      call.mic = mic;
      call.micLevel = mic ? meterStream(mic) : null;
      if (mic) this.watchMic(call, mic);

      const handlers: TransportHandlers = {
        onEvent: (event) => this.onEvent(call, event),
        onConnectionState: (state) => this.onConnectionState(call, state),
        onDiag: (code) => call.diag?.add(code),
      };
      const latest = () => this.snapshot?.session ?? session;
      // Only the live branch needs Realtime's WebRTC glue; the mock brain loads only when it is actually used.
      const transport = live && mic ? createWebRtcTransport(mic, handlers, latest) : (await loadMockVoice()).createMockTransport(handlers, latest);
      call.transport = transport;
      this.pace.listen(transport.agentAudible?.bind(transport) ?? null);
      this.applyMute(call);
      this.applyVolume(call);

      const sdp = await transport.offer();
      if (!current()) return;
      const response = await api<CallAcceptResponse>("/api/call/accept", {
        body: { attempt: call.attempt, sdp },
        timeoutMs: ACCEPT_TIMEOUT_MS,
      });
      if (!response) throw new Error("empty accept response");
      const { connection, ...snapshot } = response;
      if (!current()) {
        // Hung up while the accept was in flight: the server now holds an active call, so end it.
        this.report(call, "user_hangup");
        return;
      }
      call.accepted = true;
      call.seenSeq = snapshot.lastSeq;
      call.missing = missingSlots(snapshot.session).length;
      this.apply(snapshot);
      await floor;
      if (!current()) return;
      // The call shows as connected, with its cue, as the line comes up and a moment before the agent's first words, so
      // nothing else starts in the audio just as they do.
      await transport.start(connection, snapshot.session, () => current() && this.connected(call));
      if (current() && this.state.phase !== "active") this.connected(call);
    } catch (error) {
      if (!current()) return;
      const refused = lineFailure(error);
      this.set({ failure: refused ?? "failed" });
      // 409: another tab answered first, or the ring already ended. The server has the record, so nothing is reported.
      if (refused && refused !== "rate_limited") return this.close(call, true);
      // A refused accept (429) leaves the ring up with nobody allowed to take it, so it ends like any failed connect.
      this.end(call, "error");
    }
  }

  private startHeartbeat(call: Call) {
    const ping = (retry: boolean) => {
      // Codes that say something went wrong ride along, so the record is kept even if the tab just closes.
      const diag = call.diag?.take(false) ?? [];
      const body = { attempt: call.attempt, ...(diag.length > 0 && { diag }) };
      return api("/api/call/heartbeat", { body, timeoutMs: HEARTBEAT_REQUEST_MS }).catch((error: unknown) => {
        call.diag?.restore(diag);
        if (this.call !== call || !this.live()) return;
        // 409: the server already ended this call (a timeout, another tab), so this tab lets go too.
        if (error instanceof ApiRequestError && error.status === 409) return this.close(call, false);
        // Anything else (a 429, a blip, a timeout) is a missed beat, not an ended call.
        if (retry) return;
        clearTimeout(call.heartbeatRetry);
        call.heartbeatRetry = setTimeout(() => ping(true), HEARTBEAT_RETRY_MS);
      });
    };
    void ping(false);
    call.heartbeat = setInterval(() => void ping(false), HEARTBEAT_MS);
  }

  // Only a hangup ends a call. When the device ends the mic instead (another app or tab took it, dictation, a headset
  // unplugged), it is opened again and sent in place of the old one, and the call carries on.
  private watchMic(call: Call, mic: MediaStream) {
    for (const track of mic.getAudioTracks()) track.addEventListener("ended", () => this.reopenMic(call, 0), { once: true });
  }

  private micHears(call: Call) {
    return call.mic?.getAudioTracks().some((track) => track.readyState === "live" && !track.muted) ?? false;
  }

  // Once `wait` has passed, unless the mic came back by itself, and again after every failure while the call lasts.
  private reopenMic(call: Call, wait: number, tries = 0) {
    // A call with no mic (the mock after a refused prompt) never asks for one mid-call.
    if (!call.mic) return;
    clearTimeout(call.micRetry);
    call.micRetry = setTimeout(() => {
      if (this.call !== call || !this.live() || call.reopening || this.micHears(call)) return;
      call.reopening = true;
      requestMic().then(
        async (mic) => {
          call.reopening = false;
          if (this.call !== call || !this.live()) return stopMic(mic);
          // The old mic stays the call's mic until the swap actually lands, so a rejected replaceTrack
          // (InvalidStateError, InvalidModificationError) leaves the call on the mic it already had.
          try {
            await call.transport?.replaceMic(mic);
          } catch {
            stopMic(mic);
            this.reopenMic(call, MIC_REOPEN_MS[Math.min(tries, MIC_REOPEN_MS.length - 1)] ?? 0, tries + 1);
            return;
          }
          const old = call.mic;
          call.mic = mic;
          call.micLevel?.close();
          call.micLevel = meterStream(mic);
          this.applyMute(call);
          this.watchMic(call, mic);
          stopMic(old);
          call.transport?.resume();
        },
        () => {
          call.reopening = false;
          this.reopenMic(call, MIC_REOPEN_MS[Math.min(tries, MIC_REOPEN_MS.length - 1)] ?? 0, tries + 1);
        },
      );
    }, wait);
  }

  private connected(call: Call) {
    call.connectedAt = Date.now();
    this.set({ phase: "active", seconds: 0 });
    sounds.play("connect");
    this.updateTicker();
  }

  private applyMute(call: Call) {
    const { muted } = this.state;
    for (const track of call.mic?.getAudioTracks() ?? []) track.enabled = !muted;
    call.transport?.setMuted(muted);
  }

  // The call volume, turned down to the earpiece level when the speaker is off.
  private applyVolume(call: Call) {
    call.transport?.setVolume(gainOf(callVolume.read()) * (this.state.speaker ? 1 : EARPIECE_VOLUME));
  }

  private follow(call: Call, snapshot: Snapshot) {
    const { session } = snapshot;
    const ours = session.call.attempts === call.attempt;
    const alive = ours && (session.call.status === "active" || (!call.accepted && session.call.status === "ringing"));
    // Ended somewhere else: the server's heartbeat timeout, another tab, or a ring that ran out.
    if (!alive) return this.close(call, false);
    if (this.state.phase !== "active") return;

    const missing = missingSlots(session).length;
    if (missing < call.missing) this.flash();
    call.missing = missing;

    // Renamed over text mid-call: the call takes the new name before it hears the text that asked for it.
    const name = session.agentName;
    if (name && name.value !== call.agentName) {
      call.agentName = name.value;
      if (name.source === "text") call.transport?.sendNote({ note: "renamed", text: name.value });
    }

    // Tell the call as soon as the connect is saved, not when the thread's text about it lands a second or two later.
    // What it hears is computed in code (valueNote), never the thread's wording around it.
    const { gmail, call: live } = session;
    const connectedThisCall = gmail.status === "connected" && !!gmail.connectedAt && !!live.startedAt && gmail.connectedAt >= live.startedAt;
    if (connectedThisCall && !call.valueNoted) {
      call.valueNoted = true;
      call.transport?.sendNote(valueNote(session));
    }

    for (const event of snapshot.events) {
      if (event.seq <= call.seenSeq) continue;
      const note = threadNote(event, session);
      if (!note || (note.note === "value_moment" && call.valueNoted)) continue;
      if (note.note === "value_moment") call.valueNoted = true;
      if (note.note === "user_texted") call.held.push({ event, at: Date.now() });
      else call.transport?.sendNote(note);
    }
    call.seenSeq = Math.max(call.seenSeq, snapshot.lastSeq);
    this.releaseTexts(call);
  }

  // Without the wait, the call answers a text before the text's own turn has saved it, and saves it itself, as said on
  // the call. A turn has answered once a reply follows the text, or once something it saved shows.
  private releaseTexts(call: Call) {
    clearTimeout(call.heldTimer);
    const snapshot = this.snapshot;
    if (this.call !== call || this.state.phase !== "active" || !snapshot) return;
    const { session, events } = snapshot;
    for (let next = call.held[0]; next; next = call.held[0]) {
      const { event, at } = next;
      const saved = (["userName", "helpNeed"] as const).filter((slot) => savedByText(session[slot], event.at));
      const answered =
        saved.length > 0 ||
        savedByText(session.agentName, event.at) ||
        events.some((e) => e.seq > event.seq && e.channel === "text" && e.role === "agent");
      const wait = at + TEXT_HOLD_MS - Date.now();
      if (!answered && wait > 0) {
        call.heldTimer = setTimeout(() => this.releaseTexts(call), wait);
        return;
      }
      call.held.shift();
      call.transport?.sendNote({ note: "user_texted", text: event.content, ...(saved.length > 0 && { saved }) });
    }
  }

  private watchRing(session: Session) {
    const { status, attempts, initiator } = session.call;
    if (status !== "ringing") {
      clearTimeout(this.missedTimer);
      return;
    }
    if (this.state.phase !== "idle") return;

    if (initiator === "user") {
      if (attempts === this.dialed) {
        this.dialed = null;
        this.begin(session, "user");
      }
      return;
    }

    // Timed from when this tab first saw the ring, so a skewed clock cannot miss the call early.
    if (attempts === this.ringAttempt) return;
    this.ringAttempt = attempts;
    clearTimeout(this.missedTimer);
    this.missedTimer = setTimeout(() => this.decline("missed"), MISSED_AFTER_MS);
  }

  private watchBanner(snapshot: Snapshot) {
    const { events, lastSeq } = snapshot;
    // History never raises a banner, only what arrives while the call screen is up.
    if (this.bannerSeq < 0) {
      this.bannerSeq = lastSeq;
      return;
    }
    const fresh = events.filter((e) => e.seq > this.bannerSeq && e.channel === "text" && e.role === "agent");
    this.bannerSeq = Math.max(this.bannerSeq, lastSeq);
    const { fullscreen, screen } = callView(snapshot.session, this.state);
    // Prefer the words over a link card, and name a card by its title rather than its URL.
    const event = fresh.findLast((e) => !e.meta?.link) ?? fresh.at(-1);
    // Only a connected call gets banners: on the ring screen one would cover the caller's name.
    if (!event || !fullscreen || screen !== "active") return;
    const banner: Banner = { id: event.id, text: event.meta?.link?.title ?? event.content };
    this.set({ banner });
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(this.dismissBanner, BANNER_MS);
  }

  // A poll that still shows a call this tab ended as live means its end never landed, so it goes again.
  private watchEnded(session: Session) {
    const ended = this.ended;
    if (!ended || ended.sessionId !== session.id) return;
    const { status, attempts } = session.call;
    if (attempts !== ended.attempt || (status !== "active" && status !== "ringing")) {
      this.ended = null;
      return;
    }
    if (!ended.sending) this.sendEnd(ended);
  }

  private updateTicker() {
    const session = this.snapshot?.session;
    const otherTab = this.state.phase === "idle" && session?.call.status === "active" && session.call.attempts !== this.state.closed;
    const from =
      this.state.phase === "active" && this.call ? this.call.connectedAt : otherTab ? Date.parse(session.call.startedAt ?? "") || 0 : 0;
    this.tickFrom = from;
    if (!from) {
      clearInterval(this.ticker);
      this.ticker = undefined;
      return;
    }
    this.ticker ??= setInterval(this.tick, 1_000);
    this.tick();
  }

  private tick = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - this.tickFrom) / 1_000));
    if (this.tickFrom && seconds !== this.state.seconds) this.set({ seconds });
  };

  private flash() {
    clearTimeout(this.flashTimer);
    this.set({ flashing: true });
    this.flashTimer = setTimeout(() => this.set({ flashing: false }), DONE_FLASH_MS);
  }

  private onConnectionState(call: Call, state: RTCPeerConnectionState) {
    if (this.call !== call) return;
    if (state === "connected") {
      clearTimeout(call.grace);
      call.grace = undefined;
    } else if (state === "disconnected") {
      // ICE often recovers on its own; give it a moment before calling the line dead.
      call.grace ??= setTimeout(() => this.end(call, "network"), DISCONNECT_GRACE_MS);
    } else if (state === "failed" || state === "closed") {
      this.end(call, "network");
    }
  }

  private onEvent(call: Call, event: ServerEvent) {
    if (this.call !== call) return;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        if (event.item_id) call.over.set(event.item_id, this.pace.hearing());
        this.set({ userSpeaking: true });
        break;
      case "input_audio_buffer.speech_stopped":
        call.speechStoppedAt = performance.now();
        this.set({ userSpeaking: false });
        break;
      case "conversation.item.input_audio_transcription.delta":
        this.caption(event.item_id, "user", event.delta, "append");
        break;
      case "local.user_caption":
        if (!call.saved.has(event.item_id)) this.caption(event.item_id, "user", event.text, "replace");
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.caption(event.item_id, "user", event.transcript, "replace");
        if (event.transcript.trim()) {
          call.lastHeard = event.transcript;
          call.silentEndRefused = false;
        }
        this.userSaid(call, event.item_id, event.transcript);
        break;
      // The agent's captions read in the product voice, lowercase, as its thread rows are saved.
      case "response.output_audio_transcript.delta":
        call.unplayed = true;
        call.spokenChars += event.delta.length;
        this.pace.add(event.item_id, event.delta.toLowerCase());
        break;
      case "response.output_audio_transcript.done":
        this.pace.final(event.item_id, event.transcript.toLowerCase());
        break;
      case "response.function_call_arguments.done":
        void this.relayTool(call, event);
        break;
      case "output_audio_buffer.started": {
        const latency = call.speechStoppedAt === null ? null : Math.round(performance.now() - call.speechStoppedAt);
        call.speechStoppedAt = null;
        if (latency !== null) call.latencyMs = latency;
        call.playbackStartedAt = performance.now();
        this.pace.started();
        this.set({ agentSpeaking: true, lastLatencyMs: latency ?? this.state.lastLatencyMs });
        break;
      }
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        if (event.type === "output_audio_buffer.stopped") this.pace.stopped();
        else this.pace.cleared();
        call.unplayed = false;
        this.set({ agentSpeaking: false });
        if (call.ending === "draining") this.end(call, "agent_end");
        break;
      case "response.created":
        call.spokenChars = 0;
        break;
      case "response.done":
        if (event.response?.status === "cancelled") this.pace.cancelled();
        if (call.ending === "requested") this.drain(call);
        break;
      case "input_audio_buffer.timeout_triggered":
      case "error":
        break;
    }
  }

  private caption(id: string, role: Caption["role"], text: string, mode: "append" | "replace") {
    const captions = this.captions.slice();
    const index = captions.findIndex((c) => c.id === id);
    const existing = captions[index];
    if (existing) captions[index] = { ...existing, text: mode === "append" ? existing.text + text : text };
    else if (text.trim()) captions.push({ id, role, text });
    else return;
    this.setCaptions(captions.slice(-CAPTION_LINES));
  }

  private setCaptions(captions: Caption[]) {
    if (captions === this.captions || (captions.length === 0 && this.captions.length === 0)) return;
    this.captions = captions;
    for (const listener of this.captionListeners) listener();
  }

  private transcript(call: Call, itemId: string, role: Caption["role"], raw: string) {
    const text = raw.trim().slice(0, 2_000);
    if (!text || call.saved.has(itemId)) return Promise.resolve();
    call.saved.add(itemId);
    const latencyMs = role === "agent" ? call.latencyMs ?? undefined : undefined;
    if (role === "agent") call.latencyMs = null;
    const saving = api("/api/call/transcript", { body: { attempt: call.attempt, itemId, role, text, latencyMs } }).then(
      () => void call.inFlight.delete(saving),
      () => void call.inFlight.delete(saving),
    );
    call.inFlight.add(saving);
    return saving;
  }

  // A line of the agent's is saved once it has been heard: whole, or as far as the voice got before it was cut off.
  private agentHeard(id: string, text: string, cut: boolean) {
    const call = this.call;
    if (!call) return;
    const said = text.trim();
    if (said) void this.transcript(call, id, "agent", cut ? `${said}...` : said);
    this.releaseWaiting(call);
  }

  // Their words save in the order things were said: after the agent line they talked over, once that line is saved.
  private userSaid(call: Call, id: string, text: string) {
    const after = call.over.get(id) ?? null;
    call.over.delete(id);
    if (after !== null && this.pace.pending(after)) call.waiting.push({ id, text, after });
    else void this.transcript(call, id, "user", text);
  }

  private releaseWaiting(call: Call) {
    while (call.waiting[0] && !this.pace.pending(call.waiting[0].after)) {
      const next = call.waiting.shift();
      if (next) void this.transcript(call, next.id, "user", next.text);
    }
  }

  // The goodbye is generated faster than it plays, and its audio can start after the response is done, so the line
  // closes when playback stops. The cap only covers a stop that never arrives.
  private drain(call: Call) {
    call.ending = "draining";
    if (!this.state.agentSpeaking && !call.unplayed) this.end(call, "agent_end");
    else call.goodbye = setTimeout(() => this.end(call, "agent_end"), this.speechLeft(call) + GOODBYE_CAP_MS);
  }

  private async relayTool(call: Call, event: Extract<ServerEvent, { type: "response.function_call_arguments.done" }>) {
    // A goodbye has to be heard: an end_call with nothing said in its response goes back to the model once. It goes
    // through when they asked to hang up, or on a second one in a row, so a bare end_call never loops the line in
    // silence; the text after the call carries the goodbye.
    const silent = event.name === "end_call" && call.spokenChars === 0 && !event.call_id.startsWith(LOCAL_CALL);
    if (silent && !asksToHangUp(call.lastHeard) && !call.silentEndRefused) {
      call.silentEndRefused = true;
      call.diag?.add("silent_end_call");
      call.transport?.sendToolOutput(event.call_id, UNSPOKEN_END_CALL);
      return;
    }
    // A wordless one has nothing to play out, so it closes the line only on the server's yes, below.
    if (event.name === "end_call" && !silent) call.ending ??= "requested";
    this.set({ toolsInFlight: this.state.toolsInFlight + 1 });
    let output: ToolResponse["output"] = { ok: false, error: "tool_unreachable", state: "" };
    try {
      const response = await api<ToolResponse>("/api/tool", {
        body: { attempt: call.attempt, toolCallId: event.call_id, name: event.name, args: parseToolArgs(event.arguments) },
      });
      if (response) {
        const { output: result, ...snapshot } = response;
        output = result;
        this.apply(snapshot);
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.body) output = { ok: false, error: error.body.error, hint: error.body.hint, state: "" };
    }
    if (this.call !== call) return;
    // Refused on the call's own opening: the line stays open and the model answers the refusal.
    if (event.name === "end_call" && keepsCallOpen(output)) {
      call.ending = null;
      clearTimeout(call.goodbye);
    }
    call.transport?.sendToolOutput(event.call_id, output);
    this.set({ toolsInFlight: Math.max(0, this.state.toolsInFlight - 1) });
    if (silent && output.ok) this.drain(call);
  }

  private speechLeft(call: Call) {
    const start = call.playbackStartedAt ?? performance.now();
    return Math.max(0, start + call.spokenChars * SPEECH_MS_PER_CHAR - performance.now());
  }

  // Words still in flight when the line went, on either side, marked as cut off, in the order they were said. Their
  // finished words waiting on the agent's line go in whole. Speech the recognizer had not written down yet still means
  // they were mid-sentence.
  private cutOffLines(call: Call): Caption[] {
    const whole = new Map(call.waiting.map((w) => [w.id, w.text]));
    call.waiting = [];
    const lines = this.captions
      .filter((c) => !call.saved.has(c.id) && c.text.trim())
      .map((c) => ({ ...c, text: whole.get(c.id) ?? `${c.text.trim()}... ${CUT_OFF}` }));
    if (this.state.userSpeaking && !lines.some((c) => c.role === "user")) {
      lines.push({ id: `cut_${crypto.randomUUID().slice(0, 8)}`, role: "user", text: CUT_OFF });
    }
    return lines;
  }

  private end(call: Call, reason: CallEndReason) {
    if (this.call !== call || !this.live()) return;
    // Hanging up mid-sentence leaves those words unfinalized. Save them first, so the text that follows can
    // say what happened and pick up from exactly what was being said. The agent's own goodbye was said in full.
    this.pace.hangUp(reason === "agent_end");
    const cutOff = this.cutOffLines(call);
    // The rest of the call's record goes before the end does, so it lands while the call is live, ahead of the text after.
    const diag = call.diag?.take(true) ?? [];
    const record = diag.length > 0 ? [api("/api/call/heartbeat", { body: { attempt: call.attempt, diag }, timeoutMs: FLUSH_MS }).catch(() => undefined)] : [];
    const saving = [...call.inFlight, ...record];
    if (cutOff.length === 0 && saving.length === 0) this.report(call, reason);
    else {
      const flushed = Promise.all([...saving, ...cutOff.map((c) => this.transcript(call, c.id, c.role, c.text))]);
      void Promise.race([flushed, new Promise((resolve) => setTimeout(resolve, FLUSH_MS))]).then(() => this.report(call, reason));
    }
    this.close(call, reason === "network" || reason === "error" || MIC_END_REASONS.includes(reason));
  }

  // Always an end, even before the accept answered: the server settles whichever state it actually holds. Kept until
  // the server has it, so a lost end never leaves this tab looking at its own call as one in another tab.
  private report(call: Call, reason: CallEndReason) {
    const ended: EndedCall = { sessionId: call.sessionId, attempt: call.attempt, reason, sending: false };
    this.ended = ended;
    this.set({ closed: call.attempt });
    this.sendEnd(ended);
  }

  private sendEnd(ended: EndedCall, tries = 0) {
    ended.sending = true;
    api<Snapshot>("/api/call/end", { body: { attempt: ended.attempt, reason: ended.reason } }).then(
      (next) => {
        if (this.ended === ended) this.ended = null;
        this.apply(next);
      },
      () => {
        const wait = END_RETRY_MS[tries];
        // Out of tries, the next poll that still shows the call live starts over (watchEnded).
        if (wait === undefined || this.ended !== ended) {
          ended.sending = false;
          return;
        }
        setTimeout(() => {
          if (this.ended === ended) this.sendEnd(ended, tries + 1);
          else ended.sending = false;
        }, wait);
      },
    );
  }

  private release(call: Call) {
    this.pace.close();
    clearInterval(call.heartbeat);
    clearTimeout(call.heartbeatRetry);
    clearTimeout(call.heldTimer);
    clearTimeout(call.grace);
    clearTimeout(call.goodbye);
    clearTimeout(call.micRetry);
    call.transport?.close();
    call.micLevel?.close();
    stopMic(call.mic);
    call.transport = null;
    call.micLevel = null;
    call.mic = null;
  }

  private close(call: Call, failed: boolean) {
    this.release(call);
    this.set({
      phase: "ended",
      agentSpeaking: false,
      userSpeaking: false,
      toolsInFlight: 0,
      failure: failed ? (this.state.failure ?? "failed") : null,
    });
    sounds.play("end");
    this.updateTicker();
    this.holdTimer = setTimeout(() => this.reset(call), ENDED_HOLD_MS);
  }

  private reset(call: Call) {
    if (this.call !== call) return;
    this.release(call);
    this.call = null;
    clearTimeout(this.bannerTimer);
    this.setCaptions([]);
    this.set({ phase: "idle", initiator: null, minimized: false, failure: null, seconds: 0, banner: null });
    // A ring may have arrived during the "Call Ended" hold; polls that change nothing never re-sync.
    this.sync(this.snapshot);
  }

  private teardown() {
    if (this.call) this.release(this.call);
    this.call = null;
    for (const timer of [this.missedTimer, this.bannerTimer, this.flashTimer, this.holdTimer]) clearTimeout(timer);
    clearInterval(this.ticker);
    this.ticker = undefined;
    this.bannerSeq = -1;
    this.dialed = null;
    this.ended = null;
    this.ringAttempt = 0;
    this.state = INITIAL_CALL_STATE;
    for (const listener of this.listeners) listener();
    this.setCaptions([]);
  }
}
