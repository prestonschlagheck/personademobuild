import "server-only";
import { createHash } from "node:crypto";
import { after } from "next/server";
import { newSession, type NewEvent, type ReactionType, type Session, type SessionEvent, type Snapshot } from "@/lib/session/schema";
import type { LocationRequest, TurnRequest } from "@/lib/api/contract";
import { coarseDegree, isCallLive, locationOpen, nextBestAsk, pauseIntent, stateBlock } from "@/lib/agent/policy";
import { deletedLine, locationSharedEvent, reactionEvent, resumedLine, stoppedLine, systemEvent, toEvent } from "@/lib/agent/messages";
import { CALL_EVENT_WINDOW, followUpEvents, locationDenied, locationShared, welcomeBack, type FollowUp } from "@/lib/agent/follow-ups";
import { cancelReminders, runTools, type ToolContext, type ToolEffects, type ToolOutput } from "@/lib/agent/tools";
import { applyTextTurn, mockTextAgent, type TextAgent } from "@/lib/agent/text-agent";
import { languageOf } from "@/lib/agent/mock/read";
import { withProfile } from "@/lib/agent/profile";
import { openAiTextAgent } from "@/lib/server/openai-text";
import { applyTimers, endActiveCall, isLiveCallId, nextTimerAt } from "@/lib/server/call-timers";
import { deliverFollowUp, deliverOnce, type Known } from "@/lib/server/follow-up";
import { hangupAfterResponse } from "@/lib/server/openai-realtime";
import { getModes } from "@/lib/server/config";
import { readSessionId, writeSessionId } from "@/lib/server/cookie";
import { revokeGrant } from "@/lib/gmail/grant";
import { disconnectRows, isDisconnectRow } from "@/lib/gmail/disconnect";
import { DomainError, clientIp, logError } from "@/lib/server/http";
import { rateLimit, rateLimitRequest } from "@/lib/server/rate-limit";
import { placeName } from "@/lib/server/geocode";
import { getStore } from "@/lib/server/store";
import type { Reading } from "@/lib/server/store/types";

// The one path to session state. Every write is a compare-and-set on `version`, retried on conflict,
// and every read settles the lazy call timers first, so no cron is needed.

const EVENT_WINDOW = 300;
// Enough for the text agent's window and the digest before it (lib/server/openai-text.ts).
const HISTORY_WINDOW = 150;
const CAS_ATTEMPTS = 3;
const TURN_LEASE_MS = 20_000;
const WELCOME_BACK_AFTER_MS = 60_000;

type Change = { session: Session; events?: NewEvent[]; effects?: ToolEffects; followUp?: FollowUp };
/**
 * `followUp` is set only for the write that won, and only when the live model is to write it. `recent` is the thread
 * after the write when the caller asked for it, and `released` says the write also released the caller's turn lease.
 */
type Committed = { session: Session; events: SessionEvent[]; deleted: boolean; followUp?: FollowUp; recent?: SessionEvent[]; released?: boolean };
/**
 * `current` is the session the caller already read, used for the first attempt so it costs no round trip; a conflict
 * reloads. `recent` asks for the thread back with the write, and `releaseLease` releases a turn lease with it.
 */
type CommitOptions = { current?: Session; recent?: boolean; releaseLease?: string };

const stamp = (events: NewEvent[], at: string) => events.map((e) => ({ ...e, at: e.at ?? at }));

async function load(id: string): Promise<Session> {
  const session = await getStore().load(id);
  if (!session) throw new DomainError(404, "session_not_found", "reload to start a new session");
  return session;
}

// The session id is the cookie's credential, so it never leaves the server. Clients only compare ids
// for equality, so a one-way hash stands in for it in every snapshot.
const publicId = (id: string) => createHash("sha256").update(id).digest("base64url").slice(0, 22);

/** The session in one round trip: its state, recent thread, last sequence number and call heartbeat. */
async function read(id: string): Promise<Reading> {
  const reading = await getStore().read(id, EVENT_WINDOW);
  if (!reading) throw new DomainError(404, "session_not_found", "reload to start a new session");
  return reading;
}

