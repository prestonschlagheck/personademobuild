"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { cx } from "@/components/ios/ui";
import { EASE_STANDARD } from "@/lib/client/motion";
import { useNow } from "@/lib/client/use-now";
import type { LocationState } from "./attachments";
import { MessageRow } from "./bubble";
import styles from "./messages.module.css";
import { CallRow, LocationStartedRow, SystemRow, TimeRow } from "./rows";
import type { BubbleItem, ThreadItem } from "./thread-model";
import { TypingIndicator } from "./typing-indicator";

type ThreadProps = {
  items: ThreadItem[];
  typing: boolean;
  agentName: string | null;
  /** The device a shared location comes from. */
  device: string;
  /** The newest location request still waits on its Share My Location. */
  locationOpen: boolean;
  inAppBrowser: boolean;
  keyboardOpen: boolean;
  onTapback: (item: BubbleItem, bubble: HTMLElement) => void;
  onRetry: (clientMsgId: string) => void;
  onContact: (name: string) => void;
  onLink: (url: string) => void;
  onShareLocation: () => void;
  onReplies: (eventId: string) => void;
};

const LAYOUT = { type: "spring", duration: 0.45, bounce: 0.12 } as const;
// How close to the bottom still counts as reading the newest message, as the scroll library judges it.
const AT_BOTTOM_PX = 70;
// A scroll this soon after a wheel, touch or key press is the user's own, not the thread following new content.
const INTENT_MS = 300;
const KEYBOARD_EASE = `cubic-bezier(${EASE_STANDARD.join(", ")})`;

// Layout offset from the scroll container, ignoring transforms, so entrance animations never skew the gradient.
function offsetWithin(el: HTMLElement, ancestor: HTMLElement) {
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== ancestor) {
    y += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  return y;
}

