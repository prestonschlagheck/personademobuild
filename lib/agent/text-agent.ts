import type { EventKind, NewEvent, ReactionType, Session, SessionEvent, TurnMetrics } from "@/lib/session/schema";
import { countStrikes, graduationOfferOpen, looksLikeInjection, recordAsk, wantsToProceed, type AskTarget } from "@/lib/agent/policy";
import { contactCardLine, INJECTION_ROW, TERMS_URL, reactionEvent, systemEvent, toEvent, type Line } from "@/lib/agent/messages";
import { runTools, type ToolContext } from "@/lib/agent/tools";
import { mockTextTurn } from "@/lib/agent/mock/brain";

// The seam between the text route and whichever brain answers. A brain proposes bubbles, tool calls
// and steering notes; `applyTextTurn` is where the server validates and applies them.

/** What the agent reports about its own turn so the server can keep nudge caps honest. */
export type TurnNotes = { asked?: AskTarget; offTopic?: boolean; declinedCall?: boolean; linkPromised?: boolean };

export type TextReply = {
  bubbles: Line[];
  tools: { name: string; args: unknown }[];
  /** A tapback on the user's latest message, or on the one at `at` in the burst, like the text that named the agent. */
  react?: { type: ReactionType; at?: number };
  /** Which of this turn's messages the bubbles answer, by position in the burst, when it is not the latest. */
  replyTo?: number;
  notes?: TurnNotes;
  /** The live model failed, so the mock brain wrote this reply. */
  fallback?: boolean;
  /** What the live model's calls for this turn took, shown in the debug panel. */
  metrics?: TurnMetrics;
};

export interface TextAgent {
  /**
   * With a `note`, there are no user texts: the server did something (a call ended, Google sign-in finished) and
   * the note says what. A follow-up that fails throws, so the caller can send its own template instead.
   */
  respond(session: Session, texts: string[], history: SessionEvent[], note?: string): Promise<TextReply>;
}

// Without an OpenAI key, and whenever a live turn fails, the mock brain answers. The live adapter is
// lib/server/openai-text.ts; the session service picks between them from getModes().text.
export const mockTextAgent: TextAgent = {
  respond: async (session, texts, history) => mockTextTurn(session, texts, history),
};

// Kinds a brain may give its own bubbles. Everything else (links, the value moment, OAuth results,
// call and system rows) is written only by tools, the OAuth callback and the call service.
export const BRAIN_KINDS = new Set<EventKind>([
  "greeting",
  "ask_slot",
  "confirm_slot",
  "renamed",
  "gibberish",
  "call_offer",
  "call_ringing",
  "call_scheduled",
  "continue_text",
  "gmail_link",
  "dashboard_link",
  "link_reminder",
  "confirm_account",
  "unverified_explainer",
  "ai_disclosure",
  "defer_offtopic",
  "offer_pause",
  "recap",
  "graduated",
  "stopped",
  "chat",
]);
const MAX_BUBBLE = 1_000;
const MAX_CHIPS = 3;
const MAX_CHIP = 40;

/**
 * A brain proposes text; the server decides what reaches the thread. Meta is dropped, so a link or location card can
 * only come from a tool, and a contact card only ever names the agent the tools just saved.
 */
function sanitize(bubble: Line, session: Session): Line | null {
  if (bubble.kind === "contact_card") {
    const name = session.agentName?.value;
    return name && bubble.meta?.contactCard?.name === name ? contactCardLine(name) : null;
  }
  const text = bubble.text.trim().slice(0, MAX_BUBBLE);
  if (!text) return null;
  const quickReplies = bubble.quickReplies?.filter((reply) => reply.length <= MAX_CHIP).slice(0, MAX_CHIPS);
  return { text, kind: BRAIN_KINDS.has(bubble.kind) ? bubble.kind : "chat", ...(quickReplies?.length && { quickReplies }) };
}

