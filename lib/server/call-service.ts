import "server-only";
import { callConflictLine, INJECTION_ROW, systemEvent, withNames } from "@/lib/agent/messages";
import { afterCall, CALL_EVENT_WINDOW, callEndDetail, declinedCall, remindLater } from "@/lib/agent/follow-ups";
import { withProfile } from "@/lib/agent/profile";
import {
  fold,
  googleHelps,
  graduationOfferOpen,
  isAbusive,
  looksLikeInjection,
  needSources,
  nextBestAsk,
  PRIVACY_LINE,
  recordAsk,
  stateBlock,
  wantsToProceed,
  type AskTarget,
} from "@/lib/agent/policy";
import { ringCall } from "@/lib/agent/tools";
import { isGoogleTool, runGoogleTool, type GoogleToolName } from "@/lib/gmail/tools";
import { buildVoiceSession, isVoiceTool } from "@/lib/agent/voice-session";
import type {
  CallAcceptRequest,
  CallAcceptResponse,
  CallDeclineRequest,
  CallEndRequest,
  ToolRequest,
  ToolResponse,
  TranscriptRequest,
} from "@/lib/api/contract";
import { endActiveCall, missCall, type Transition } from "@/lib/server/call-timers";
import { getModes } from "@/lib/server/config";
import { createRealtimeCall, hangupAfterResponse } from "@/lib/server/openai-realtime";
import { LOCAL_CALL, voiced } from "@/lib/voice/transport";
import { rateLimitRequest } from "@/lib/server/rate-limit";
import { appendEvents, applyTools, mutate, readSession, readSettled, readSnapshot, type Settled } from "@/lib/server/session-service";
import { DomainError } from "@/lib/server/http";
import { devLog } from "@/lib/server/dev-log";
import { getStore } from "@/lib/server/store";
import type { CallEndReason, CallStatus, Session, SessionEvent, Snapshot } from "@/lib/session/schema";

// The call lifecycle. Every step is a compare-and-set through mutate, so two tabs, an end beacon
// and a lazy timer can race and each call still starts once and ends once. Only the step that wins
// writes the agent's text about it, so that text is never sent twice either.

const REMIND_LATER_MINUTES = 10;
// Final transcripts can trail the hangup by a moment; later writes to an ended call are dropped.
const TRANSCRIPT_GRACE_MS = 10_000;
// Enough of the thread to find the previous transcript line of the current call.
const RECENT_EVENTS = 40;

const isCall = (session: Session, attempt: number, status: CallStatus) =>
  session.call.attempts === attempt && session.call.status === status;

class Unchanged extends Error {}

// For requests that arrive after the call already moved on: answer with the current state, write nothing.
async function transition(id: string, step: (session: Session, now: string) => Transition | null): Promise<Snapshot> {
  try {
    return await mutate(id, (session, now) => {
      const next = step(session, now);
      if (!next) throw new Unchanged();
      return next;
    });
  } catch (err) {
    if (err instanceof Unchanged) return readSnapshot(id);
    throw err;
  }
}

// A call that never connected: the mic was blocked, the voice service refused it, or the tab went away first.
function failCall(session: Session, reason: CallEndReason, now: string): Transition {
  const call: Session["call"] = { ...session.call, status: "failed", lastEndReason: reason, endedAt: now };
  delete call.activeCallId;
  const next: Session = { ...session, call };
  return {
    session: next,
    events: [systemEvent("call_ended", reason, { callAttempt: call.attempts, callSeconds: 0 })],
    followUp: afterCall(next, reason, { neverConnected: true }),
  };
}

/**
 * Turned down before it connected. `message` sends one of the ring screen's canned texts, which the agent answers
 * on its own; `cancel` is a hangup while the call was still connecting, which is said as exactly that.
 */
function declined(session: Session, action: "decline" | "message" | "cancel"): Transition {
  const next: Session = { ...session, call: { ...session.call, status: "declined" } };
  const row = systemEvent("call_declined", action === "cancel" ? "cancelled" : "declined", { callAttempt: session.call.attempts });
  if (action === "message") return { session: next, events: [row] };
  return {
    session: next,
    events: [row],
    followUp: action === "cancel" ? afterCall(next, "user_hangup", { neverConnected: true }) : declinedCall(next),
  };
}

