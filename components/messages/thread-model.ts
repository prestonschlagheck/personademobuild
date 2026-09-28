import type { Pending } from "@/lib/client/onboarding";
import type { EventKind, EventMeta, ReactionType, SessionEvent } from "@/lib/session/schema";

// Turns the session's event log into what the thread draws: bubbles, call and system rows, timestamps.
// Pure, so the rendering rules live in one place.

export type Side = "user" | "agent";
export type Reaction = { from: Side; type: ReactionType };
export type Receipt = { kind: "delivered" } | { kind: "read"; at: string } | { kind: "failed" };

// A scheduled callback has no row: iMessage draws nothing for it, and the agent's own reply says when. An injection
// flag has none either: the thread stays a conversation, and the logs panel lists the flag.
// Only rows iMessage itself draws: the call lines. Server bookkeeping like graduation stays in Logs.
const ROW_KINDS = ["call_ended", "missed_call", "call_declined"] as const;
type EventRowKind = (typeof ROW_KINDS)[number];
// "You started sharing location with ...", which Messages writes under a sent location. Drawn from that message.
type RowKind = EventRowKind | "location_started";

export type BubbleItem = {
  type: "bubble";
  key: string;
  side: Side;
  text: string;
  at: string;
  eventId?: string;
  pending?: Pending;
  link?: NonNullable<EventMeta["link"]>;
  contactCard?: NonNullable<EventMeta["contactCard"]>;
  /** The agent's location request card, and whether a share answered it. */
  locationRequest?: { shared: boolean };
  /** The user's reply to that card. */
  sharedLocation?: boolean;
  /** An inline reply: the event id of the message it answers. */
  replyTo?: string;
  /** How an inline reply joins what it answers; unset when that message is not in the thread. */
  thread?: ReplyThread;
  /** "N Replies" under this message: set when a reply to it sits further down, not right under it. */
  replyCount?: number;
  reactions: Reaction[];
  receipt?: Receipt;
  groupStart: boolean;
  tail: boolean;
  fresh: boolean;
};
/**
 * iMessage joins a reply to what it answers with a line. Right under the message (or under an earlier reply in the
 * same run), the line starts at that bubble. Anywhere else a faded, outlined copy of the original sits above the
 * reply, with its reply count once there are several.
 */
export type ReplyThread =
  | { anchor: "above"; key: string; side: Side }
  | { anchor: "quote"; original: { eventId: string; side: Side; text: string; count: number } };

export type RowItem = { type: "row"; key: string; kind: RowKind; at: string; event: SessionEvent; fresh: boolean };
export type TimeItem = { type: "time"; key: string; at: string; first: boolean };
export type ThreadItem = BubbleItem | RowItem | TimeItem;

const GROUP_MS = 60_000;
const STAMP_GAP_MS = 15 * 60_000;

const isRowKind = (kind: EventKind | undefined): kind is EventRowKind => ROW_KINDS.some((k) => k === kind);

function isBubble(e: SessionEvent) {
  return e.channel === "text" && (e.role === "user" || e.role === "agent") && e.meta?.kind !== "reaction";
}

export const isAgentBubble = (e: SessionEvent) => isBubble(e) && e.role === "agent";

// Latest tapback per sender and target. A reaction event with content "removed" clears the sender's tapback.
function foldReactions(events: SessionEvent[]) {
  const byTarget = new Map<string, Map<Side, ReactionType>>();
  for (const e of events) {
    const reaction = e.meta?.kind === "reaction" ? e.meta.reaction : undefined;
    if (!reaction) continue;
    const from: Side = e.role === "user" ? "user" : "agent";
    const target = byTarget.get(reaction.targetId) ?? new Map<Side, ReactionType>();
    if (e.content === "removed") target.delete(from);
    else target.set(from, reaction.type);
    byTarget.set(reaction.targetId, target);
  }
  return byTarget;
}

type Entry = BubbleItem | RowItem;

const LOCATION_KINDS = new Set<EventKind | undefined>(["location_request", "location_shared"]);

// A link or contact message carries its URL or name as content, and a location card its label; the card shows it.
function captionOf(e: SessionEvent) {
  const { link, contactCard, kind } = e.meta ?? {};
  if (LOCATION_KINDS.has(kind)) return "";
  const text = (link ? e.content.replace(link.url, "") : e.content).trim();
  return contactCard && text === contactCard.name ? "" : text;
}

function bubbleFromEvent(e: SessionEvent, reactions: Map<Side, ReactionType> | undefined, fresh: boolean): BubbleItem {
  const link = e.meta?.link;
  return {
    type: "bubble",
    key: e.clientMsgId ?? e.id,
    side: e.role === "user" ? "user" : "agent",
    text: captionOf(e),
    at: e.at,
    eventId: e.id,
    link,
    contactCard: e.meta?.contactCard,
    ...(e.meta?.kind === "location_request" && { locationRequest: { shared: false } }),
    ...(e.meta?.kind === "location_shared" && { sharedLocation: true }),
    ...(e.meta?.replyTo && { replyTo: e.meta.replyTo }),
    reactions: reactions ? [...reactions].map(([from, type]) => ({ from, type })) : [],
    groupStart: true,
    tail: true,
    fresh,
  };
}

