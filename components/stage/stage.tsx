"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { PersonaMark, PersonaWordmark } from "@/components/brand/persona-logo";
import { StatePanel } from "@/components/xray/state-panel";
import { StateSheet } from "@/components/xray/state-sheet";
import { SHEET } from "@/lib/client/motion";
import { useStageUi } from "@/lib/client/stage-ui";
import { CallTranscript } from "./call-transcript";
import { ControlBar } from "./control-bar";
import { HangingGlass } from "./hanging-glass";
import styles from "./stage.module.css";

// The calm canvas around the phone: brand top left and the glass control bar top right on one row, then the
// device below. The logs panel drops down from the control bar as one piece of glass with it (a sheet on narrow screens).
export function Stage({ children }: { children: ReactNode }) {
  const { xrayOpen, setXrayOpen, wide, hydrated } = useStageUi();
  // Until hydration CSS applies the default (docked at 1280px and up), so the server markup never flashes.
  const docked = hydrated ? wide && xrayOpen : true;
  const shift = { layout: "position" as const, layoutDependency: docked, transition: SHEET };
  useInputModality();

  return (
    <MotionConfig reducedMotion="user">
      <main className={styles.stage} data-dock={hydrated ? (docked ? "open" : "closed") : "default"}>
        <PersonaMark className={styles.mark} />
        <div className={styles.canvas}>
          <h1 className={styles.brand}>
            <PersonaWordmark title="Persona onboarding" className={styles.wordmark} />
          </h1>
          <CallTranscript />
          <motion.div {...shift} className={styles.slot}>
            {children}
          </motion.div>
        </div>
        <div className={styles.controls}>
          <ControlBar />
        </div>
        <AnimatePresence initial={false} mode="popLayout">
          {docked && (
            <motion.aside
              key="xray"
              aria-label="Logs"
              data-default={hydrated ? undefined : ""}
              className={styles.dock}
            >
              <HangingGlass>
                <StatePanel />
              </HangingGlass>
            </motion.aside>
          )}
        </AnimatePresence>
        <StateSheet open={hydrated && !wide && xrayOpen} onClose={() => setXrayOpen(false)} />
      </main>
    </MotionConfig>
  );
}

// Remembers whether the last input was a pointer or the keyboard, so a click never leaves a focus ring
// (app/globals.css) while Tab and the arrow keys always show one.
function useInputModality() {
  useEffect(() => {
    const root = document.documentElement;
    const pointer = () => (root.dataset.input = "pointer");
    const keyboard = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey) root.dataset.input = "keyboard";
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, []);
}
