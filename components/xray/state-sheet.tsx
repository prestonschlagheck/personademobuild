"use client";

import { AnimatePresence, motion, useDragControls } from "motion/react";
import { useEffect, useRef } from "react";
import { SHEET } from "@/lib/client/motion";
import { StatePanel } from "./state-panel";
import styles from "./xray.module.css";

const DISMISS_OFFSET = 96;
const DISMISS_VELOCITY = 480;

// The state panel as a bottom sheet on phones and narrow windows. Drag the grabber down to dismiss.
export function StateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <AnimatePresence>{open && <SheetDialog onClose={onClose} />}</AnimatePresence>;
}

function SheetDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const drag = useDragControls();

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-label="Logs"
      className={styles.dialog}
      onCancel={(event) => {
        // Escape plays the exit animation; unmounting then closes the dialog.
        event.preventDefault();
        onClose();
      }}
    >
      <motion.div
        className={styles.scrim}
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={SHEET}
      />
      <motion.div
        className={styles.sheet}
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={SHEET}
        drag="y"
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.6 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) onClose();
        }}
      >
        <div aria-hidden className={styles.grabber} onPointerDown={(event) => drag.start(event)} />
        <StatePanel onClose={onClose} />
      </motion.div>
    </dialog>
  );
}
