"use client";

import { useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { PersonaMark } from "@/components/brand/persona-logo";
import { cx } from "@/components/ios/ui";
import { useFocusTrap } from "@/components/ios/use-focus-trap";
import { contactIdentity } from "@/lib/client/contact";
import { useCall } from "@/lib/client/call-context";
import { EASE_STANDARD } from "@/lib/client/motion";
import { useOnboarding } from "@/lib/client/onboarding";
import { ActiveCall } from "./active-call";
import styles from "./call.module.css";
import { IncomingCall } from "./incoming-call";
import { IslandActivity } from "./island-activity";
import { MessageBanner } from "./message-banner";

// The call screen grows out of the Dynamic Island (124 x 36 pt, 14 pt from the top of the 402 x 874 pt
// screen) into the screen's own rounded corners. Percentages keep both clips in one shape, so they morph.
const ISLAND_CLIP = "inset(1.602% 34.577% 94.279% 34.577% round 4.478% / 2.059%)";
const SCREEN_CLIP = "inset(0% 0% 0% 0% round 14.18% / 6.521%)";

// Everything call related, layered over Messages inside the screen: the full screen call UI
// (z-30, under the status bar), then the island activity and banners above it (z-50).
export function CallLayer() {
  const { fullscreen, screen } = useCall();
  const { snapshot } = useOnboarding();
  const reduced = useReducedMotion();
  // The wallpaper is the saved contact's photo; an unsaved number gets iOS's plain gray backdrop instead.
  const { saved } = contactIdentity(snapshot?.session, "call");

  return (
    <>
      <AnimatePresence>
        {fullscreen && (
          <motion.div
            key="call"
            initial={reduced ? { opacity: 0 } : { opacity: 0, clipPath: ISLAND_CLIP }}
            // Unclipped once open: a phone without the frame has square corners of its own.
            animate={reduced ? { opacity: 1 } : { opacity: 1, clipPath: SCREEN_CLIP, transitionEnd: { clipPath: "none" } }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, clipPath: [SCREEN_CLIP, ISLAND_CLIP] }}
            transition={{ duration: 0.45, ease: EASE_STANDARD }}
            className={cx(styles.backdrop, "absolute inset-0 z-30 overflow-hidden text-on-dark")}
          >
            {saved && <PersonaMark className={cx(styles.mark, "pointer-events-none absolute text-on-dark/6")} />}
            <CallScreen incoming={screen === "incoming"} />
          </motion.div>
        )}
      </AnimatePresence>
      <IslandActivity />
      <MessageBanner />
    </>
  );
}

// A modal surface: focus moves in when a call takes over the screen, Tab stays inside it, and Escape
// does nothing, as a ringing phone ignores it.
function CallScreen({ incoming }: { incoming: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={incoming ? "Incoming call" : "Call"} tabIndex={-1} className="absolute inset-0 outline-none">
      <AnimatePresence initial={false}>
        <motion.div
          key={incoming ? "incoming" : "call"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24, ease: EASE_STANDARD }}
          className="absolute inset-0"
        >
          {incoming ? <IncomingCall /> : <ActiveCall />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
