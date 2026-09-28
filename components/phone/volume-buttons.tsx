"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type CSSProperties } from "react";
import { useCall } from "@/lib/client/call-context";
import { EASE_STANDARD } from "@/lib/client/motion";
import { callVolume, nudgeVolumes, onNudge, ringerVolume, useVolume } from "@/lib/client/volume";
import styles from "./volume.module.css";

const HUD_MS = 1_500;
const HUD_MOTION = { duration: 0.2, ease: EASE_STANDARD };

// The frame's volume buttons, pressable, and the keyboard's volume keys where the browser hears them (not
// on macOS, which keeps them). Either moves the ringer and the call volume together.
export function VolumeButtons() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "AudioVolumeUp") nudgeVolumes(1);
      else if (event.key === "AudioVolumeDown") nudgeVolumes(-1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button type="button" aria-label="Volume up" className={styles.button} data-key="up" onClick={() => nudgeVolumes(1)} />
      <button type="button" aria-label="Volume down" className={styles.button} data-key="down" onClick={() => nudgeVolumes(-1)} />
    </>
  );
}

// iOS's volume, a slim glass capsule beside the buttons that shows for a moment after each press. On a call it
// shows the call volume, otherwise the ringer.
export function VolumeHud() {
  const [shown, setShown] = useState(false);
  const { phase } = useCall();
  const onCall = phase === "connecting" || phase === "active";
  const value = useVolume(onCall ? callVolume : ringerVolume);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onNudge(() => {
      setShown(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShown(false), HUD_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          role="status"
          aria-label={`${onCall ? "Call" : "Ringer"} volume ${Math.round(value * 100)}%`}
          className={styles.hud}
          style={{ "--value": value } as CSSProperties}
          initial={{ opacity: 0, x: "-60%" }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: "-60%" }}
          transition={HUD_MOTION}
        >
          <span className={styles.hudFill} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