export function Thread({ items, typing, agentName, device, locationOpen, inAppBrowser, keyboardOpen, ...handlers }: ThreadProps) {
  const { scrollRef, contentRef, scrollToBottom } = useStickToBottom({
    initial: "instant",
    resize: { damping: 0.8, stiffness: 0.07, mass: 1 },
  });
  const reduceMotion = useReducedMotion();
  const spacer = useRef<HTMLDivElement>(null);
  // Whether the thread follows new content. Only the user scrolling up themselves lets go of the bottom.
  const pinned = useRef(true);
  const lastScrollTop = useRef(0);
  const lastSpacer = useRef(0);
  const keyboardWas = useRef(keyboardOpen);
  // "Today" becomes "Yesterday" past midnight without a reload.
  const now = useNow(60_000);
  const sender = agentName ?? "Persona";

  // One rAF-throttled pass pins each user bubble's gradient to the screen, as iOS does: --screen-h on the
  // viewport, --bg-y on every blue bubble. A phone keyboard shrinking the viewport keeps the thread at the bottom.
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    let frame = 0;
    let height = scroll.clientHeight;
    const paint = () => {
      frame = 0;
      lastScrollTop.current = scroll.scrollTop;
      lastSpacer.current = spacer.current?.offsetHeight ?? 0;
      scroll.style.setProperty("--screen-h", `${scroll.clientHeight}px`);
      for (const el of content.querySelectorAll<HTMLElement>("[data-gradient]")) {
        el.style.setProperty("--bg-y", `${scroll.scrollTop - offsetWithin(el, scroll)}px`);
      }
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(paint);
    };
    // New content follows the bottom while the thread is pinned there. Pinning is judged from the user's own
    // scrolling, not from heights or the library's lock: a one-pixel settle (the typing dots leaving) reads to the
    // library as scrolling up, and a bubble landing mid-scroll, or the phone keyboard shrinking the viewport, reads
    // to a height check as having left the bottom. The eased scroll runs on animation frames, which stop while the
    // page is hidden or busy, so if it has not landed shortly after, the thread jumps the rest of the way.
    let contentHeight = scroll.scrollHeight;
    let settle = 0;
    let lastIntent = 0;
    let dragging = false;
    const intent = () => {
      lastIntent = performance.now();
    };
    const onPointerDown = () => {
      dragging = true;
    };
    const onPointerUp = () => {
      dragging = false;
    };
    // Only a scroll that moves up lets go: the thread's own eased scroll down to a new bubble, or a trackpad's
    // momentum still arriving as it runs, never does.
    let lastTop = scroll.scrollTop;
    const onScroll = () => {
      schedule();
      const top = scroll.scrollTop;
      const up = top < lastTop;
      lastTop = top;
      const distance = scroll.scrollHeight - scroll.clientHeight - top;
      if (distance <= AT_BOTTOM_PX) pinned.current = true;
      else if (up && (dragging || performance.now() - lastIntent < INTENT_MS)) pinned.current = false;
    };
    const onResize = () => {
      const grew = scroll.scrollHeight > contentHeight;
      const resized = scroll.clientHeight !== height;
      height = scroll.clientHeight;
      contentHeight = scroll.scrollHeight;
      schedule();
      if (!pinned.current) return;
      if (resized) scroll.scrollTop = scroll.scrollHeight;
      if (!grew) return;
      void scrollToBottom();
      clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (pinned.current) scroll.scrollTop = scroll.scrollHeight;
      }, 700);
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(scroll);
    observer.observe(content);
    scroll.addEventListener("scroll", onScroll, { passive: true });
    scroll.addEventListener("wheel", intent, { passive: true });
    scroll.addEventListener("touchmove", intent, { passive: true });
    scroll.addEventListener("keydown", intent);
    scroll.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      observer.disconnect();
      scroll.removeEventListener("scroll", onScroll);
      scroll.removeEventListener("wheel", intent);
      scroll.removeEventListener("touchmove", intent);
      scroll.removeEventListener("keydown", intent);
      scroll.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [scrollRef, contentRef, scrollToBottom]);

  // The desktop keyboard: the thread scrolls by its height at once, then eases from where it was, in step
  // with the keyboard's own slide. Short threads shift by layout instead, which motion animates per item.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    const room = spacer.current?.offsetHeight ?? 0;
    if (!scroll || !content || keyboardWas.current === keyboardOpen) return;
    keyboardWas.current = keyboardOpen;
    const before = lastScrollTop.current;
    if (keyboardOpen) scroll.scrollTop = before + room - lastSpacer.current;
    const shift = scroll.scrollTop - before;
    lastScrollTop.current = scroll.scrollTop;
    lastSpacer.current = room;
    if (!shift || reduceMotion) return;
    content.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], { duration: 320, easing: KEYBOARD_EASE });
  }, [keyboardOpen, scrollRef, contentRef, reduceMotion]);

  // Sending always brings the thread down to the new message, even from far up.
  const last = items.at(-1);
  const sentKey = last?.type === "bubble" && last.side === "user" && last.fresh ? last.key : null;
  useEffect(() => {
    if (!sentKey) return;
    pinned.current = true;
    void scrollToBottom();
  }, [sentKey, scrollToBottom]);

  // Only the newest location request acts.
  const newestRequest = items.findLast((i) => i.type === "bubble" && i.locationRequest)?.key;
  const locationOf = (item: BubbleItem): LocationState =>
    item.locationRequest?.shared ? "shared" : item.key === newestRequest && locationOpen ? "live" : "closed";

  const render = (item: ThreadItem) => {
    switch (item.type) {
      case "time":
        return <TimeRow at={item.at} first={item.first} now={now} />;
      case "row":
        return item.kind === "location_started" ? <LocationStartedRow row={item} sender={sender} now={now} /> : <CallRow row={item} />;
      case "bubble":
        return <MessageRow item={item} sender={sender} device={device} locationState={locationOf(item)} {...handlers} />;
      default: {
        const unknown: never = item;
        return unknown;
      }
    }
  };

  return (
    <motion.div ref={scrollRef} layoutScroll data-thread-scroll className={cx(styles.scroll, "absolute inset-0 overflow-y-auto")}>
      <div
        ref={contentRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={`Messages with ${sender}`}
        className="flex min-h-full flex-col justify-end px-16"
      >
        {inAppBrowser && <SystemRow>Open this page in Safari or Chrome to take the call and sign in with Google.</SystemRow>}
        {items.map((item) => (
          <motion.div key={item.key} layout="position" transition={{ layout: LAYOUT }}>
            {render(item)}
          </motion.div>
        ))}
        <AnimatePresence>{typing && <TypingIndicator key="typing" />}</AnimatePresence>
        <div
          ref={spacer}
          aria-hidden
          className="shrink-0"
          style={{ height: `calc(var(--chrome-h, 0px) + var(--pt) * 12${keyboardOpen ? " + var(--keyboard-lift)" : ""})` }}
        />
      </div>
    </motion.div>
  );
}