/** The snapshot for `session`, from events already in hand when the caller has them. */
async function snapshotOf(session: Session, known?: SessionEvent[]): Promise<Snapshot> {
  const events = known ?? (await getStore().listEvents(session.id, EVENT_WINDOW));
  return { session: { ...session, id: publicId(session.id) }, events, lastSeq: events.at(-1)?.seq ?? 0, modes: getModes() };
}

/** The live text brain, or null in mock mode, where every follow-up is its template. */
function liveAgent(): TextAgent | null {
  return getModes().text === "live" ? openAiTextAgent : null;
}

/**
 * Loads, applies `fn`, and saves with compare-and-set, retrying on conflict. The save carries the change's events and
 * any Gmail link's OAuth state in one write, so a saved change always has its rows and a link that works, and a failed
 * one leaves nothing behind for the next request to trip on. In mock mode a follow-up's template goes in that write
 * too; live, it is handed back for the model to write, keyed by the version saved here.
 */
async function commit(id: string, fn: (s: Session, now: string) => Change, options: CommitOptions = {}): Promise<Committed> {
  const store = getStore();
  const { recent, releaseLease } = options;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const current = attempt === 0 && options.current ? options.current : await load(id);
    const now = new Date().toISOString();
    const change = fn(current, now);

    if (change.effects?.deleteSession) {
      await deleteSession(id);
      return { session: current, events: [], deleted: true };
    }

    const followUp = change.followUp && liveAgent() ? change.followUp : undefined;
    const events = stamp([...(change.events ?? []), ...(change.followUp && !followUp ? followUpEvents(change.followUp) : [])], now);
    const oauthState = change.effects?.createOAuthState;
    // Rows alone are one append and need no version. A live follow-up always gets a version of its own to key it.
    if (change.session === current && !oauthState && !followUp) {
      return { session: current, events: events.length ? await store.appendEvents(id, events) : [], deleted: false };
    }
    // A disconnect's own row waits for Google's answer, so it can say whether the sign-in went back.
    const held = change.effects?.revokeGoogle && change.session.gmail.status === "disconnected" ? events.filter(isDisconnectRow) : [];
    const saved = await store.save({ ...change.session, updatedAt: now }, current.version, {
      events: held.length ? events.filter((e) => !held.includes(e)) : events,
      oauthState,
      releaseLease,
      ...(recent && { recent: EVENT_WINDOW }),
    });
    if (!saved.ok) continue;
    const done = { session: saved.session, events: saved.events, deleted: false, followUp, recent: saved.recent, released: Boolean(releaseLease) };
    if (!change.effects?.revokeGoogle) return done;
    // Only once the save landed, so a change that lost the race never hands back a sign-in the session still uses.
    const revoked = await revokeGrant(id).catch((err: unknown) => (logError("google revoke", err), false));
    if (!held.length) return done;
    const rows = await store.appendEvents(id, stamp(disconnectRows(held, revoked, saved.session.lang), new Date().toISOString()));
    // The thread is read again for the snapshot, since those rows came after the save's copy of it.
    return { ...done, events: [...saved.events, ...rows], recent: undefined };
  }
  throw new DomainError(409, "conflict", "the session changed while saving, try again");
}

/** After a delete requested in conversation, the thread restarts on a fresh session with one confirmation. */
async function restartAfterDelete(): Promise<Snapshot> {
  const { id } = await ensureSession();
  await getStore().appendEvents(id, stamp([toEvent(deletedLine())], new Date().toISOString()));
  return snapshotOf(await load(id));
}

/**
 * Whether a Gmail link's state was issued to this browser's session. Checked before anything consumes the state, so a
 * link opened in another browser is refused there and still works for its owner.
 */
export async function ownsOAuthState(state: string): Promise<boolean> {
  const id = await readSessionId();
  return id !== null && (await getStore().oauthStateOwner(state, id)) === id;
}

export async function requireSession(): Promise<string> {
  const id = await readSessionId();
  if (!id) throw new DomainError(401, "no_session", "reload the page to start a session");
  return id;
}

