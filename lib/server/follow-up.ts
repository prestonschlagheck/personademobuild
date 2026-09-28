import "server-only";
import type { Session, SessionEvent } from "@/lib/session/schema";
import type { FollowUp } from "@/lib/agent/follow-ups";
import { REGEX_SYNTAX, toEvent, type Line } from "@/lib/agent/messages";
import { recentAgentLines, repeatedParts } from "@/lib/agent/policy";
import type { TextAgent, TextReply } from "@/lib/agent/text-agent";
import { briefError, logError } from "@/lib/server/http";
import { getStore } from "@/lib/server/store";

// Writes the agent's answer to something the server just did, once per event: a saved change is answered only by
// the request whose compare-and-set made it, anything else only by the holder of the turn lease. The live model
// gets the note and a hard deadline; on a timeout, an error or a reply that fails the checks, the template goes
// out instead, so the text always lands.

// The same reach as a text turn, so a follow-up sees what the turn would (lib/server/session-service.ts).
const HISTORY_WINDOW = 150;
/**
 * From the request that caused it (the hangup, the decline, the poll that found a timer due) to the model's last
 * chance. At 1.6 s about half of these went out as the template, so the agent gets long enough to answer in its own
 * words nearly every time, and the text still lands within about 3 s. Past it the template goes out.
 */
export const FOLLOW_UP_DEADLINE_MS = 3_000;

/**
 * What the save that caused a follow-up already knows: the session, its thread, when the request began, and the rows
 * that save wrote, which hold the row the follow-up answers.
 */
export type Known = { session: Session; history: SessionEvent[]; since: number; saved?: SessionEvent[] };
// Covers the deadline and the writes after it, and frees itself quickly if this request dies.
const LEASE_MS = FOLLOW_UP_DEADLINE_MS + 2_000;
const MAX_BUBBLE = 1_000;

