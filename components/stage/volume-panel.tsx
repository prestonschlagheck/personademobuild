"use client";

import { motion } from "motion/react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { cx } from "@/components/ios/ui";
import { useCall } from "@/lib/client/call-context";
import { sounds } from "@/lib/client/sounds";
import { previewVoice } from "@/lib/client/voice-preview";
import { callVolume, ringerVolume, useVolume } from "@/lib/client/volume";
import { BellIcon, CallIcon, SoundOffIcon, SoundOnIcon } from "./control-bar-icons";
import styles from "./control-bar.module.css";
import { GlassSlider } from "./glass-slider";
import { useLiquidGlass } from "./liquid-glass";
import { MENU_MOTION, Segment } from "./segment";

/** Long enough to cross the gap from Sound to its panel without it closing. */
const HOVER_CLOSE_MS = 200;

type Hover = { onPointerEnter: (event: ReactPointerEvent) => void; onPointerLeave: (event: ReactPointerEvent) => void };

// Sound opens the two volumes: on hover with a mouse, and on a tap or a key for touch and the keyboard. Only the
// keyboard moves the focus into them; a pointer needs no focus ring on the slider it is about to grab.
export function useVolumePanel(anchor: RefObject<HTMLButtonElement | null>) {
  const [state, setState] = useState<{ open: boolean; focus: boolean }>({ open: false, focus: false });
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = (focus: boolean) => {
    clearTimeout(closeTimer.current);
    setState((prev) => (prev.open && !focus ? prev : { open: true, focus }));
  };

  const close = (restoreFocus = false) => {
    clearTimeout(closeTimer.current);
    setState({ open: false, focus: false });
    if (restoreFocus) anchor.current?.focus();
  };

  const hover: Hover = {
    onPointerEnter: (event) => event.pointerType === "mouse" && show(false),
    onPointerLeave: (event) => {
      if (event.pointerType !== "mouse") return;
      clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => setState({ open: false, focus: false }), HOVER_CLOSE_MS);
    },
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return { ...state, show, close, hover };
}

type SoundSegmentProps = {
  ref: RefObject<HTMLButtonElement | null>;
  open: boolean;
  panelId: string;
  hover: Hover;
  onOpen: (byKeyboard: boolean) => void;
  onClose: () => void;
};

export function SoundSegment({ ref, open, panelId, hover, onOpen, onClose }: SoundSegmentProps) {
  const ringer = useVolume(ringerVolume);
  const call = useVolume(callVolume);
  return (
    <Segment
      ref={ref}
      wide
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      className={styles.wideOnly}
      data-open={open || undefined}
      // A mouse already opened it by hovering, so its click keeps it open; a tap or a key toggles. A click from
      // Enter or Space has no detail.
      onClick={(event) => {
        const byKeyboard = event.detail === 0;
        if (open && (byKeyboard || (event.nativeEvent as PointerEvent).pointerType !== "mouse")) onClose();
        else onOpen(byKeyboard);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        onOpen(true);
      }}
      {...hover}
    >
      {ringer === 0 && call === 0 ? <SoundOffIcon /> : <SoundOnIcon />}
      Sound
    </Segment>
  );
}

type VolumePanelProps = {
  id: string;
  anchor: RefObject<HTMLButtonElement | null>;
  focus: boolean;
  hover: Hover;
  onClose: (restoreFocus?: boolean) => void;
};

export function VolumePanel({ id, anchor, focus, hover, onClose }: VolumePanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Liquid Glass with a heavier frost than the bar's, since it sits over the logs: blurred first, then bent at the rim.
  const { measure, style: glassStyle, filter: glassFilter } = useLiquidGlass({ radius: 20, bezel: 18 });
  const backdrop = glassStyle?.backdropFilter ? `blur(6px) ${glassStyle.backdropFilter}` : undefined;
  const closeOutside = useEffectEvent(() => onClose());
  const inside = (node: EventTarget | null) => node instanceof Node && (ref.current?.contains(node) || anchor.current?.contains(node));

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) closeOutside();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  });

  // Centered under Sound, placed before the first paint in the box the bar and the panel share.
  useLayoutEffect(() => {
    const panel = ref.current;
    const host = panel?.offsetParent;
    const button = anchor.current;
    if (!panel || !host || !button) return;
    const a = button.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    const left = a.left + a.width / 2 - box.left - panel.offsetWidth / 2;
    panel.style.left = `${Math.max(0, Math.min(left, box.width - panel.offsetWidth))}px`;
  }, [anchor]);

  useEffect(() => {
    if (focus) ref.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true });
  }, [focus]);

  return (
    <motion.div
      ref={(node: HTMLDivElement | null) => {
        ref.current = node;
        measure(node);
      }}
      id={id}
      role="group"
      aria-label="Volume"
      style={backdrop ? { backdropFilter: backdrop, WebkitBackdropFilter: backdrop } : undefined}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={MENU_MOTION}
      className={cx(styles.glass, styles.volumePanel)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose(true);
      }}
      onBlur={(event) => !inside(event.relatedTarget) && onClose()}
      {...hover}
    >
      {glassFilter}
      <VolumeSliders />
    </motion.div>
  );
}

// Each plays a sample once it settles, so its new level is heard: the message cue for the ringer, the agent's
// voice for the call. On a call the agent itself is the sample.
export function VolumeSliders({ inMenu }: { inMenu?: boolean }) {
  const ringer = useVolume(ringerVolume);
  const call = useVolume(callVolume);
  const { phase } = useCall();
  const onCall = phase === "connecting" || phase === "active";
  return (
    <>
      <GlassSlider label="Ringer" icon={<BellIcon />} value={ringer} onChange={ringerVolume.write} onCommit={() => sounds.play("receive")} inMenu={inMenu} />
      <GlassSlider label="Call" icon={<CallIcon />} value={call} onChange={callVolume.write} onCommit={onCall ? undefined : previewVoice} inMenu={inMenu} />
    </>
  );
}