/** The cookie's session, read in the same round trip that checks it exists, or a new one. */
export async function ensureSession(): Promise<{ id: string; created: boolean; reading?: Reading }> {
  const existing = await readSessionId();
  const reading = existing ? await getStore().read(existing, EVENT_WINDOW) : null;
  if (existing && reading) return { id: existing, created: false, reading };
  return { id: await createSession(), created: true };
}

async function createSession(): Promise<string> {
  await rateLimit("sessionCreate", await clientIp());
  const id = crypto.randomUUID();
  await getStore().create(newSession(id, new Date().toISOString()));
  await writeSessionId(id);
  return id;
}

/** A settled session, its thread when already known without another read, and the call heartbeat it was judged by. */
type SettleResult = { session: Session; events?: SessionEvent[]; lastSeen: string | null };

/**
 * Runs any due lazy timer (ring timeout, dead call, scheduled callback, stale link) and persists the result. One read
 * when nothing is due, which is almost every poll; `given` skips even that when the caller just read the session.
 */
async function settle(id: string, given?: Reading): Promise<SettleResult> {
  const since = Date.now();
  const { session, events: thread, callLastSeen: lastSeen } = given ?? (await read(id));
  if (!applyTimers(session, lastSeen, new Date().toISOString())) return { session, events: thread, lastSeen };
  // Only a live call that is due to end needs its lines, so the text after it knows how it ended.
  const events = session.call.status === "active" ? thread.slice(-CALL_EVENT_WINDOW) : [];
  let hangupCallId: string | undefined;
  const result = await commit(
    id,
    (s, now) => {
      const due = applyTimers(s, lastSeen, now, events);
      hangupCallId = due?.hangupCallId;
      return due ?? { session: s };
    },
    { current: session, recent: true },
  );
  if (hangupCallId) hangupAfterResponse(hangupCallId);
  // The poll that settled the timer writes its follow-up; every other poll saw nothing due. The follow-up adds rows,
  // so the thread is read again after it.
  if (result.followUp) {
    await deliverFollowUp(id, result.followUp, liveAgent(), result.session.version, known(result, since));
    return { session: result.session, lastSeen };
  }
  return { session: result.session, events: result.recent, lastSeen };
}

/**
 * What a follow-up's model needs, from the save that caused it, so it starts without reading the thread again. Its
 * deadline counts from `since`, when the request that caused it began.
 */
function known(result: Committed, since: number): Known | undefined {
  return result.recent ? { session: result.session, history: result.recent, since, saved: result.events } : undefined;
}

/** A follow-up that no state change settles, written once by whoever holds the turn lease while `due` holds. */
export function sendFollowUp(id: string, followUp: FollowUp, due: (history: SessionEvent[]) => boolean): Promise<void> {
  return deliverOnce(id, followUp, liveAgent(), due);
}

/** The settled session without its events, for checks that need no thread. */
export async function readSession(id: string): Promise<Session> {
  return (await settle(id)).session;
}

/** The settled session with its recent thread, in one round trip whenever nothing was due, for a caller that needs both. */
export type Settled = { session: Session; events: SessionEvent[] };
export async function readSettled(id: string): Promise<Settled> {
  const { session, events } = await settle(id);
  return { session, events: events ?? (await getStore().listEvents(id, EVENT_WINDOW)) };
}

/** The settled session and the time the next lazy timer falls due, for a session object's alarm. */
export async function settleForAlarm(id: string): Promise<{ session: Session; wake: number | null }> {
  const now = new Date().toISOString();
  const { session, lastSeen } = await settle(id);
  return { session, wake: nextTimerAt(session, lastSeen, now) };
}

function welcomeBackDue(session: Session, events: SessionEvent[], now: number): boolean {
  const last = events.at(-1);
  return Boolean(
    last &&
      session.consent.termsShownAt &&
      last.meta?.kind !== "welcome_back" &&
      now - Date.parse(last.at) > WELCOME_BACK_AFTER_MS &&
      !isCallLive(session) &&
      nextBestAsk(session, "text").slot !== "none",
  );
}

