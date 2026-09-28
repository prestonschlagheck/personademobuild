import { describe, expect, it } from "vitest";
import { newSession, type Session } from "@/lib/session/schema";
import { callView, INITIAL_CALL_STATE, ledState, micEndReason, micFailure, type CallState } from "@/lib/voice/call-state";

const NOW = "2026-09-27T01:00:00.000Z";

function session(call: Partial<Session["call"]> = {}): Session {
  const s = newSession("s1", NOW);
  return { ...s, call: { ...s.call, ...call } };
}

const state = (patch: Partial<CallState> = {}): CallState => ({ ...INITIAL_CALL_STATE, ...patch });

describe("callView", () => {
  it("rings full screen when the agent calls", () => {
    expect(callView(session({ status: "ringing", attempts: 1, initiator: "agent" }), state())).toEqual({
      screen: "incoming",
      fullscreen: true,
      otherTab: false,
    });
  });

  it("hides a ring this tab already declined", () => {
    const ringing = session({ status: "ringing", attempts: 2, initiator: "agent" });
    expect(callView(ringing, state({ dismissed: 2 })).screen).toBe("none");
    expect(callView(ringing, state({ dismissed: 1 })).screen).toBe("incoming");
  });

  it("never shows another tab's outgoing ring", () => {
    expect(callView(session({ status: "ringing", attempts: 1, initiator: "user" }), state()).screen).toBe("none");
  });

  it("shows calling while this tab dials, then the live call", () => {
    const s = session({ status: "ringing", attempts: 1, initiator: "user" });
    expect(callView(s, state({ phase: "connecting", initiator: "user" })).screen).toBe("outgoing");
    expect(callView(s, state({ phase: "connecting", initiator: "agent" })).screen).toBe("active");
    expect(callView(s, state({ phase: "active", initiator: "user" })).screen).toBe("active");
  });

  it("keeps the call going behind Messages", () => {
    expect(callView(session({ status: "active", attempts: 1 }), state({ phase: "active", minimized: true }))).toEqual({
      screen: "active",
      fullscreen: false,
      otherTab: false,
    });
  });

  it("flags a live call this tab is not connected to", () => {
    expect(callView(session({ status: "active", attempts: 1 }), state()).otherTab).toBe(true);
    expect(callView(session({ status: "active", attempts: 1 }), state({ phase: "active" })).otherTab).toBe(false);
  });

  it("never calls this tab's own ended call one in another tab, or rings it again, while the server settles it", () => {
    expect(callView(session({ status: "active", attempts: 2 }), state({ closed: 2 })).otherTab).toBe(false);
    expect(callView(session({ status: "ringing", attempts: 2, initiator: "agent" }), state({ closed: 2 })).screen).toBe("none");
    // A later call is someone else's until this tab ends it.
    expect(callView(session({ status: "active", attempts: 3 }), state({ closed: 2 })).otherTab).toBe(true);
  });
});

describe("ledState", () => {
  it("is idle until the call is live", () => {
    expect(ledState(state({ phase: "connecting", agentSpeaking: true }))).toBe("idle");
  });

  it("ranks muted, then the slot flash, then tools, then speech", () => {
    const live = state({ phase: "active", agentSpeaking: true, toolsInFlight: 1, flashing: true });
    expect(ledState({ ...live, muted: true })).toBe("muted");
    expect(ledState(live)).toBe("done");
    expect(ledState({ ...live, flashing: false })).toBe("working");
    expect(ledState({ ...live, flashing: false, toolsInFlight: 0 })).toBe("speaking");
    expect(ledState(state({ phase: "active" }))).toBe("listening");
  });
});

describe("micFailure", () => {
  it("maps getUserMedia errors to what the user can fix", () => {
    expect(micFailure(new DOMException("", "NotAllowedError"))).toBe("blocked");
    expect(micFailure(new DOMException("", "NotFoundError"))).toBe("missing");
    expect(micFailure(new DOMException("", "NotReadableError"))).toBe("busy");
    expect(micFailure(new Error("boom"))).toBe("unsupported");
    expect(micFailure(undefined)).toBe("unsupported");
  });
});

describe("micEndReason", () => {
  it("reports each mic problem as its own end reason, keeping mic_denied for a blocked mic", () => {
    const reasons = ["NotAllowedError", "SecurityError", "NotFoundError", "OverconstrainedError", "NotReadableError", "AbortError", "TypeError"].map(
      (name) => micEndReason(micFailure(new DOMException("", name))),
    );
    expect(reasons).toEqual(["mic_denied", "mic_denied", "mic_missing", "mic_missing", "mic_busy", "mic_busy", "mic_missing"]);
    expect(micEndReason(micFailure(undefined))).toBe("mic_missing");
  });
});
