"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRef, type CSSProperties } from "react";
import { cx, MOTION_PRESS, PRESS } from "@/components/ios/ui";
import { useFocusTrap } from "@/components/ios/use-focus-trap";
import { EASE_HOUSE } from "@/lib/client/motion";
import type { ReactionType } from "@/lib/session/schema";
import { BubbleView } from "./bubble";
import { CopyIcon, ReplyIcon } from "@/components/ios/icons";
import styles from "./messages.module.css";
import { REACTIONS, TapbackIcon } from "./reactions";
import type { BubbleItem } from "./thread-model";

export type TapbackTarget = {
  item: BubbleItem;
  // Measured in CSS pixels against the phone screen, plus the gradient position the bubble had.
  box: { top: number; left: number; width: number; height: number; screenH: number; unit: number };
  gradient: { bgY: string; screenH: string };
};

type TapbackProps = {
  target: TapbackTarget | null;
  onPick: (type: ReactionType | null) => void;
  onReply: () => void;
  onCopy: () => void;
  onClose: () => void;
};

// Double-click or hold a bubble: the thread dims, the bubble lifts above it, and the iOS 26 reaction bar appears.
export function Tapback({ target, onPick, onReply, onCopy, onClose }: TapbackProps) {
  return (
    <AnimatePresence>
      {target && <Overlay key={target.item.key} target={target} onPick={onPick} onReply={onReply} onCopy={onCopy} onClose={onClose} />}
    </AnimatePresence>
  );
}

const FADE = { duration: 0.2, ease: EASE_HOUSE };

// Reply from the menu: the thread and header blur away behind the composer, which holds the message being answered.
// A tap on the blur backs out.
export function ReplyBackdrop({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          aria-hidden
          onClick={onClose}
          className="absolute inset-0 z-20 bg-surface/70 backdrop-blur-[calc(var(--pt)*12)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={FADE}
        />
      )}
    </AnimatePresence>
  );
}
const BAR_H = 48;
const GAP = 8;
const MENU_H = 88;
const STATUS_BAR = 64;
const HEADER = 149;

// Measures a bubble for the overlay. A bubble half under the header or composer is scrolled to the middle
// first, as iOS does before lifting it.
export function tapbackTarget(item: BubbleItem, bubble: HTMLElement, screen: HTMLElement, floor: number): TapbackTarget {
  const view = screen.getBoundingClientRect();
  const unit = view.width / 402;
  const scroller = bubble.closest<HTMLElement>("[data-thread-scroll]");
  const at = bubble.getBoundingClientRect();
  if (scroller && (at.top < view.top + HEADER * unit || at.bottom > floor)) {
    scroller.scrollTop += at.top + at.height / 2 - (view.top + view.height / 2);
  }
  const r = bubble.getBoundingClientRect();
  return {
    item,
    box: { top: r.top - view.top, left: r.left - view.left, width: r.width, height: r.height, screenH: view.height, unit },
    gradient: { bgY: bubble.style.getPropertyValue("--bg-y"), screenH: getComputedStyle(bubble).getPropertyValue("--screen-h") },
  };
}

function Overlay({ target, onPick, onReply, onCopy, onClose }: TapbackProps & { target: TapbackTarget }) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, onClose);

  const { item, box, gradient } = target;
  const user = item.side === "user";
  const mine = item.reactions.find((r) => r.from === "user")?.type;

  // The bar sits above the bubble, or below it when the bubble is near the top; the menu goes under both. A bubble
  // too low for the menu lifts until it fits, as iOS does, rather than the menu covering it.
  const u = box.unit;
  const lift = Math.max(0, box.top + box.height + (GAP + MENU_H + 24) * u - box.screenH);
  const top = box.top - lift;
  const above = top - (BAR_H + GAP) * u;
  const barAbove = above > STATUS_BAR * u;
  const barTop = barAbove ? above : top + box.height + GAP * u;
  const menuTop = Math.min((barAbove ? top + box.height : barTop + BAR_H * u) + GAP * u, box.screenH - (MENU_H + 24) * u);
  const side: CSSProperties = user ? { right: "calc(var(--pt) * 12)" } : { left: "calc(var(--pt) * 12)" };

  // Each layer fades on its own: an ancestor below full opacity would switch off every backdrop blur inside it.
  return (
    <motion.div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label="React to message"
      tabIndex={-1}
      className="absolute inset-0 z-40"
      style={{ outline: "none" }}
    >
      <motion.div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-surface/70 backdrop-blur-[calc(var(--pt)*12)]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={FADE}
      />

      <div
        className="absolute"
        style={{ top, left: box.left, width: box.width }}
        ref={(el) => {
          el?.style.setProperty("--bg-y", gradient.bgY);
          el?.style.setProperty("--screen-h", gradient.screenH);
        }}
      >
        <BubbleView side={item.side} tail={item.tail} reactions={item.reactions}>
          {item.text}
        </BubbleView>
      </div>

      <motion.div
        role="toolbar"
        aria-label="Tapbacks"
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.85, transition: FADE }}
        transition={{ duration: 0.28, ease: EASE_HOUSE }}
        className={cx(styles.glass, "absolute flex h-48 items-center gap-2 rounded-full px-4", user ? "origin-bottom-right" : "origin-bottom-left")}
        style={{ top: barTop, ...side }}
      >
        {REACTIONS.map(({ type, label }) => (
          <button
            key={type}
            type="button"
            aria-label={label}
            aria-pressed={mine === type}
            onClick={() => onPick(mine === type ? null : type)}
            className={cx(
              "grid size-40 place-items-center rounded-full",
              PRESS,
              mine === type && "bg-ios-blue",
            )}
          >
            <TapbackIcon type={type} size={24} />
          </button>
        ))}
      </motion.div>

      <motion.div
        role="menu"
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: FADE }}
        transition={{ duration: 0.28, ease: EASE_HOUSE, delay: 0.04 }}
        className={cx(styles.glass, "absolute flex w-200 flex-col overflow-hidden rounded-ios-card text-ios-body text-ink")}
        style={{ top: menuTop, ...side }}
      >
        {[
          { label: "Reply", Icon: ReplyIcon, onClick: onReply },
          { label: "Copy", Icon: CopyIcon, onClick: onCopy },
        ].map(({ label, Icon, onClick }, i) => (
          <motion.button
            key={label}
            type="button"
            role="menuitem"
            onClick={onClick}
            whileTap={MOTION_PRESS}
            className={cx("flex h-44 items-center justify-between px-16", i > 0 && "border-t-[0.5px] border-ios-label-3/40")}
          >
            {label}
            <Icon className="size-20" />
          </motion.button>
        ))}
      </motion.div>
    </motion.div>
  );
}
