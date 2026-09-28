"use client";

import { useRef } from "react";
import { AnimatePresence, motion, type PanInfo } from "motion/react";
import { PersonaMark } from "@/components/brand/persona-logo";
import { cx } from "@/components/ios/ui";
import { useCall } from "@/lib/client/call-context";
import { contactIdentity } from "@/lib/client/contact";
import { EASE_STANDARD } from "@/lib/client/motion";
import { useOnboarding } from "@/lib/client/onboarding";
import styles from "./call.module.css";

const HIDDEN = { y: "-140%", opacity: 0 };

// An iOS notification banner for texts that land while the call screen is up (the Gmail link, say).
// Tap opens Messages, a swipe up or five seconds puts it away. Its name comes from the visible text, never
// an attribute copy of it, so session replay masks the message along with the rest of the screen.
export function MessageBanner() {
  const { banner, dismissBanner, showMessages } = useCall();
  const { snapshot } = useOnboarding();
  const dragged = useRef(false);
  const { name } = contactIdentity(snapshot?.session);

  const onDragEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.y < -24 || info.velocity.y < -300) dismissBanner();
  };

  return (
    <AnimatePresence>
      {banner && (
        <motion.button
          key={banner.id}
          type="button"
          onClick={() => {
            if (!dragged.current) showMessages();
          }}
          drag="y"
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0.7, bottom: 0.08 }}
          onPointerDown={() => {
            dragged.current = false;
          }}
          onDragStart={() => {
            dragged.current = true;
          }}
          onDragEnd={onDragEnd}
          initial={HIDDEN}
          animate={{ y: 0, opacity: 1 }}
          exit={HIDDEN}
          transition={{ duration: 0.42, ease: EASE_STANDARD }}
          className={cx(
            styles.banner,
            "absolute inset-x-8 z-50 flex touch-none items-center gap-10 bg-surface/80 px-14 py-12 text-left text-ink backdrop-blur-2xl",
          )}
        >
          <span className={cx(styles.appIcon, "grid size-38 shrink-0 place-items-center bg-surface")}>
            <PersonaMark className="w-21 text-accent" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-8">
              <span className="truncate text-ios-subhead font-semibold">
                <span className="sr-only">Message from </span>
                {name}
              </span>
              <span className="text-ios-footnote text-ink-soft">now</span>
            </span>
            <span className="block truncate text-ios-subhead">{banner.text}</span>
            <span className="sr-only">Open Messages.</span>
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