export async function readSnapshot(id: string, { resume = false, reading }: { resume?: boolean; reading?: Reading } = {}): Promise<Snapshot> {
  const { session, events } = await settle(id, reading);
  const snapshot = await snapshotOf(session, events);
  if (!resume || !welcomeBackDue(session, snapshot.events, Date.now())) return snapshot;
  // Two tabs can load at once; the lease and the second look at the thread keep it to one welcome back.
  await sendFollowUp(id, welcomeBack(session, snapshot.events), (history) => welcomeBackDue(session, history, Date.now()));
  return snapshotOf(session);
}

/** The cheap poll: null when neither the version nor the last event moved since the client's copy. */
export async function pollSnapshot(id: string, version: number, seq: number, reading?: Reading): Promise<Snapshot | null> {
  const { session, events } = await settle(id, reading);
  const lastSeq = events ? (events.at(-1)?.seq ?? 0) : await getStore().lastSeq(id);
  if (session.version === version && lastSeq === seq) return null;
  return snapshotOf(session, events);
}

/** Applies one change. A follow-up it carries is written before the snapshot is read, so the caller sees it. */
export async function mutate(
  id: string,
  fn: (s: Session, now: string) => { session: Session; events?: NewEvent[]; followUp?: FollowUp },
): Promise<Snapshot> {
  const since = Date.now();
  const result = await commit(id, fn, { recent: true });
  const { session, followUp, recent } = result;
  if (!followUp) return snapshotOf(session, recent);
  await deliverFollowUp(id, followUp, liveAgent(), session.version, known(result, since));
  return snapshotOf(session);
}

export async function appendEvents(id: string, events: NewEvent[]): Promise<void> {
  await getStore().appendEvents(id, stamp(events, new Date().toISOString()));
}

export async function deleteSession(id: string): Promise<void> {
  const store = getStore();
  const session = await store.load(id);
  if (!session) return;
  if (session.call.status === "active" && isLiveCallId(session.call.activeCallId)) hangupAfterResponse(session.call.activeCallId);
  // Google access goes back with the session, before the object that holds it is gone.
  await revokeGrant(id).catch((err: unknown) => logError("google revoke", err));
  await store.delete(id);
}

/**
 * Starts over: a fresh session behind the cookie, answered at once, while the old one is deleted after the
 * response so the viewer never waits on it.
 */
export async function resetSession(): Promise<Snapshot> {
  const old = await readSessionId();
  if (old) after(() => deleteSession(old));
  return readSnapshot(await createSession());
}

/**
 * Applies tool calls from either runtime. A `toolCallId` seen before is not applied again: its
 * original result is answered with the current state, so retries are safe. `known` is a read the caller already
 * made, so a relayed voice tool reads the session once, not twice.
 */
export async function applyTools(
  id: string,
  ctx: Omit<ToolContext, "now">,
  calls: { name: string; args: unknown; toolCallId?: string }[],
  known?: Settled,
): Promise<{ snapshot: Snapshot; outputs: ToolOutput[] }> {
  const reading = known ?? (await read(id));
  const prior = new Map(reading.events.filter((e) => e.toolCallId).map((e) => [e.toolCallId, e]));
  const fresh = calls.filter((call) => !call.toolCallId || !prior.has(call.toolCallId));

  let outputs: ToolOutput[] = [];
  const result = await commit(
    id,
    (s, now) => {
      const run = runTools(s, { ...ctx, now }, fresh);
      outputs = run.outputs;
      return run;
    },
    { current: reading.session, recent: true },
  );
  if (result.deleted) return { snapshot: await restartAfterDelete(), outputs };

  const byCall = new Map(fresh.map((call, i) => [call, outputs[i]]));
  const state = stateBlock(result.session, ctx.runtime);
  return {
    snapshot: await snapshotOf(result.session, result.recent),
    outputs: calls.map((call) => byCall.get(call) ?? { ok: prior.get(call.toolCallId)?.meta?.tool?.ok ?? true, hint: "already applied", state }),
  };
}

/**
 * The retried messages that were stored but never answered, because the turn failed after storing them.
 * Only the text thread counts: a call row or tool record landing in between is not an answer.
 */
function unanswered(events: SessionEvent[], ids: Set<string>): SessionEvent[] {
  const start = events.findIndex((e) => e.clientMsgId && ids.has(e.clientMsgId));
  if (start < 0) return [];
  const tail = events.slice(start);
  const answered = tail.some((e) => e.channel === "text" && e.role !== "user");
  return answered ? [] : tail.filter((e) => e.clientMsgId && ids.has(e.clientMsgId));
}

