"use client";

import { createContext, use, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useMotionValue, type MotionValue } from "motion/react";
import { useOnboarding } from "@/lib/client/onboarding";
import {
  callView,
  type Banner,
  type Caption,
  type CallFailure,
  type CallPhase,
  type CallScreen,
  type DeclineAction,
} from "@/lib/voice/call-state";
import { watchClientErrors } from "@/lib/client/dev-trace";
import { CallController } from "@/lib/voice/controller";

export type { Caption, CallPhase, CallScreen, DeclineAction } from "@/lib/voice/call-state";

// React binding for the call controller. Everything here is derived; the controller holds the state.

type CallValue = {
  screen: CallScreen;
  /** The call UI covers Messages. The status bar turns white. */
  fullscreen: boolean;
  phase: CallPhase;
  muted: boolean;
  speaker: boolean;
  seconds: number;
  lastLatencyMs: number | null;
  /** The session has a live call that this tab is not connected to. */
  otherTab: boolean;
  /** What the Dynamic Island shows: this tab's call while Messages is up, or a call held by another tab. */
  island: "call" | "elsewhere" | null;
  failure: CallFailure | null;
  banner: Banner | null;
  /** Calls the agent from this tab, which is then the only one that connects it. */
  dial: () => void;
  accept: () => void;
  decline: (action: DeclineAction) => void;
  hangUp: () => void;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  showMessages: () => void;
  returnToCall: () => void;
  say: (text: string) => void;
  dismissBanner: () => void;
};

const CallContext = createContext<CallValue | null>(null);
const LevelContext = createContext<MotionValue<number> | null>(null);
const ControllerContext = createContext<CallController | null>(null);

export function useCall() {
  const value = use(CallContext);
  if (!value) throw new Error("useCall must be used inside <CallProvider>");
  return value;
}

/** The latest lines on either side, for the stage transcript. Its own subscription, so a word repaints only its readers. */
export function useCallCaptions(): Caption[] {
  const controller = use(ControllerContext);
  if (!controller) throw new Error("useCallCaptions must be used inside <CallProvider>");
  return useSyncExternalStore(controller.subscribeCaptions, controller.getCaptions, controller.getCaptions);
}

/** Per-frame loudness for the island waveform, without re-rendering anything. */
export function useCallLevel() {
  const value = use(LevelContext);
  if (!value) throw new Error("useCallLevel must be used inside <CallProvider>");
  return value;
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { snapshot, apply } = useOnboarding();
  const [controller] = useState(() => new CallController(apply));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const level = useMotionValue(0);
  const active = state.phase === "active";

  useEffect(() => controller.mount(), [controller]);
  useEffect(() => watchClientErrors(), []);
  useEffect(() => controller.sync(snapshot), [controller, snapshot]);

  useEffect(() => {
    if (!active) {
      level.set(0);
      return;
    }
    let frame = 0;
    const loop = () => {
      level.set(controller.level());
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active, controller, level]);

  const { screen, fullscreen, otherTab } = callView(snapshot?.session ?? null, state);
  const minimized = (state.phase === "connecting" || state.phase === "active") && !fullscreen;
  const island = minimized ? "call" : otherTab ? "elsewhere" : null;

  const value = useMemo<CallValue>(
    () => ({
      screen,
      fullscreen,
      otherTab,
      island,
      phase: state.phase,
      muted: state.muted,
      speaker: state.speaker,
      seconds: state.seconds,
      lastLatencyMs: state.lastLatencyMs,
      failure: state.failure,
      banner: state.banner,
      dial: controller.dial,
      accept: controller.accept,
      decline: controller.decline,
      hangUp: controller.hangUp,
      toggleMute: controller.toggleMute,
      toggleSpeaker: controller.toggleSpeaker,
      showMessages: controller.showMessages,
      returnToCall: controller.returnToCall,
      say: controller.say,
      dismissBanner: controller.dismissBanner,
    }),
    [screen, fullscreen, otherTab, island, state, controller],
  );

  return (
    <CallContext value={value}>
      <LevelContext value={level}>
        <ControllerContext value={controller}>{children}</ControllerContext>
      </LevelContext>
    </CallContext>
  );
}
