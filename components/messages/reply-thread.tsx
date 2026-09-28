import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { cx, PRESS } from "@/components/ios/ui";
import styles from "./bubble.module.css";
import type { ReplyThread, Side } from "./thread-model";

// iMessage's inline reply threads, measured from its own screenshots at 402 pt wide: an outlined, faded copy of
// the original, and a thick rounded line in the left gutter joining it to the reply.

// All in points. The line runs this far in from the thread's left edge, bends at this radius, and a stub toward a
// bubble on the right is this long in all.
const LINE_X = 18;
const RADIUS = 16;
const STUB = 38;
const GAP = 4;
// A left bubble's tail hangs about this far below its box (the tail pieces in bubble.module.css).
const TAIL = 6;

type Span = { top: number; bottom: number; side: Side };

/**
 * The line from what a reply answers down to the reply, in row coordinates. It leaves a message on the left from
 * just under its tail and meets a reply on the left just above it; for a bubble on the right it bends out into a
 * stub at that bubble's middle.
 */
export function replyPath(from: Span, to: Span, pt: number): string {
  const x = LINE_X * pt;
  const stub = x + STUB * pt;
  const start = from.side === "agent" ? from.bottom + (TAIL + GAP) * pt : (from.top + from.bottom) / 2;
  const end = to.side === "agent" ? to.top - GAP * pt : (to.top + to.bottom) / 2;
  const bends = Number(from.side === "user") + Number(to.side === "user");
  const r = Math.max(0, Math.min(RADIUS * pt, bends ? (end - start) / bends : 0));
  let d = from.side === "user" ? `M ${stub} ${start} H ${x + r} Q ${x} ${start} ${x} ${start + r}` : `M ${x} ${start}`;
  d += ` V ${to.side === "user" ? end - r : end}`;
  if (to.side === "user") d += ` Q ${x} ${end} ${x + r} ${end} H ${stub}`;
  return d;
}

// offsetTop ignores the transforms entrance and layout animations apply, so a line measured mid-animation is still
// where it ends up.
function pageTop(el: HTMLElement) {
  let top = 0;
  for (let node: HTMLElement | null = el; node; node = node.offsetParent as HTMLElement | null) top += node.offsetTop;
  return top;
}

type ReplyLineProps = {
  thread: ReplyThread;
  /** The reply bubble's data-bubble-key. */
  replyKey: string;
  quote: RefObject<HTMLDivElement | null>;
  side: Side;
  /** Anything that moves the reply within its row: its reactions, its count. */
  layoutKey: string;
};

export function ReplyLine({ thread, replyKey, quote, side, layoutKey }: ReplyLineProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [d, setD] = useState<string | null>(null);
  const aboveKey = thread.anchor === "above" ? thread.key : null;
  const fromSide = thread.anchor === "above" ? thread.side : thread.original.side;

  useLayoutEffect(() => {
    // Found through the DOM, not refs: the row's and the bubble's refs attach only after this runs.
    const rowEl = svg.current?.parentElement;
    const bubbleOf = (key: string, root: Element | null | undefined) => root?.querySelector<HTMLElement>(`[data-bubble-key="${CSS.escape(key)}"]`);
    const replyEl = bubbleOf(replyKey, rowEl);
    if (!rowEl || !replyEl) return;
    const origin = () => (aboveKey ? bubbleOf(aboveKey, rowEl.closest("[data-thread-scroll]")) : quote.current);
    const measure = () => {
      const from = origin();
      if (!from) return setD(null);
      const base = pageTop(rowEl);
      const span = (el: HTMLElement, s: Side): Span => {
        const top = pageTop(el) - base;
        return { top, bottom: top + el.offsetHeight, side: s };
      };
      // The body text is 17 pt, so its computed size says how big a point is right now.
      const pt = parseFloat(getComputedStyle(replyEl).fontSize) / 17;
      setD(replyPath(span(from, fromSide), span(replyEl, side), pt));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rowEl);
    const from = origin();
    if (from) observer.observe(from);
    return () => observer.disconnect();
  }, [replyKey, quote, aboveKey, fromSide, side, layoutKey]);

  return (
    <svg ref={svg} aria-hidden className="pointer-events-none absolute top-0 left-0 size-1 overflow-visible">
      {d && <path d={d} fill="none" className={styles.replyLine} />}
    </svg>
  );
}

type QuoteProps = {
  original: Extract<ReplyThread, { anchor: "quote" }>["original"];
  quoteRef: RefObject<HTMLDivElement | null>;
  onReplies: (eventId: string) => void;
};

// The faded copy of a message further up that this reply answers: outlined, smaller, in the original's own color.
export function QuotedOriginal({ original, quoteRef, onReplies }: QuoteProps) {
  const user = original.side === "user";
  return (
    <div className={cx("flex max-w-[75%] flex-col", user ? "items-end self-end" : "items-start self-start")}>
      <div ref={quoteRef} className={cx("relative px-11 py-7 text-ios-footnote whitespace-pre-wrap break-words", user ? "text-ios-blue" : "text-ios-label-2")}>
        <QuoteOutline side={original.side} />
        <span className="sr-only">In reply to: </span>
        <span className="relative line-clamp-3">{original.text}</span>
      </div>
      {original.count > 1 && <RepliesLink count={original.count} side={original.side} onOpen={() => onReplies(original.eventId)} />}
    </div>
  );
}

// The tail piece's outline, the same path the bubble tails are masked with (public/ios/bubble-tail-right.svg).
const TAIL_PATH =
  "M73.78 40C74.77 40 75.42 40.31 76.75 41.24C77.46 41.74 80.2 43.84 82.47 45.09C84.43 46.17 86.11 46.91 86.53 46.94C87.79 47.04 87.95 45.85 87.46 45.21C86.97 44.57 86.41 43.74 86.19 43.29C85.71 42.28 85.56 41.75 85.56 40.24C85.56 38.38 86.88 37 87.92 36.08C88.01 36 88.13 35.9 88.27 35.79C88.51 35.6 88.74 35.41 88.97 35.22V29H71.98V40H73.78Z";

function QuoteTail({ side, ring }: { side: Side; ring?: boolean }) {
  const user = side === "user";
  return (
    <svg viewBox={user ? "72 29 24 18" : "0 29 24 18"} data-ring={ring || undefined} className={cx(styles.quoteTail, user ? "right-0" : "left-0")}>
      <path d={TAIL_PATH} transform={user ? undefined : "translate(96 0) scale(-1 1)"} />
    </svg>
  );
}

// Edge layers under fill layers, so only the outer half of the joint outline shows, at one width all the way round.
function QuoteOutline({ side }: { side: Side }) {
  return (
    <span aria-hidden data-side={side} className={styles.quoteEdge}>
      <span data-ring className={styles.quoteBody} />
      <QuoteTail side={side} ring />
      <span className={styles.quoteBody} />
      <QuoteTail side={side} />
    </span>
  );
}

// "N Replies" in blue under a message, which opens the thread.
export function RepliesLink({ count, side, onOpen }: { count: number; side: Side; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx("mt-6 text-ios-footnote font-semibold text-ios-blue", side === "user" ? "mr-14" : "ml-23", PRESS)}
    >
      {count} {count === 1 ? "Reply" : "Replies"}
    </button>
  );
}