/**
 * Stop means no calls: a ringing one is cancelled, a booked one is dropped, and a live one is hung up, through the
 * same end step a hangup takes. The stop line is the only text, so the end's own follow-up is left out.
 */
function haltCalls(s: Session, now: string): { session: Session; events: NewEvent[]; hangupCallId?: string } {
  const { call } = s;
  switch (call.status) {
    case "active": {
      // A call that settled the last slot still graduates, and its ready row still goes in.
      const { session, events, followUp, hangupCallId } = endActiveCall(s, "user_hangup", now);
      return { session, events: [...events, ...(followUp?.after ?? [])], hangupCallId };
    }
    case "ringing":
      return { session: { ...s, call: { ...call, status: "declined" } }, events: [systemEvent("call_declined", "cancelled", { callAttempt: call.attempts })] };
    case "scheduled": {
      const offered: Session["call"] = { ...call, status: "offered" };
      delete offered.scheduledFor;
      return { session: { ...s, call: offered }, events: [] };
    }
    default:
      return { session: s, events: [] };
  }
}

// Only a zone the runtime knows is kept; anything else is ignored rather than trusted.
function knownZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/**
 * One text turn: lease, idempotent user messages, the text agent, then one compare-and-set that applies its tools,
 * appends its bubbles and releases the lease. Three round trips to the session's store besides the model: the limits,
 * the start, the save. Stop and start are compliance keywords handled here.
 */
export async function takeTurn(id: string, messages: TurnRequest["messages"], origin: string, timeZone?: string): Promise<Snapshot> {
  const store = getStore();
  // Both limits in one round trip, before anything is written. A turn refused for the lease still counts against its
  // session; only a second tab or a follow-up being written holds it, and the client retries those a few times at most.
  const ip = await clientIp();
  await Promise.all([rateLimit("turnIp", ip), rateLimit("turn", id)]);
  const now = new Date().toISOString();
  const start = await store.beginTurn(
    id,
    TURN_LEASE_MS,
    stamp(
      messages.map(({ clientMsgId, text, replyTo }) => ({
        channel: "text",
        role: "user",
        content: text,
        clientMsgId,
        meta: { kind: "chat", ...(replyTo && { replyTo }) },
      })),
      now,
    ),
    HISTORY_WINDOW,
  );
  if (!start.lease) throw new DomainError(409, "turn_in_progress", "another message is being answered");

  let released = false;
  try {
    const { session: loaded, inserted, history } = start;
    // A retry can carry messages the server already stored alongside new ones; the stored ones are answered only if
    // nothing answered them yet, and the lease keeps two retries from both doing it.
    const fresh = new Set(inserted.map((e) => e.clientMsgId));
    const replayed = new Set(messages.map((m) => m.clientMsgId).filter((m) => !fresh.has(m)));
    const batch = [...(replayed.size ? unanswered(history, replayed) : []), ...inserted];
    const replyTo = batch.at(-1)?.id;
    if (!replyTo) return readSnapshot(id);
    const texts = batch.map((e) => e.content);

    const zone = knownZone(timeZone);
    const lang = languageOf(texts, history);
    // Kept on the session for the next call, which opens with no thread to read either from. The person card is
    // brought up to date from the thread with these texts in it, so the model reads it this turn.
    const withContext = (s: Session): Session => withProfile({ ...s, ...(zone && { timeZone: zone }), lang }, history);
    const session = withContext(loaded);
    // The latest word in the burst wins, so "stop" then "actually keep going" never pauses.
    const pause = pauseIntent(texts);
    if (pause === "stop" || (pause === "start" && session.consent.stoppedAt)) {
      let hangupCallId: string | undefined;
      const snapshot = await mutate(id, (s, now) => {
        const consent = { ...s.consent };
        if (pause === "stop") consent.stoppedAt = now;
        else delete consent.stoppedAt;
        // Stop also cancels every reminder still waiting, and start leaves them cancelled.
        const halted = pause === "stop" ? haltCalls(cancelReminders({ ...s, consent }, now), now) : { session: { ...s, consent }, events: [] };
        hangupCallId = halted.hangupCallId;
        const next = halted.session;
        return { session: next, events: [...halted.events, toEvent(pause === "stop" ? stoppedLine(lang) : resumedLine(next, lang))] };
      });
      if (hangupCallId) hangupAfterResponse(hangupCallId);
      return snapshot;
    }

    const reply = await (liveAgent() ?? mockTextAgent).respond(session, texts, history);
    const result = await commit(
      id,
      (s, now) => {
        const turn = applyTextTurn(withContext(s), reply, { texts, replyTo, ids: batch.map((e) => e.id) }, { runtime: "text", now, origin });
        // Again after the turn, which can say they'd rather text.
        return { ...turn, session: withProfile(turn.session, history) };
      },
      { current: loaded, recent: true, releaseLease: start.lease },
    );
    released = Boolean(result.released);
    return result.deleted ? restartAfterDelete() : snapshotOf(result.session, result.recent);
  } finally {
    if (!released) await store.releaseTurnLease(id, start.lease);
  }
}

