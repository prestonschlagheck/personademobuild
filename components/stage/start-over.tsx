"use client";

import { useEffect, useState, useTransition } from "react";
import { cx } from "@/components/ios/ui";
import { useOnboarding } from "@/lib/client/onboarding";
import { ConfirmIcon, RestartIcon } from "./control-bar-icons";
import styles from "./control-bar.module.css";
import { Segment } from "./segment";

const CONFIRM_MS = 5000;

// Deleting the session is irreversible, so the first press only arms it. Escape, blur or a few seconds of
// waiting disarm it again.
export function useStartOver(onErased?: () => void) {
  const { reset } = useOnboarding();
  const [armed, setArmed] = useState(false);
  const [erasing, startErasing] = useTransition();

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const press = () => {
    if (!armed) return setArmed(true);
    startErasing(async () => {
      await reset();
      setArmed(false);
      onErased?.();
    });
  };

  const label = erasing ? "Erasing" : armed ? "Confirm" : "Restart";
  return { armed, erasing, label, press, disarm: () => setArmed(false) };
}

export function StartOver({ className }: { className?: string }) {
  const { armed, erasing, label, press, disarm } = useStartOver();
  return (
    <Segment
      wide
      tone={armed ? "danger" : undefined}
      disabled={erasing}
      className={className}
      aria-label={armed ? "Confirm: erase this session" : undefined}
      onClick={press}
      onBlur={disarm}
      onKeyDown={(event) => event.key === "Escape" && disarm()}
    >
      {armed ? <ConfirmIcon /> : <RestartIcon />}
      {label}
    </Segment>
  );
}

// The same two presses as a menu row. Escape is left to the menu, which closes and so disarms it.
export function StartOverItem({ onErased }: { onErased: () => void }) {
  const { armed, erasing, label, press, disarm } = useStartOver(onErased);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={erasing}
      className={cx(styles.item, styles.action, armed && styles.danger)}
      onClick={() => !erasing && press()}
      onBlur={disarm}
    >
      {armed ? "Confirm: erase session" : label}
    </button>
  );
}
