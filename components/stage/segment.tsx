"use client";

import { motion } from "motion/react";
import type { ComponentProps } from "react";
import { cx } from "@/components/ios/ui";
import { EASE_STANDARD, SHEET } from "@/lib/client/motion";
import styles from "./control-bar.module.css";

/** How the bar's menus and panels open and close. */
export const MENU_MOTION = { duration: 0.2, ease: EASE_STANDARD };

export type SegmentProps = ComponentProps<typeof motion.button> & {
  icon?: boolean;
  /** One of the bar's main controls, which all share a width. */
  wide?: boolean;
  tone?: "danger";
};

// Segments slide to their new place when the bar grows or shrinks around them.
export function Segment({ icon, wide, tone, className, type = "button", ...props }: SegmentProps) {
  return (
    <motion.button
      layout="position"
      transition={SHEET}
      type={type}
      className={cx(styles.segment, icon && styles.icon, wide && styles.wide, tone === "danger" && styles.danger, className)}
      {...props}
    />
  );
}
