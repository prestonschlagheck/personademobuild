"use client";

import { useMotionValue, type MotionValue } from "motion/react";
import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useClientValue } from "@/lib/client/browser-store";
import { useMediaQuery } from "@/lib/client/use-media-query";

// Layout state for the stage around the phone. Layout itself is decided by CSS media queries, so the
// server markup is already right; these hooks only give components the same answers for behavior.

/** A phone viewport: the device alone, with no stage chrome around it. Mirrored in the stage, messages and call CSS. */
const HANDHELD_QUERY = "(pointer: coarse) and (max-width: 500px)";
/** Wide enough for the docked state panel. Below this the panel is a sheet. Mirrored in stage.module.css. */
const WIDE_QUERY = "(min-width: 1024px)";

type StageUiValue = {
  /** Whether the state panel shows in the current layout: docked when wide, a sheet otherwise. */
  xrayOpen: boolean;
  setXrayOpen: (open: boolean) => void;
  handheld: boolean;
  wide: boolean;
  /** False while the server markup hydrates, when CSS alone decides whether the docked panel shows. */
  hydrated: boolean;
  /** The control bar's bottom corner radius, squared off by as much of a hanging panel as shows below it. */
  barCorner: MotionValue<number>;
  /** A hanging panel reports how many px of it show below the bar, or null once it is gone. */
  reveal: (panelId: string, shown: number | null) => void;
};

/** The control bar's corner radius: half its 44px height, a pill. */
export const BAR_RADIUS = 22;

const StageUiContext = createContext<StageUiValue | null>(null);

export function useStageUi() {
  const value = use(StageUiContext);
  if (!value) throw new Error("useStageUi must be used inside <StageUiProvider>");
  return value;
}

export function StageUiProvider({ children }: { children: ReactNode }) {
  const handheld = useMediaQuery(HANDHELD_QUERY);
  const wide = useMediaQuery(WIDE_QUERY);
  const hydrated = useClientValue(() => true, false);
  // Collapsed on every load, docked or as a sheet; opening it lasts only until the page reloads.
  const [xrayOpen, setXrayOpen] = useState(false);
  const barCorner = useMotionValue(BAR_RADIUS);
  const shown = useRef(new Map<string, number>());

  // A corner rounds back only as the panel's own rounded foot rises past it, so the outline never breaks.
  const reveal = useCallback(
    (panelId: string, px: number | null) => {
      if (px === null) shown.current.delete(panelId);
      else shown.current.set(panelId, px);
      barCorner.set(Math.max(0, BAR_RADIUS - Math.max(0, ...shown.current.values())));
    },
    [barCorner],
  );

  const value = useMemo<StageUiValue>(
    () => ({ xrayOpen, setXrayOpen, handheld, wide, hydrated, barCorner, reveal }),
    [xrayOpen, setXrayOpen, handheld, wide, hydrated, barCorner, reveal],
  );

  return <StageUiContext value={value}>{children}</StageUiContext>;
}