export async function startCall(id: string, initiator: "agent" | "user") {
  await rateLimitRequest("callStart", id);
  return transition(id, (session, now) => {
    if (session.call.status === "active") throw new DomainError(409, "call_active", "a call is already in progress");
    // Refused rather than handed the ring, so a second tab dialing at the same moment never opens its mic for it.
    if (session.call.status === "ringing") throw new DomainError(409, "call_ringing", "a call is already ringing");
    return ringCall(session, initiator, now);
  });
}

/**
 * Takes the ringing call: the compare-and-set that lets exactly one tab answer. `callId` is set now for a call with
 * no voice service behind it (the mock, the eval harness); a live call gets its Realtime id once OpenAI answers.
 */
export async function reserveCall(id: string, attempt: number, callId?: string): Promise<Snapshot> {
  let heldElsewhere = false;
  return mutate(id, (session, now) => {
    if (!isCall(session, attempt, "ringing")) {
      heldElsewhere = isCall(session, attempt, "active");
      throw new DomainError(409, heldElsewhere ? "call_in_other_tab" : "call_not_ringing");
    }
    return {
      session: {
        ...session,
        call: { ...session.call, status: "active", startedAt: now, ...(callId && { activeCallId: callId }) },
        // Kept from the first call, so a later one knows it is a callback and opens with "again".
        consent: { ...session.consent, firstCallAt: session.consent.firstCallAt ?? now },
        // Every call gets its own tries at what is still missing, whatever the thread already asked.
        steering: { ...session.steering, callAskCounts: {} },
      },
      events: [systemEvent("call_started", session.call.initiator ?? "user", { callAttempt: attempt })],
    };
  }).catch(async (err: unknown) => {
    if (heldElsewhere) await appendEvents(id, [systemEvent("call_conflict", callConflictLine().text, { callAttempt: attempt })]);
    throw err;
  });
}

export async function acceptCall(id: string, { attempt, sdp }: CallAcceptRequest): Promise<CallAcceptResponse> {
  const live = getModes().voice === "live";
  if (live && !sdp) throw new DomainError(400, "sdp_required", "send the WebRTC offer to connect");
  // Limited here, not only at the start: an agent's ring and a booked callback never pass through startCall.
  await rateLimitRequest("callAccept", id);

  const reserved = await reserveCall(id, attempt, live ? undefined : `mock_${attempt}`);
  if (!live || !sdp) return { ...reserved, connection: { mode: "mock", callId: `mock_${attempt}` } };

  const answer = await createRealtimeCall(sdp, buildVoiceSession(reserved.session, reserved.events)).catch(async () => {
    await transition(id, (session, now) => (isCall(session, attempt, "active") ? failCall(session, "error", now) : null));
    throw new DomainError(502, "voice_unavailable", "the call could not connect");
  });

  // Creating the call can take seconds, so the liveness clock restarts alongside the save, not after it.
  const [snapshot] = await Promise.all([
    mutate(id, (session) => {
      if (!isCall(session, attempt, "active")) throw new DomainError(409, "call_ended", "the call ended while connecting");
      return { session: { ...session, call: { ...session.call, activeCallId: answer.callId } } };
    }).catch((err: unknown) => {
      hangupAfterResponse(answer.callId);
      throw err;
    }),
    getStore().touchCall(id, new Date().toISOString()),
  ]);

  return { ...snapshot, connection: { mode: "live", sdp: answer.sdp, callId: answer.callId } };
}

export async function declineCall(id: string, { attempt, action }: CallDeclineRequest) {
  // A tab answering the ring pings it, so another tab's ring screen running out never misses a call being picked up.
  const seen = action === "missed" ? Date.parse((await getStore().callLastSeen(id)) ?? "") || 0 : 0;
  return transition(id, (session, now) => {
    if (!isCall(session, attempt, "ringing")) return null;
    switch (action) {
      case "missed":
        return seen > Date.parse(session.call.ringingAt ?? "") ? null : missCall(session);
      case "decline":
      case "message":
        return declined(session, action);
      case "remind_later": {
        const scheduledFor = new Date(Date.parse(now) + REMIND_LATER_MINUTES * 60_000).toISOString();
        const next: Session = { ...session, call: { ...session.call, status: "scheduled", scheduledFor } };
        return {
          session: next,
          events: [systemEvent("call_scheduled", scheduledFor, { callAttempt: attempt })],
          followUp: remindLater(REMIND_LATER_MINUTES),
        };
      }
      default: {
        const unknown: never = action;
        return unknown;
      }
    }
  });
}

