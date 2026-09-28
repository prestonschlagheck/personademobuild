"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { PhoneIcon } from "@/components/ios/icons";
import { cx } from "@/components/ios/ui";
import { useCall, useCallLevel } from "@/lib/client/call-context";
import { formatDuration } from "@/lib/client/format";
import { EASE_STANDARD } from "@/lib/client/motion";
import styles from "./call.module.css";

const EXPANDED_MS = 3_000;
const ENTER = { opacity: 0, scale: 0.7 };
const SHOWN = { opacity: 1, scale: 1 };
const MORPH = { duration: 0.34, ease: EASE_STANDARD };

// Six bars, as wide as the timer across from them and tallest in the middle, each wobbling at its own rate so a
// steady voice still reads as speech.
const BARS = [
  { weight: 0.5, rate: 11.3, phase: 0 },
  { weight: 0.8, rate: 14.1, phase: 1.9 },
  { weight: 1, rate: 9.7, phase: 3.1 },
  { weight: 0.9, rate: 12.6, phase: 4.4 },
  { weight: 0.7, rate: 15.2, phase: 0.8 },
  { weight: 0.45, rate: 10.4, phase: 5.2 },
];
// The meter reads 0.4 to 0.8 for ordinary speech, so full height takes a raised voice.
const GAIN = 1.35;

// The call as a Dynamic Island live activity while the user is back in Messages, or while another
// tab holds the call.
export function IslandActivity() {
  const call = useCall();
  const kind = call.island;
  const timer = formatDuration(call.seconds);

  return (
    <AnimatePresence>
      {kind &&
        (kind === "call" ? (
          <Compact key="call" timer={timer} flat={call.muted} onPress={call.returnToCall} label={`Return to call, ${timer}`} />
        ) : (
          <Elsewhere key="elsewhere" timer={timer} />
        ))}
    </AnimatePresence>
  );
}

type CompactProps = { timer: string; label: string; onPress: () => void; flat: boolean; quiet?: boolean };

// The compact presentation: the timer leading and the waveform trailing, one width each, equally inset.
function Compact({ timer, label, onPress, flat, quiet }: CompactProps) {
  return (
    <motion.button
      type="button"
      onClick={onPress}
      aria-label={label}
      initial={ENTER}
      animate={SHOWN}
      exit={ENTER}
      transition={MORPH}
      className={cx(styles.island, "absolute z-50 flex items-center justify-between rounded-full bg-island text-ios-green")}
    >
      <span className={cx(styles.islandEnd, styles.timer, "font-semibold tabular-nums")}>{timer}</span>
      <span className={cx(styles.islandEnd, "flex justify-end", quiet && "opacity-40")}>
        <Waveform flat={flat} />
      </span>
    </motion.button>
  );
}

// Follows the call's live level (the agent while it talks, the mic otherwise) every frame, straight onto the bars'
// heights, so nothing re-renders. Muted, it lies flat. Reduced motion keeps the level but drops the wobble.
function Waveform({ flat }: { flat: boolean }) {
  const level = useCallLevel();
  const reduced = useReducedMotion();
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    let frame = 0;
    const draw = (now: number) => {
      const loud = flat ? 0 : level.get();
      const t = now / 1000;
      BARS.forEach(({ weight, rate, phase }, index) => {
        const bar = bars.current[index];
        if (!bar) return;
        const wobble = reduced ? 1 : 0.6 + 0.4 * Math.sin(t * rate + phase);
        bar.style.setProperty("--level", String(Math.min(1, loud * GAIN * weight * wobble)));
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [flat, level, reduced]);

  return (
    <span aria-hidden className={cx(styles.wave, "flex items-center")}>
      {BARS.map((_, index) => (
        <span
          key={index}
          ref={(node) => {
            bars.current[index] = node;
          }}
          className={cx(styles.bar, "rounded-full bg-current")}
        />
      ))}
    </span>
  );
}

// Another tab owns the audio. The pill opens once to say so, then settles; a tap opens it again.
function Elsewhere({ timer }: { timer: string }) {
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!expanded) return;
    const timeout = setTimeout(() => setExpanded(false), EXPANDED_MS);
    return () => clearTimeout(timeout);
  }, [expanded]);

  return (
    <AnimatePresence initial={false}>
      {expanded ? (
        <motion.button
          key="expanded"
          type="button"
          onClick={() => setExpanded(false)}
          initial={ENTER}
          animate={SHOWN}
          exit={ENTER}
          transition={MORPH}
          className={cx(
            styles.expanded,
            "absolute z-50 flex items-center justify-center gap-8 bg-island text-ios-subhead font-semibold text-on-dark",
          )}
        >
          <PhoneIcon className="size-16 text-ios-green" />
          On a call in another tab
        </motion.button>
      ) : (
        <Compact key="compact" timer={timer} flat quiet label="On a call in another tab" onPress={() => setExpanded(true)} />
      )}
    </AnimatePresence>
  );
}
