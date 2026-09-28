import type { Transition } from "motion/react";

// Persona's curves from app/globals.css (--ease-house, --ease-standard) for motion's JS animations.
export const EASE_HOUSE = [0.16, 1, 0.3, 1] as const;
export const EASE_STANDARD = [0.32, 0.72, 0, 1] as const;

/** Sheets, the state panel and the stage shifts: the iOS sheet curve at Persona's sheet duration. */
export const SHEET: Transition = { duration: 0.32, ease: EASE_STANDARD };

/** A panel rolling down from the control bar and back up (components/stage/hanging-glass.tsx). */
export const ROLL: Transition = { duration: 0.42, ease: EASE_STANDARD };