/**
 * Every way a call can end lands here: the button, the agent, a dropped peer, a closed tab. The tab may not
 * know yet whether its accept went through, so this settles whichever state the server holds.
 */
export async function endCall(id: string, { attempt, reason }: CallEndRequest) {
  // The call's own lines say how it ended: cut off mid-sentence, a goodbye after silence, "text me when you find it".
  const events = await getStore().listEvents(id, CALL_EVENT_WINDOW);
  const detail = callEndDetail(events, attempt);
  let hangupCallId: string | undefined;
  const snapshot = await transition(id, (session, now) => {
    if (isCall(session, attempt, "active")) {
      // The person card is saved as the call ends, with the call they took in it.
      const ended = endActiveCall(withProfile(session, events), reason, now, now, detail);
      hangupCallId = ended.hangupCallId;
      return ended;
    }
    if (!isCall(session, attempt, "ringing")) return null;
    // Before it connected: hanging up is a cancel; a blocked mic, a failed accept or a closed tab never connected.
    return reason === "user_hangup" ? declined(session, "cancel") : failCall(session, reason, now);
  });
  if (hangupCallId) hangupAfterResponse(hangupCallId);
  return snapshot;
}

/**
 * Keeps the current call alive, and holds a ring while the tab answering it waits on its mic prompt (ANSWER_HOLD_MS).
 * A ping from any other attempt is refused, so a stale tab tears down.
 */
export async function heartbeat(id: string, attempt: number) {
  await rateLimitRequest("heartbeat", id);
  const session = await readSession(id);
  if (!isCall(session, attempt, "active") && !isCall(session, attempt, "ringing")) {
    throw new DomainError(409, "call_not_active", "this call already ended");
  }
  await getStore().touchCall(id, new Date().toISOString());
}

// The call a transcript belongs to: still live, or ended just now, the callback it booked included.
function acceptsTranscript(session: Session, attempt: number) {
  const { call } = session;
  if (call.attempts !== attempt) return false;
  if (call.status === "active") return true;
  const justEnded = call.status === "ended" || call.status === "scheduled";
  return justEnded && call.endedAt !== undefined && Date.now() - Date.parse(call.endedAt) < TRANSCRIPT_GRACE_MS;
}

// The state block told the voice agent which ask to make, so a question it asks counts toward that slot's cap
// and moves the next wording on. A Gmail link already out is waited on, not asked for again.
function voiceAskOf(session: Session, agentText: string): AskTarget | null {
  if (session.call.status !== "active" || !agentText.includes("?")) return null;
  const due = nextBestAsk(session, "voice").slot;
  // The offer to skip the rest counts only when the line makes it; the opening never does, and asks the next piece.
  const slot = due === "graduation_offer" && !OFFERS_SKIP.test(fold(agentText)) ? nextBestAsk(session, "voice", { offerGraduation: false }).slot : due;
  if (slot === "none" || (slot === "gmail" && session.gmail.status === "link_sent")) return null;
  return slot;
}

const OFFERS_SKIP = /\bskip\b|\bstart on\b|\bget started\b|\bsaltarte\b|\bempezar\b/;

// The agent makes its ask when it opens the call or answers the user, out loud or by a text sent mid-call. A second
// question with no reply in between is a check-in after a silence ("still there?"), not another try at the slot.
async function answersUser(id: string, item: SessionEvent): Promise<boolean> {
  const previous = (await getStore().listEvents(id, RECENT_EVENTS)).findLast(
    (e) =>
      e.seq < item.seq &&
      ((e.channel === "voice" && e.meta?.callAttempt === item.meta?.callAttempt) || (e.channel === "text" && e.role === "user" && e.meta?.kind !== "reaction")),
  );
  return !previous || previous.role === "user";
}

// "i just texted you a link", said as done rather than offered.
const TEXTED_LINK = /\b(?:texted|sent)(?: you)?(?: over)? (?:a|the|your)\b[^.?!]{0,40}\blink\b/;