function bubbleFromPending(p: Pending): BubbleItem {
  return {
    type: "bubble",
    key: p.clientMsgId,
    side: "user",
    text: p.text,
    at: p.at,
    pending: p,
    ...(p.replyTo && { replyTo: p.replyTo }),
    reactions: [],
    groupStart: true,
    tail: true,
    fresh: true,
  };
}

// "Delivered" and "Read" sit under the latest user bubble only; every failed send says "Not Delivered".
function addReceipts(entries: Entry[]) {
  let last = -1;
  entries.forEach((entry, i) => {
    if (entry.type !== "bubble" || entry.side !== "user") return;
    last = i;
    if (entry.pending?.status === "failed") entry.receipt = { kind: "failed" };
  });
  const latest = entries[last];
  if (latest?.type !== "bubble" || latest.pending) return;
  const reply = entries.slice(last + 1).find((e) => e.type === "bubble" && e.side === "agent");
  latest.receipt = reply ? { kind: "read", at: reply.at } : { kind: "delivered" };
}

// What a quote of a message says: its text, or for a card, what the card shows.
const quoteText = (item: BubbleItem) => item.text || item.contactCard?.name || item.link?.title || "Attachment";

// Runs over the stamped thread, so a timestamp between a message and its reply counts as something in between.
function linkReplies(items: ThreadItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) if (item.type === "bubble" && item.replyTo) counts.set(item.replyTo, (counts.get(item.replyTo) ?? 0) + 1);
  const seen = new Map<string, BubbleItem>();
  const quoted = new Set<string>();
  items.forEach((item, i) => {
    if (item.type !== "bubble") return;
    const target = item.replyTo;
    const original = target ? seen.get(target) : undefined;
    if (item.eventId) seen.set(item.eventId, item);
    if (!target || !original) return;
    const prev = items[i - 1];
    if (prev?.type === "bubble" && (prev.eventId === target || prev.replyTo === target)) {
      item.thread = { anchor: "above", key: prev.key, side: prev.side };
      return;
    }
    quoted.add(target);
    item.thread = { anchor: "quote", original: { eventId: target, side: original.side, text: quoteText(original), count: counts.get(target) ?? 1 } };
  });
  for (const item of items) {
    if (item.type === "bubble" && item.eventId && quoted.has(item.eventId)) item.replyCount = counts.get(item.eventId);
  }
}

/**
 * Each pending text sits where it was sent, after the last event the thread had then, so a failed one stays put
 * while later replies land below it. Pending texts keep their send order, so one sent before the thread loaded
 * (no `afterSeq`) holds everything sent after it at the bottom too. `seqs` runs alongside `entries`.
 */
function placePending(entries: Entry[], seqs: number[], pending: Pending[]) {
  let floor = -Infinity;
  for (const p of pending) {
    floor = Math.max(floor, p.afterSeq ?? Infinity);
    let at = entries.length;
    while (at > 0 && (seqs[at - 1] ?? -Infinity) > floor) at--;
    entries.splice(at, 0, bubbleFromPending(p));
    seqs.splice(at, 0, floor);
  }
}

// iOS groups a sender's messages sent within a minute (tail on the last one) and stamps gaps of 15 minutes. An
// inline reply stands alone under its hook line, so it never groups with its neighbors.
function stampAndGroup(entries: Entry[]) {
  const items: ThreadItem[] = [];
  let prev: Entry | undefined;
  for (const entry of entries) {
    const gap = prev ? Date.parse(entry.at) - Date.parse(prev.at) : Infinity;
    const stamped = !prev || gap >= STAMP_GAP_MS;
    if (stamped) items.push({ type: "time", key: `time:${entry.key}`, at: entry.at, first: !prev });
    const threaded = entry.type === "bubble" && prev?.type === "bubble" && Boolean(entry.replyTo || prev.replyTo);
    if (entry.type === "bubble" && prev?.type === "bubble" && !stamped && !threaded && prev.side === entry.side && gap < GROUP_MS) {
      entry.groupStart = false;
      prev.tail = false;
    }
    items.push(entry);
    prev = entry;
  }
  return items;
}

export function buildThread({ events, cursor, baseline, pending }: { events: SessionEvent[]; cursor: number; baseline: number; pending: Pending[] }) {
  const visible = events.filter((e) => e.seq <= cursor);
  const reactions = foldReactions(visible);
  const entries: Entry[] = [];
  const seqs: number[] = [];
  const add = (entry: Entry, seq: number) => {
    entries.push(entry);
    seqs.push(seq);
  };
  let request: BubbleItem | undefined;
  for (const e of visible) {
    const fresh = e.seq > baseline;
    const kind = e.meta?.kind;
    if (isBubble(e)) {
      const item = bubbleFromEvent(e, reactions.get(e.id), fresh);
      if (item.locationRequest) request = item;
      else if (item.sharedLocation && request?.locationRequest) request.locationRequest.shared = true;
      add(item, e.seq);
      if (item.sharedLocation) add({ type: "row", key: `${e.id}:started`, kind: "location_started", at: e.at, event: e, fresh }, e.seq);
    } else if (e.channel === "system" && isRowKind(kind)) add({ type: "row", key: e.id, kind, at: e.at, event: e, fresh }, e.seq);
  }
  placePending(entries, seqs, pending);
  addReceipts(entries);
  const items = stampAndGroup(entries);
  linkReplies(items);
  return items;
}