function applyNotes(s: Session, notes: TurnNotes | undefined): Session {
  if (!notes) return s;
  let next = s;
  if (notes.offTopic) next = { ...next, steering: { ...next.steering, offTopicCount: next.steering.offTopicCount + 1 } };
  if (notes.declinedCall) {
    // Whatever the call's status, even right after one ended, the preference holds until they ask for a call.
    next = { ...next, steering: { ...next.steering, textOnly: true } };
    if (next.call.status === "not_offered" || next.call.status === "offered") next = { ...next, call: { ...next.call, status: "declined" } };
  }
  if (notes.linkPromised && next.gmail.status === "not_started") next = { ...next, steering: { ...next.steering, linkPromised: true } };
  return notes.asked ? recordAsk(next, notes.asked) : next;
}

/**
 * The user message an inline reply threads under: only an earlier message of this turn's burst, as Persona threads
 * when several texts are in flight. Anything else is dropped, and the reply stays a plain one.
 */
export function threadTarget(replyTo: number | undefined, ids: string[] = []): string | undefined {
  if (replyTo === undefined || !Number.isInteger(replyTo) || replyTo < 0 || replyTo >= ids.length - 1) return undefined;
  return ids[replyTo];
}

/** The message a tapback lands on: the one at `at` in this turn's burst when that is real, else the latest. */
function reactionTarget(at: number | undefined, turn: { replyTo: string; ids?: string[] }): string {
  return (at !== undefined && turn.ids?.[at]) || turn.replyTo;
}

/**
 * Applies one agent turn to the session. Pure. Event order matches how the thread should read:
 * the injection flag, tool records, the tapback, the agent's bubbles, then anything a tool put in
 * the thread (the Gmail link card, the graduation row). `ids` are this turn's user messages, in order.
 */
export function applyTextTurn(
  session: Session,
  reply: TextReply,
  turn: { texts: string[]; replyTo: string; ids?: string[] },
  ctx: ToolContext,
) {
  // Judged here from their words, as the live brain's dry run judged them, never from what the brain claims.
  const judged = {
    ...ctx,
    proceed: ctx.proceed ?? wantsToProceed(turn.texts, graduationOfferOpen(session)),
    injected: ctx.injected ?? turn.texts.some(looksLikeInjection),
  };
  const run = runTools(countStrikes(session, turn.texts), judged, reply.tools);

  let next = applyNotes(run.session, reply.notes);
  // Kept only until the link goes out, by text or on a call.
  if (next.steering.linkPromised && next.gmail.status !== "not_started") {
    const steering = { ...next.steering };
    delete steering.linkPromised;
    next = { ...next, steering };
  }
  if (!next.consent.termsShownAt && reply.bubbles.some((b) => b.text.includes(TERMS_URL))) {
    next = { ...next, consent: { ...next.consent, termsShownAt: ctx.now } };
  }

  const events: NewEvent[] = [
    ...(turn.texts.some(looksLikeInjection) ? [systemEvent("injection_flag", INJECTION_ROW)] : []),
    ...run.events.filter((e) => e.role === "tool"),
    ...(reply.react ? [reactionEvent("agent", reactionTarget(reply.react.at, turn), reply.react.type, "added")] : []),
    ...reply.bubbles.flatMap((bubble, index) => {
      const line = sanitize(bubble, next);
      if (!line) return [];
      const thread = threadTarget(bubble.replyTo ?? reply.replyTo, turn.ids);
      const meta = {
        ...line.meta,
        ...(reply.fallback && { fallback: true }),
        ...(thread && line.kind !== "contact_card" && { replyTo: thread }),
        ...(index === 0 && reply.metrics && { turn: reply.metrics }),
      };
      return [toEvent({ ...line, meta })];
    }),
    ...run.events.filter((e) => e.role !== "tool"),
  ];
  return { session: next, events, effects: run.effects, outputs: run.outputs };
}
