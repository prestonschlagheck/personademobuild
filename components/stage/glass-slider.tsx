"use client";

import { animate, motion, useMotionValue, useSpring, useTransform, useVelocity } from "motion/react";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import styles from "./glass-slider.module.css";
import { useGlassLens } from "./glass-lens";

/** The thumb's size at rest, in px. Mirrored in glass-slider.module.css. */
const THUMB_WIDTH = 38;
const THUMB_HEIGHT = 24;
const KEY_STEP = 1 / 16;
/** How far the slider gives when pulled past an end, at most, in px. */
const PULL_LIMIT = 16;
/** The pointer speed, in px/s, that stretches the thumb the most, and by how much. */
const STRETCH_SPEED = 2_400;
const STRETCH_MAX = 0.35;
const HOLD_SPRING = { stiffness: 520, damping: 30, mass: 0.6 };
const STRETCH_SPRING = { stiffness: 700, damping: 30 };
/** Underdamped, so a pull let go overshoots and settles like the real one. */
const SETTLE = { type: "spring", stiffness: 420, damping: 13, mass: 0.7 } as const;

/** Resistance that grows with distance: the first pixels give freely, and it never passes the limit. */
const rubberBand = (excess: number) => Math.sign(excess) * PULL_LIMIT * (1 - 1 / ((Math.abs(excess) / PULL_LIMIT) * 0.55 + 1));
const clamp = (value: number) => Math.min(1, Math.max(0, value));

type GlassSliderProps = {
  label: string;
  icon: ReactNode;
  /** 0 to 1. */
  value: number;
  onChange: (value: number) => void;
  /** A drag let go or a key pressed: the value the user settled on. */
  onCommit?: () => void;
  /** Inside a menu, Up and Down move between items, so only Left and Right change the value. */
  inMenu?: boolean;
};

// An iOS 26 slider: a white capsule on a thin track. Held, the capsule swells into a clear glass lens over the
// track. It stretches with the speed of a drag, gives like rubber when pulled past an end, and springs back.
export function GlassSlider({ label, icon, value, onChange, onCommit, inMenu }: GlassSliderProps) {
  const track = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState(false);
  // Pointer up and the lost capture both end a drag, in the same tick; the ref lets only the first commit.
  const dragging = useRef(false);
  const lens = useGlassLens(THUMB_WIDTH, THUMB_HEIGHT);
  const percent = Math.round(value * 100);

  const pull = useMotionValue(0);
  const width = useMotionValue(0);
  const pointerX = useMotionValue(0);
  const speed = useVelocity(pointerX);
  const stretch = useSpring(
    useTransform(speed, (v) => 1 + Math.min(Math.abs(v) / STRETCH_SPEED, 1) * STRETCH_MAX),
    STRETCH_SPRING,
  );
  const hold = useSpring(0, HOLD_SPRING);
  // Swelled while held, longer and thinner at speed, and a little longer again while pulled past an end.
  const thumbScaleX = useTransform([hold, stretch, pull], ([h = 0, s = 1, p = 0]: number[]) => (1 + 0.45 * h) * s * (1 + Math.abs(p) / 60));
  const thumbScaleY = useTransform([hold, stretch, pull], ([h = 0, s = 1, p = 0]: number[]) => (1 + 0.3 * h) / Math.sqrt(s * (1 + Math.abs(p) / 60)));
  // The track stretches from its far end, so the end being pulled is the one that moves.
  const trackScaleX = useTransform([pull, width], ([p = 0, w = 0]: number[]) => (w > 0 ? 1 + Math.abs(p) / w : 1));
  const trackOrigin = useTransform(pull, (p) => (p < 0 ? 1 : 0));

  const follow = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= THUMB_WIDTH) return;
    const travel = box.width - THUMB_WIDTH;
    const raw = (clientX - box.left - THUMB_WIDTH / 2) / travel;
    pointerX.set(clientX);
    pull.set(rubberBand((raw - clamp(raw)) * travel));
    onChange(clamp(raw));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
    setHeld(true);
    hold.set(1);
    width.set(event.currentTarget.getBoundingClientRect().width);
    // Jumped, not set, so the press itself reads as no speed.
    pointerX.jump(event.clientX);
    follow(event.clientX);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) follow(event.clientX);
  };

  const release = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setHeld(false);
    hold.set(0);
    animate(pull, 0, SETTLE);
    onCommit?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = {
      ArrowRight: value + KEY_STEP,
      ArrowLeft: value - KEY_STEP,
      PageUp: value + 4 * KEY_STEP,
      PageDown: value - 4 * KEY_STEP,
      ...(!inMenu && { ArrowUp: value + KEY_STEP, ArrowDown: value - KEY_STEP, Home: 0, End: 1 }),
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    // Already at the end: a small knock against it instead of nothing.
    if (next !== clamp(next) && value === clamp(next)) {
      width.set(event.currentTarget.getBoundingClientRect().width);
      animate(pull, 0, { ...SETTLE, velocity: Math.sign(next - value) * 260 });
    }
    onChange(clamp(next));
    onCommit?.();
  };

  return (
    <div className={styles.field}>
      <div className={styles.label}>
        {icon}
        {label}
      </div>
      {lens.filter}
      <div
        ref={track}
        role="slider"
        tabIndex={inMenu ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={value === 0 ? "Off" : `${percent}%`}
        data-held={held || undefined}
        className={styles.slider}
        style={{ "--value": value } as CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onKeyDown={onKeyDown}
      >
        <motion.span className={styles.track} style={{ y: "-50%", scaleX: trackScaleX, originX: trackOrigin }}>
          <span className={styles.fill} />
        </motion.span>
        <motion.span className={styles.thumbSlot} style={{ x: pull }}>
          <motion.span aria-hidden className={styles.thumb} style={{ ...lens.style, scaleX: thumbScaleX, scaleY: thumbScaleY }} />
        </motion.span>
      </div>
    </div>
  );
}
