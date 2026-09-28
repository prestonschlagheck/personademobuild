"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { cx, PRESS } from "@/components/ios/ui";
import { useFocusTrap } from "@/components/ios/use-focus-trap";
import { EASE_HOUSE } from "@/lib/client/motion";
import styles from "./call.module.css";
import { EndButton } from "./end-button";

const KEYS = [
  ["1", ""],
  ["2", "ABC"],
  ["3", "DEF"],
  ["4", "GHI"],
  ["5", "JKL"],
  ["6", "MNO"],
  ["7", "PQRS"],
  ["8", "TUV"],
  ["9", "WXYZ"],
  ["*", ""],
  ["0", "+"],
  ["#", ""],
] as const;

const SPOKEN: Record<string, string> = { "*": "star", "#": "pound" };
// About as many digits as fit across the screen at the display size; iOS keeps the latest in view.
const SHOWN_DIGITS = 14;

// The iOS in-call keypad over the call screen. The digits show at the top as they are pressed and go nowhere:
// the agent has no menu to navigate, so this changes no state. Hide or Escape puts it away.
export function Keypad({ onHide, onEnd, disabled }: { onHide: () => void; onEnd: () => void; disabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [digits, setDigits] = useState("");
  useFocusTrap(ref, onHide);

  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label="Keypad"
      tabIndex={-1}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.2, ease: EASE_HOUSE }}
      className="absolute inset-0 flex flex-col pt-(--safe-top) pb-(--safe-bottom) outline-none"
    >
      <p aria-live="polite" className={cx(styles.digits, "px-24 text-center tabular-nums whitespace-pre")}>
        {digits.slice(-SHOWN_DIGITS) || " "}
      </p>

      <div className={cx(styles.keypad, "mt-auto grid grid-cols-3 justify-items-center")}>
        {KEYS.map(([digit, letters]) => (
          <button
            key={digit}
            type="button"
            aria-label={SPOKEN[digit] ?? digit}
            onClick={() => setDigits((typed) => typed + digit)}
            className={cx(styles.glass, styles.key, "flex flex-col items-center justify-center rounded-full", PRESS)}
          >
            <span aria-hidden className={styles.keyDigit}>
              {digit}
            </span>
            {letters && (
              <span aria-hidden className={styles.keyLetters}>
                {letters}
              </span>
            )}
          </button>
        ))}
        <EndButton className="col-start-2" disabled={disabled} onPress={onEnd} />
        <button type="button" onClick={onHide} className={cx("self-center text-ios-body", PRESS)}>
          Hide
        </button>
      </div>
    </motion.div>
  );
}