/** A tapback from the user. Picking the current type again is a no-op; `null` removes it. */
export async function react(id: string, targetId: string, type: ReactionType | null): Promise<Snapshot> {
  await rateLimitRequest("write", id);
  const { session, events } = await read(id);
  const target = events.find((e) => e.id === targetId);
  if (!target || target.channel !== "text" || target.meta?.kind === "reaction") {
    throw new DomainError(404, "message_not_found", "that message can't take a reaction");
  }
  const current = events.reduce<ReactionType | null>(
    (value, e) =>
      e.role === "user" && e.meta?.kind === "reaction" && e.meta.reaction?.targetId === targetId
        ? e.content === "removed"
          ? null
          : e.meta.reaction.type
        : value,
    null,
  );
  const change = type ?? current;
  if (type === current || !change) return snapshotOf(session, events);
  const added = await getStore().appendEvents(id, stamp([reactionEvent("user", targetId, change, type ? "added" : "removed")], new Date().toISOString()));
  return snapshotOf(session, [...events, ...added].slice(-EVENT_WINDOW));
}

export async function saveContact(id: string): Promise<Snapshot> {
  await rateLimitRequest("write", id);
  return mutate(id, (s, now) => ({ session: s.contact.savedAt ? s : { ...s, contact: { savedAt: now } } }));
}

/**
 * The location the user sent from the agent's request card, answered like any other server event. Only an open
 * request takes it. A position is kept only as a coarse point (two decimals, about 1 km); a browser that gave none
 * leaves the card open, and only its first refusal gets a reply.
 */
export async function shareLocation(id: string, input: LocationRequest): Promise<Snapshot> {
  await rateLimit("write", id);
  // Named before the write, so the agent's reply and the call already know the town.
  const place = input.status === "shared" ? await placeName(coarseDegree(input.lat), coarseDegree(input.lng)) : null;
  return mutate(id, (s, now) => {
    const { location } = s;
    if (!location || !locationOpen(s)) throw new DomainError(409, "no_location_request", "there is no open location request");
    if (input.status === "denied") {
      if (location.deniedAt) return { session: s };
      return { session: { ...s, location: { ...location, deniedAt: now } }, followUp: locationDenied(input.reason) };
    }
    const coarse = { lat: coarseDegree(input.lat), lng: coarseDegree(input.lng), accuracyM: Math.round(input.accuracy) };
    const next = { ...s, location: { ...location, sharedAt: now, coarse, ...(place && { place }) } };
    // On a call the agent says it out loud (lib/voice/notes.ts), and a text alongside would ask a second question.
    return { session: next, events: [locationSharedEvent()], ...(s.call.status !== "active" && { followUp: locationShared(next) }) };
  });
}

/** The dashboard's Delete account: the same validated delete a confirmed delete_my_data runs, then a fresh thread. */
export async function deleteAccount(id: string, origin: string): Promise<void> {
  await rateLimit("write", id);
  await applyTools(id, { runtime: "text", origin }, [{ name: "delete_my_data", args: { confirmed: true } }]);
}
