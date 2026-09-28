import type { CallDeclineRequest } from "@/lib/api/contract";
import type { CallEndReason, Session } from "@/lib/session/schema";

// The call state one tab holds, and the pure views derived from it. No browser APIs, so it is unit tested.

export type CallPhase = "idle" | "connecting" | "active" | "ended";
export type CallScreen = "none" | "incoming" | "outgoing" | "active" | "ended";
export type LedState = "idle" | "listening" | "speaking" | "working" | "done" | "muted";
export type MicFailure = "blocked" | "missing" | "busy" | "unsupported";
/** A dial or an answer the server refused before any call began: the line is taken, the ring is over, or too many tries. */
export type LineFailure = "elsewhere" | "ringing" | "gone" | "rate_limited";
export type CallFailure = MicFailure | LineFailure | "failed";
export type DeclineAction = CallDeclineRequest["action"];
export type Caption = { id: string; role: "user" | "agent"; text: string };
export type Banner = { id: string; text: string };

export type CallState = {
  phase: CallPhase;
  initiator: "agent" | "user" | null;
  /** A ring this tab already answered with decline, hidden before the server confirms. */
  dismissed: number | null;
  /** A call this tab ended itself, so one the server has not settled yet never rings again or reads as another tab's. */
  closed: number | null;
  /** The call continues while the user is back in Messages. */
  minimized: boolean;
  muted: boolean;
  speaker: boolean;
  agentSpeaking: boolean;
  userSpeaking: boolean;
  toolsInFlight: number;
  flashing: boolean;
  seconds: number;
  lastLatencyMs: number | null;
  /** Why the call could not continue, for the ended screen. */
  failure: CallFailure | null;
  banner: Banner | null;
};

export const INITIAL_CALL_STATE: CallState = {
  phase: "idle",
  initiator: null,
  dismissed: null,
  closed: null,
  minimized: false,
  muted: false,
  speaker: true,
  agentSpeaking: false,
  userSpeaking: false,
  toolsInFlight: 0,
  flashing: false,
  seconds: 0,
  lastLatencyMs: null,
  failure: null,
  banner: null,
};

export type CallView = { screen: CallScreen; fullscreen: boolean; otherTab: boolean };

export function callView(session: Session | null, state: CallState): CallView {
  const call = session?.call;
  let screen: CallScreen = "none";
  if (state.phase === "ended") screen = "ended";
  else if (state.phase !== "idle") screen = state.phase === "connecting" && state.initiator === "user" ? "outgoing" : "active";
  else if (call?.status === "ringing" && call.initiator !== "user" && call.attempts !== state.dismissed && call.attempts !== state.closed) {
    screen = "incoming";
  }
  return {
    screen,
    fullscreen: screen === "incoming" || (screen !== "none" && !state.minimized),
    otherTab: state.phase === "idle" && call?.status === "active" && call.attempts !== state.closed,
  };
}

export function ledState(state: CallState): LedState {
  if (state.phase !== "active") return "idle";
  if (state.muted) return "muted";
  if (state.flashing) return "done";
  if (state.toolsInFlight > 0) return "working";
  if (state.agentSpeaking) return "speaking";
  return "listening";
}

export function micFailure(error: unknown): MicFailure {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "blocked";
    case "NotFoundError":
    case "OverconstrainedError":
      return "missing";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    default:
      return "unsupported";
  }
}

/**
 * The end reason each mic problem reports, so the text after the call says what actually happened. Only a blocked mic
 * points at the lock icon; a browser that can't use a mic at all is told to go on over text, like a missing one.
 */
export function micEndReason(failure: MicFailure): CallEndReason {
  switch (failure) {
    case "blocked":
      return "mic_denied";
    case "busy":
      return "mic_busy";
    case "missing":
    case "unsupported":
      return "mic_missing";
  }
}