const numbersIn = (text: string) => text.match(/\d+/g) ?? [];
// A whole word or number, so "2" is not found inside "12".
const hasWord = (said: string, word: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${word.toLowerCase().replace(REGEX_SYNTAX, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(said);

function timeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("follow-up passed its deadline")), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * The model's bubbles under the template's kinds, aligned from the end so the last bubble always carries the
 * last kind (the value moment the call listens for), and the chips of the line each one stands in for, since the
 * choices after a call are the same whoever words them. Null when the reply drops a required word, carries none of
 * the words it must have one of, says one that tells another story than what happened, asks nothing when it must,
 * states a number the facts do not contain, or has a bubble that is word for word a text in `sent`.
 */
export function shapeReply(reply: TextReply, followUp: FollowUp, sent: string[] = []): Line[] | null {
  const texts = reply.bubbles
    .filter((b) => b.kind !== "contact_card")
    .map((b) => b.text.trim().slice(0, MAX_BUBBLE))
    .filter(Boolean);
  if (texts.length === 0) return null;
  const said = texts.join(" ").toLowerCase();
  if (followUp.mustSay?.some((word) => !said.includes(word.toLowerCase()))) return null;
  if (followUp.mustNotSay?.some((word) => said.includes(word))) return null;
  if (followUp.mustAsk && !said.includes("?")) return null;
  if (followUp.mustSayOne && !followUp.mustSayOne.some((word) => hasWord(said, word))) return null;
  if (followUp.facts) {
    const known = new Set(followUp.facts.flatMap(numbersIn));
    if (numbersIn(said).some((n) => !known.has(n))) return null;
  }
  if (texts.some((text) => repeatedParts(text, sent).includes(text))) return null;
  const template = followUp.fallback;
  // A connect reply folded into one bubble still owes the account confirmation its own line, so the wrong-account
  // reply can find it: the first sentence confirms, the rest is the fact.
  if (texts.length === 1 && template.length === 2 && template[0]?.kind === "confirm_account") {
    const [first = "", ...rest] = texts[0]?.split(/(?<=[.!?])\s+/) ?? [];
    if (rest.length) texts.splice(0, 1, first, rest.join(" "));
  }
  return texts.map((text, i) => {
    const at = template.length - texts.length + i;
    const line = template[Math.max(0, at)];
    return { text, kind: line?.kind ?? "chat", ...(at >= 0 && line?.quickReplies && { quickReplies: line.quickReplies }) };
  });
}

// The template standing in for a live reply that failed, marked so the state panel and the eval can tell.
const standIn = (followUp: FollowUp, error: string): Line[] =>
  followUp.fallback.map((line) => ({ ...line, meta: { ...line.meta, fallback: true, error } }));

async function compose(agent: TextAgent, session: Session | null, history: SessionEvent[], followUp: FollowUp, deadline: number): Promise<Line[]> {
  if (!session) return followUp.fallback;
  try {
    const reply = await timeout(agent.respond(session, [], history, followUp.note), deadline - Date.now());
    const lines = shapeReply(reply, followUp, recentAgentLines(history));
    if (!lines) logError("follow-up", new Error(`reply failed its checks, sent the ${followUp.fallback[0]?.kind ?? "template"} template`));
    return lines ?? standIn(followUp, "reply failed its checks");
  } catch (err) {
    logError("follow-up", err);
    return standIn(followUp, briefError(err));
  }
}

// The rows whose follow-up records how fast it came: a call that ended, one declined on the ring screen, one that rang out.
const TIMED = new Set<string>(["call_ended", "call_declined", "missed_call"]);
const causeOf = (saved: SessionEvent[] | undefined) => saved?.find((e) => TIMED.has(e.meta?.kind ?? ""));

// The template as written, or standing in for a live reply that failed.
const isTemplate = (lines: Line[], followUp: FollowUp) => lines === followUp.fallback || lines.some((line) => line.meta?.fallback);

/**
 * The lines with the first one marked: the row it answers, as "kind:reason" with its seq, how many milliseconds after
 * that row `at` is, and whether the template wrote it.
 */
function timed(lines: Line[], cause: SessionEvent, at: string, template: boolean): Line[] {
  const [first, ...rest] = lines;
  if (!first) return lines;
  const ms = Date.parse(at) - Date.parse(cause.at);
  const record = { cause: `${cause.meta?.kind}:${cause.content}`.slice(0, 60), causeSeq: cause.seq, ms, template };
  return [{ ...first, meta: { ...first.meta, followUp: record } }, ...rest];
}

/**
 * Every row carries a key from what caused it, so writing the same follow-up again is a no-op. That makes the one
 * retry safe when the first write landed but its answer was lost.
 */
async function write(id: string, lines: Line[], followUp: FollowUp, key: string, cause?: SessionEvent) {
  const at = new Date().toISOString();
  const shown = cause ? timed(lines, cause, at, isTemplate(lines, followUp)) : lines;
  const events = [...shown.map(toEvent), ...(followUp.after ?? [])].map((e, i) => ({ ...e, at, clientMsgId: `${key}:${i}` }));
  const store = getStore();
  try {
    await store.appendEvents(id, events);
  } catch (err) {
    logError("follow-up write", err);
    await store.appendEvents(id, events);
  }
}

/**
 * A follow-up to a change that was just saved. The change already settled who answers, so the lease only keeps
 * the model's reply from interleaving with a text turn: while a turn holds it, the template goes out at once.
 * `agent` is null in mock mode, which always sends the template. `version` is the one the change saved, which keys
 * the reply, so delivering the same change twice writes it once.
 */
export async function deliverFollowUp(id: string, followUp: FollowUp, agent: TextAgent | null, version: number, known?: Known): Promise<void> {
  const key = `followup:v${version}`;
  const cause = causeOf(known?.saved);
  if (!agent) {
    await write(id, followUp.fallback, followUp, key, cause);
    return;
  }
  const deadline = (known?.since ?? Date.now()) + FOLLOW_UP_DEADLINE_MS;
  const store = getStore();
  // The save already handed back the session and its thread, so the lease is the only round trip before the model.
  // Without them the thread is read alongside the lease, since every round trip before the model counts.
  const [lease, session, history] = known
    ? [await store.acquireTurnLease(id, LEASE_MS), known.session, known.history.slice(-HISTORY_WINDOW)]
    : await Promise.all([store.acquireTurnLease(id, LEASE_MS), store.load(id), store.listEvents(id, HISTORY_WINDOW)]);
  try {
    await write(id, lease ? await compose(agent, session, history, followUp, deadline) : followUp.fallback, followUp, key, cause);
  } finally {
    if (lease) await store.releaseTurnLease(id, lease);
  }
}

/**
 * A follow-up that no state change settles, like a welcome back or a dead link notice. The lease is its only
 * guard, so it is skipped while someone else holds it, and written only if `due` still holds on the thread once
 * this request does.
 */
export async function deliverOnce(id: string, followUp: FollowUp, agent: TextAgent | null, due: (history: SessionEvent[]) => boolean) {
  const deadline = Date.now() + FOLLOW_UP_DEADLINE_MS;
  const store = getStore();
  const lease = await store.acquireTurnLease(id, LEASE_MS);
  if (!lease) return;
  try {
    const [session, history] = await Promise.all([store.load(id), store.listEvents(id, HISTORY_WINDOW)]);
    if (!due(history)) return;
    // Keyed by the thread it answered, so no second writer that saw the same thread can add it again.
    const key = `followup:${followUp.fallback[0]?.kind ?? "note"}@${history.at(-1)?.seq ?? 0}`;
    await write(id, agent ? await compose(agent, session, history, followUp, deadline) : followUp.fallback, followUp, key);
  } finally {
    await store.releaseTurnLease(id, lease);
  }
}
