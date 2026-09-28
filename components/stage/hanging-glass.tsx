"use client";

import { animate, motion, PresenceContext, useMotionValue, useMotionValueEvent, usePresence, useReducedMotion, useTransform } from "motion/react";
import { use, useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { cx } from "@/components/ios/ui";
import { ROLL } from "@/lib/client/motion";
import { useStageUi } from "@/lib/client/stage-ui";
import styles from "./hanging-glass.module.css";
import { useLiquidGlass } from "./liquid-glass";
import glassStyles from "./liquid-glass.module.css";

// A panel hanging from the control bar: the bar's width, flat and square where they meet, so the two read as
// one piece of glass. It rolls down from under the bar's edge like a blind and back up the same way, and it
// tells the bar how much of it shows, so the bar's corners square off and round again exactly as the panel's
// rounded foot passes them.
export function HangingGlass({ children }: { children: ReactNode }) {
  const { measure, style, filter } = useLiquidGlass({ radius: 22, bezel: 14, flat: "top" });
  const { reveal } = useStageUi();
  const id = useId();
  const node = useRef<HTMLDivElement | null>(null);
  const [isPresent, safeToRemove] = usePresence();
  const finish = useEffectEvent(() => safeToRemove?.());
  // Already open when it mounts with the page, which plays no entrance.
  const progress = useMotionValue(use(PresenceContext)?.initial === false ? 1 : 0);
  const reduced = useReducedMotion();

  // The glass clips itself at the bar's edge by exactly as much as it has slid up, since a clip on a wrapper
  // would cut its backdrop blur off from what is behind it. The sides and foot reach out to keep the shadow.
  const y = useTransform(progress, (p) => `${(p - 1) * 100}%`);
  const clipPath = useTransform(progress, (p) => `inset(${(1 - p) * 100}% -48px -48px -48px)`);

  const report = useCallback(() => reveal(id, progress.get() * (node.current?.offsetHeight ?? 0)), [reveal, id, progress]);
  useMotionValueEvent(progress, "change", report);
  // Before the first paint, so a panel open with the page never shows the bar's corners round for a frame.
  useLayoutEffect(() => {
    report();
    return () => reveal(id, null);
  }, [report, reveal, id]);

  useEffect(() => {
    const roll = animate(progress, isPresent ? 1 : 0, reduced ? { duration: 0 } : ROLL);
    if (!isPresent) void roll.then(finish);
    return () => roll.stop();
  }, [isPresent, progress, reduced]);

  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      node.current = element;
      measure(element);
    },
    [measure],
  );

  return (
    <>
      {filter}
      <motion.div ref={ref} style={{ ...style, y, clipPath }} className={cx(glassStyles.liquid, styles.glass)}>
        {children}
      </motion.div>
    </>
  );
}
