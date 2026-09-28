"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CloseIcon, LocationIcon, PlusIcon, WaveformIcon } from "@/components/ios/icons";
import { cx, PRESS } from "@/components/ios/ui";
import { EASE_HOUSE } from "@/lib/client/motion";
import { useNow } from "@/lib/client/use-now";
import styles from "./messages.module.css";
import type { VoiceMemo } from "./use-voice-memo";

// The pieces of the iOS 26 composer around the field: the plus menu on the left, the waveform on the right that
// records an audio message while held, and the field's recording state.

const POP = { duration: 0.2, ease: EASE_HOUSE };
// A press longer than this is a hold, and records; anything shorter only shows how.
const HOLD_MS = 250;
const HINT_MS = 1_800;

type MenuItem = { label: string; icon: ReactNode; tint: string; onSelect: () => void };

// The plus opens the apps list above it, as iOS 26 does, with only what this thread can actually send.
export function PlusMenu({ onAudio, onLocation }: { onAudio: (() => void) | null; onLocation: (() => void) | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const items: MenuItem[] = [
    ...(onAudio ? [{ label: "Audio", icon: <WaveformIcon className="size-17" />, tint: "bg-[#ff9500]", onSelect: onAudio }] : []),
    ...(onLocation ? [{ label: "Location", icon: <LocationIcon className="size-15" />, tint: "bg-ios-green", onSelect: onLocation }] : []),
  ];

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-label="Apps"
        aria-expanded={open}
        disabled={items.length === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className={cx(styles.glass, styles.sheer, "grid size-40 place-items-center rounded-full text-ink disabled:text-ios-label-3", PRESS)}
      >
        <PlusIcon className={cx("size-14.5 transition-transform duration-200", open && "rotate-45")} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.9, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 6 }}
            transition={POP}
            className={cx(styles.glass, "absolute bottom-full left-0 mb-10 flex w-200 origin-bottom-left flex-col rounded-ios-card py-6")}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cx("flex h-44 items-center gap-12 px-12 text-ios-body text-ink", PRESS)}
              >
                <span className={cx("grid size-30 place-items-center rounded-full text-surface", item.tint)}>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// The waveform in the field: hold to record, let go to send. A tap only says so, as iOS does.
export function AudioButton({ memo }: { memo: VoiceMemo }) {
  const [hint, setHint] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const held = useRef(false);
  const recording = memo.recording?.mode === "hold";

  useEffect(
    () => () => {
      clearTimeout(holdTimer.current);
      clearTimeout(hintTimer.current);
    },
    [],
  );

  const release = (send: boolean) => {
    clearTimeout(holdTimer.current);
    if (held.current) return send ? memo.finish() : memo.cancel();
    if (!send) return;
    setHint(true);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(false), HINT_MS);
  };

  return (
    <span className="relative grid size-30 place-items-center">
      <AnimatePresence>
        {hint && (
          <motion.span
            role="status"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={POP}
            className={cx(styles.glass, "absolute right-0 bottom-full mb-14 whitespace-nowrap rounded-full px-14 py-8 text-ios-footnote text-ink")}
          >
            Tap and hold to record
          </motion.span>
        )}
      </AnimatePresence>
      <button
        type="button"
        aria-label="Record audio message"
        aria-pressed={recording}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          held.current = false;
          setHint(false);
          holdTimer.current = setTimeout(() => {
            held.current = true;
            memo.start("hold");
          }, HOLD_MS);
        }}
        onPointerUp={() => release(true)}
        onPointerCancel={() => release(false)}
        // Keyboard users get the tap mode: Enter or Space starts it, the send button ends it.
        onClick={(e) => e.detail === 0 && memo.start("tap")}
        onContextMenu={(e) => e.preventDefault()}
        className={cx(
          "grid size-30 touch-none place-items-center rounded-full select-none",
          recording ? "bg-ios-red text-surface" : "text-ios-label-2",
          PRESS,
        )}
      >
        <WaveformIcon className="size-19" />
      </button>
    </span>
  );
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

// What the field shows while recording: the red dot, the time, and the words as they are heard.
export function RecordingStrip({ memo }: { memo: VoiceMemo }) {
  const now = useNow(250);
  const recording = memo.recording;
  if (!recording) return null;
  return (
    <div className="flex min-h-22 min-w-0 flex-1 items-center gap-8 text-ios-body" aria-live="polite">
      {recording.mode === "tap" && (
        <button type="button" aria-label="Cancel recording" onClick={memo.cancel} className={cx("-ml-6 grid size-22 shrink-0 place-items-center text-ios-label-2", PRESS)}>
          <CloseIcon className="size-14" />
        </button>
      )}
      <span aria-hidden className="size-9 shrink-0 animate-pulse-soft rounded-full bg-ios-red" />
      <span className="shrink-0 tabular-nums text-ios-red">{clock(now - recording.startedAt)}</span>
      <span className="min-w-0 truncate text-ios-label-2">{recording.transcript || "Recording"}</span>
    </div>
  );
}