/**
 * A spoken line that says the Gmail link went out when none has: the words are already heard, so the server sends
 * the link to make them true, the way a text reply's claim runs its tool. Sending again is a no-op while one is live.
 */
async function keepLinkClaim(id: string, itemId: string, text: string, session: Session, origin: string) {
  if (session.gmail.status === "link_sent" || session.gmail.status === "connected" || !TEXTED_LINK.test(fold(text))) return;
  await applyTools(id, { runtime: "voice", origin }, [{ name: "send_gmail_link", args: {}, toolCallId: `${LOCAL_CALL}claim_${itemId}` }]);
}

/**
 * The agent's spoken line as the thread and captions show it, in the product voice: lowercase with straight
 * apostrophes, a spoken dash only a pause, and the saved names in their own capitals, as the texts write them.
 */
export function spokenLine(text: string, session: Pick<Session, "agentName" | "userName">): string {
  return withNames(voiced(text), [session.agentName?.value, session.userName?.value]);
}

/**
 * Captions and thread rows speak in the product voice, lowercase, whatever case the voice model's transcript used.
 * `origin` lets a claim in the agent's words be kept (keepLinkClaim).
 */
export async function recordTranscript(id: string, { attempt, itemId, role, text, latencyMs }: TranscriptRequest, origin?: string) {
  await rateLimitRequest("write", id);
  const session = await readSession(id);
  if (!acceptsTranscript(session, attempt)) return;
  const content = role === "agent" ? spokenLine(text, session) : text;
  const [stored] = await getStore().appendEvents(id, [
    {
      at: new Date().toISOString(),
      channel: "voice",
      role,
      content,
      meta: { kind: "transcript", callAttempt: attempt, ...(latencyMs === undefined ? {} : { latencyMs }) },
      clientMsgId: `item:${itemId}`,
    },
  ]);
  // A replayed item is skipped by the store, so it can never count an ask or add a strike twice.
  if (!stored) return;
  if (role === "agent") {
    if (origin && session.call.status === "active") await keepLinkClaim(id, itemId, content, session, origin);
    if (!voiceAskOf(session, content) || !(await answersUser(id, stored))) return;
    await mutate(id, (current) => {
      const asked = voiceAskOf(current, content);
      return { session: asked ? recordAsk(current, asked, "voice") : current };
    });
    return;
  }
  // Rule breaking on the call counts exactly as in the thread.
  const injection = looksLikeInjection(text);
  const abusive = isAbusive(text);
  if (!injection && !abusive) return;
  await mutate(id, (current) => ({
    session: abusive ? { ...current, steering: { ...current.steering, abuseStrikes: current.steering.abuseStrikes + 1 } } : current,
    events: injection ? [systemEvent("injection_flag", INJECTION_ROW, { callAttempt: attempt })] : [],
  }));
}

// This call so far: the last thing the user said or texted, if anything, and how many lines the agent said. A hangup
// on the opening is refused, and a graduation on a saved need waits for words that ask to move on. Null when the
// call's start row is past the window, so a long thread never reads as a call that has heard nothing.
function soFar(
  thread: SessionEvent[],
  attempt: number,
): { heard: string | null; spoke: number; userSpokeLast: boolean; privacySaid: boolean } | null {
  const events = thread.slice(-CALL_EVENT_WINDOW);
  const start = events.findLastIndex((e) => e.meta?.kind === "call_started" && e.meta.callAttempt === attempt);
  if (start < 0) return null;
  const call = events.slice(start + 1);
  const spoken = call.filter((e) => e.channel === "voice" && e.role === "agent");
  return {
    heard: call.findLast((e) => e.role === "user" && e.meta?.kind !== "reaction")?.content ?? null,
    spoke: spoken.length,
    userSpokeLast: call.findLast((e) => e.channel === "voice")?.role === "user",
    privacySaid: spoken.some((e) => PRIVACY_LINE.test(fold(e.content))),
  };
}

// The tools whose rules depend on the call so far: a hangup, a saved answer or a text before they said anything, an
// early graduation, and the privacy line that goes with the first link unless the call already said it.
const READS_CALL = new Set(["end_call", "graduate", "send_gmail_link", "set_agent_name", "set_user_name", "set_help_need", "send_text"]);

