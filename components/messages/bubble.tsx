import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { cx, PRESS } from "@/components/ios/ui";
import { TERMS_URL } from "@/lib/agent/messages";
import { clockTime } from "@/lib/client/format";
import { ContactBubble, LinkCard, LocationRequestCard, SharedLocationCard, type LocationState } from "./attachments";
import styles from "./bubble.module.css";
import { ReactionBadges } from "./reactions";
import { QuotedOriginal, RepliesLink, ReplyLine } from "./reply-thread";
import type { BubbleItem, Reaction, Receipt, Side } from "./thread-model";
import { useLongPress } from "./use-long-press";

type BubbleViewProps = ComponentProps<"div"> & { side: Side; tail: boolean; reactions: Reaction[] };

// The bubble surface alone, shared by the thread and the lifted copy in the tapback overlay.
export function BubbleView({ side, tail, reactions, className, children, ...props }: BubbleViewProps) {
  const user = side === "user";
  return (
    <div
      {...props}
      data-gradient={user || undefined}
      className={cx(
        styles.bubble,
        user ? cx(styles.user, "text-surface") : cx(styles.agent, "text-ink"),
        tail && styles.tail,
        "min-w-0 select-none whitespace-pre-wrap break-words text-ios-body [-webkit-touch-callout:none]",
        className,
      )}
    >
      {children}
      <ReactionBadges reactions={reactions} side={side} />
    </div>
  );
}

function ReceiptLine({ receipt }: { receipt: Receipt }) {
  const failed = receipt.kind === "failed";
  return (
    <p className={cx("mt-6 pr-4 text-ios-caption2", failed ? "text-ios-red" : "text-ink-soft")}>
      {receipt.kind === "read" ? (
        <>
          <span className="font-semibold">Read</span> {clockTime(receipt.at)}
        </>
      ) : (
        <span className="font-semibold">{failed ? "Not Delivered" : "Delivered"}</span>
      )}
    </p>
  );
}

/**
 * iMessage sizes a wrapped bubble to its longest line; CSS alone leaves it at the full 75%. The lines are
 * measured from the bubble's own text node (not the screen reader prefix), divided by any transform scale
 * from an entrance or layout animation, and measured again when the thread's width changes.
 */
function useShrinkWrap(text: string) {
  const row = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bubble.current;
    const container = row.current;
    if (!el || !container) return;
    const fit = () => {
      el.style.width = "";
      const range = document.createRange();
      const tops = new Set<number>();
      let left = Infinity;
      let right = -Infinity;
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width === 0) continue;
          tops.add(Math.round(r.top));
          left = Math.min(left, r.left);
          right = Math.max(right, r.right);
        }
      }
      if (tops.size < 2) return;
      const scale = el.getBoundingClientRect().width / el.offsetWidth || 1;
      const { paddingLeft, paddingRight } = getComputedStyle(el);
      el.style.width = `${Math.ceil((right - left) / scale + parseFloat(paddingLeft) + parseFloat(paddingRight)) + 1}px`;
    };
    fit();
    let width = container.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (container.offsetWidth === width) return;
      width = container.offsetWidth;
      fit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [text]);
  return { row, bubble };
}

type MessageRowProps = {
  item: BubbleItem;
  sender: string;
  /** The device a shared location comes from, as the location card names it. */
  device: string;
  locationState: LocationState;
  onTapback: (item: BubbleItem, bubble: HTMLElement) => void;
  onRetry: (clientMsgId: string) => void;
  onContact: (name: string) => void;
  onLink: (url: string) => void;
  onShareLocation: () => void;
  onReplies: (eventId: string) => void;
};

// Persona's legal address in the opening, a real link as iMessage draws one.
function WithTermsLink({ text }: { text: string }) {
  const [first = "", ...rest] = text.split(TERMS_URL);
  return (
    <>
      {first}
      {rest.map((part, i) => (
        <span key={i}>
          <a href={`https://${TERMS_URL}`} target="_blank" rel="noopener noreferrer" className="text-ios-blue underline">
            {TERMS_URL}
          </a>
          {part}
        </span>
      ))}
    </>
  );
}

export function MessageRow(props: MessageRowProps) {
  const { item, sender, device, locationState, onTapback, onRetry, onContact, onLink, onShareLocation, onReplies } = props;
  const { eventId, replyCount } = item;
  const { row, bubble } = useShrinkWrap(item.text);
  const quote = useRef<HTMLDivElement>(null);
  const { thread } = item;
  const { pending, contactCard: card } = item;
  const user = item.side === "user";

  // Tapbacks need a delivered message to point at, so pending texts cannot be reacted to.
  const openTapback = () => {
    if (item.eventId && bubble.current) onTapback(item, bubble.current);
  };
  const longPress = useLongPress(openTapback);

  return (
    <div
      ref={row}
      className={cx(
        "relative flex flex-col",
        user ? "items-end" : "items-start",
        // A tapback badge rises above its bubble; under a quote, the quote's own margin makes that room.
        item.reactions.length > 0 && thread?.anchor !== "quote" ? "mt-24" : thread ? "mt-12" : item.groupStart ? "mt-8" : "mt-2",
        item.fresh && (user ? styles.rise : styles.pop),
      )}
    >
      {thread?.anchor === "quote" && (
        <div className={cx("flex w-full flex-col", item.reactions.length > 0 ? "mb-24" : "mb-12")}>
          <QuotedOriginal original={thread.original} quoteRef={quote} onReplies={onReplies} />
        </div>
      )}
      {thread && (
        <ReplyLine thread={thread} replyKey={item.key} quote={quote} side={item.side} layoutKey={`${item.reactions.length}:${thread.anchor}`} />
      )}
      {item.text && (
        <div className="flex max-w-[75%] items-center gap-8">
          <BubbleView
            ref={bubble}
            data-bubble-key={item.key}
            side={item.side}
            tail={item.tail && !item.link && !card}
            reactions={item.reactions}
            onDoubleClick={openTapback}
            onContextMenu={(e) => {
              e.preventDefault();
              openTapback();
            }}
            {...longPress}
          >
            <span className="sr-only">{user ? "You" : sender}: </span>
            {user ? item.text : <WithTermsLink text={item.text} />}
          </BubbleView>
          {pending?.status === "failed" && (
            <button
              type="button"
              onClick={() => onRetry(pending.clientMsgId)}
              aria-label="Not delivered. Try again"
              className={cx("grid size-22 shrink-0 place-items-center rounded-full bg-ios-red text-ios-subhead font-bold text-surface", PRESS)}
            >
              !
            </button>
          )}
        </div>
      )}
      {card && <ContactBubble name={card.name} onOpen={() => onContact(card.name)} />}
      {item.link && <LinkCard link={item.link} tail={item.tail} onOpen={onLink} />}
      {item.locationRequest && <LocationRequestCard sender={sender} state={locationState} tail={item.tail} onShare={onShareLocation} />}
      {item.sharedLocation && <SharedLocationCard device={device} tail={item.tail} />}
      {eventId && replyCount && <RepliesLink count={replyCount} side={item.side} onOpen={() => onReplies(eventId)} />}
      {item.receipt && <ReceiptLine receipt={item.receipt} />}
    </div>
  );
}