// A Google tool reads or writes their account, not the session, so it runs outside the reducer. Its row in the thread
// names the tool and whether it worked, never what it read.
async function googleOnCall(id: string, settled: Settled, { name, args, toolCallId, attempt }: ToolRequest & { name: GoogleToolName }): Promise<ToolResponse> {
  const heard = settled.events.findLast((e) => e.channel === "voice" && e.role === "user" && e.meta?.callAttempt === attempt);
  const output = await runGoogleTool(name, args, { sessionId: id, session: settled.session, lastHeardAt: heard?.at ?? null, heard: heard?.content ?? null });
  await appendEvents(id, [
    {
      channel: "system",
      role: "tool",
      content: name,
      toolCallId,
      meta: { kind: "tool_call", tool: { name, args: {}, ok: output.ok, ...(output.error && { error: output.error }) } },
    },
  ]);
  // Read after the tool, so a disconnect's result comes with the state it left.
  const snapshot = await readSnapshot(id);
  return { ...snapshot, output: { ...output, state: stateBlock(snapshot.session, "voice") } };
}

export async function relayVoiceTool(id: string, request: ToolRequest, origin: string): Promise<ToolResponse> {
  const started = Date.now();
  try {
    const response = await relayTool(id, request, origin);
    devLog(id, { voiceTool: { name: request.name, args: request.args, ms: Date.now() - started, ok: response.output.ok, error: response.output.error } });
    return response;
  } catch (err) {
    devLog(id, { voiceTool: { name: request.name, args: request.args, ms: Date.now() - started, threw: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
}

async function relayTool(id: string, { attempt, toolCallId, name, args }: ToolRequest, origin: string): Promise<ToolResponse> {
  // Every pause is dead air on a call, so the limit check and the one read of the session run together, and the read is
  // handed on to the tool instead of being made again: two round trips to the session's store in all.
  const [, settled] = await Promise.all([rateLimitRequest("write", id), readSettled(id)]);
  const { session } = settled;
  if (!isCall(session, attempt, "active")) throw new DomainError(409, "call_not_active", "tools run only during the active call");
  if (!isVoiceTool(name)) throw new DomainError(400, "tool_not_allowed", `${name} is not available on a call`);
  if (isGoogleTool(name)) return googleOnCall(id, settled, { name, args, toolCallId, attempt });

  // Their last words decide, as over text: a yes to the offer to skip the rest counts as asking to move on, and a line
  // that tries to change the rules saves no name or need. A need is saved only from what they said, by text or here,
  // judged once their latest words are in: a transcript can land after the tool call it led to.
  const call = READS_CALL.has(name) ? soFar(settled.events, attempt) : null;
  const context = call
    ? {
        heard: call.heard !== null,
        spoke: call.spoke,
        userSpokeLast: call.userSpokeLast,
        privacySaid: call.privacySaid,
        proceed: call.heard !== null && wantsToProceed([call.heard], graduationOfferOpen(session)),
        injected: call.heard !== null && looksLikeInjection(call.heard),
        ...(name === "set_help_need" && call.userSpokeLast && { said: needSources(settled.events, [], session.gmail.valueFact) }),
      }
    : {};
  const ctx = { runtime: "voice" as const, origin, ...context };
  const { snapshot, outputs } = await applyTools(id, ctx, [{ name, args, toolCallId }], settled);
  const [output] = outputs;
  if (!output) throw new DomainError(500, "tool_failed");
  // Once their need is one their inbox answers, the Google link goes out by text in the same breath, whether or not the
  // model remembered to send it, and the model hears the sentence that says so. A need Google can't help with gets the
  // link only if they say yes to it.
  const saved = snapshot.session;
  const linkDue =
    (name === "set_help_need" || name === "set_user_name") &&
    output.ok &&
    googleHelps(saved) &&
    saved.gmail.status === "not_started" &&
    !saved.steering.skipped.includes("gmail");
  if (!linkDue) return { ...snapshot, output };
  const sent = await applyTools(id, ctx, [{ name: "send_gmail_link", args: {}, toolCallId: `${toolCallId}:link` }]);
  const link = sent.outputs[0];
  return link?.ok ? { ...sent.snapshot, output: { ...output, ...(link.hint && { hint: link.hint }), state: link.state } } : { ...snapshot, output };
}
