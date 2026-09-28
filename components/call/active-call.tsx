"use client";

import { useRef, useState, type ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EllipsisIcon, KeypadIcon, MessageIcon, MicSlashIcon, SpeakerIcon } from "@/components/ios/icons";
import { cx, PRESS } from "@/components/ios/ui";
import { useFocusTrap } from "@/components/ios/use-focus-trap";
import { useCall } from "@/lib/client/call-context";
import { formatDuration } from "@/lib/client/format";
import { EASE_HOUSE, EASE_STANDARD } from "@/lib/client/motion";
import { useOnboarding } from "@/lib/client/onboarding";
import styles from "./call.module.css";
import { CallHeader } from "./call-header";
import { EndButton } from "./end-button";
import { Keypad } from "./keypad";
import { useCaller } from "./use-caller";

type Glyph = ComponentType<{ className?: string }>;

// The line under "Call Failed": what stopped it, when there is something the user can do about it.
const FAILURE_DETAIL = {
  blocked: "Microphone access is blocked",
  missing: "No microphone found",
  busy: "Microphone is in use by another app",
  unsupported: "This browser can't use the microphone",
  elsewhere: "On a call in another tab",
  ringing: "A call is already ringing",
  gone: "This call already ended",
  rate_limited: "Too many calls. Try again in a few minutes.",
} as const;

const FADE = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.2, ease: EASE_STANDARD } };

function statusLine({ screen, failure, phase, seconds }: ReturnType<typeof useCall>) {
  if (screen === "ended") return failure ? "Call Failed" : "Call Ended";
  if (screen === "outgoing") return "Calling mobile…";
  return phase === "active" ? formatDuration(seconds) : "Connecting…";
}

// One in-call screen for every stage after the ring: calling, connecting, live, and the ended hold. Laid out as
// iOS 26 does it: the caller top left, the six controls at the bottom. What was said shows beside the phone
// (components/stage/call-transcript.tsx), not on it.
export function ActiveCall() {
  const call = useCall();
  const { snapshot } = useOnboarding();
  const [sheet, setSheet] = useState<"keypad" | "more" | null>(null);
  const ended = call.screen === "ended";
  // A call that ends puts away whatever was open over it.
  const open = ended ? null : sheet;
  const close = () => setSheet(null);
  const failureDetail = ended && call.failure && call.failure !== "failed" ? FAILURE_DETAIL[call.failure] : null;
  const { name, saved, maybe } = useCaller();
  const detail = failureDetail ?? (maybe && `maybe: ${maybe}`);
  const mockVoice = call.phase === "active" && snapshot?.modes.voice === "mock";

  return (
    <AnimatePresence initial={false}>
      {open === "keypad" ? (
        <Keypad key="keypad" onHide={close} onEnd={call.hangUp} disabled={ended} />
      ) : (
        <motion.div key="call" {...FADE} className="absolute inset-0 flex flex-col pt-(--safe-top) pb-(--safe-bottom)">
          <CallHeader status={statusLine(call)} ticking={call.phase === "active" && !ended} name={name} detail={detail} saved={saved} />

          <div className="mt-auto">
            {mockVoice && <TypeToTalk onSay={call.say} />}
            <div className={cx(styles.controls, "grid grid-cols-3 justify-items-center")}>
              <Control label="Speaker" glyph={SpeakerIcon} pressed={call.speaker} disabled={ended} onPress={call.toggleSpeaker} />
              <Control label="Messages" glyph={MessageIcon} disabled={ended} onPress={call.showMessages} />
              <Control label="Mute" glyph={MicSlashIcon} pressed={call.muted} disabled={ended} onPress={call.toggleMute} />
              <div className="relative">
                <Control label="More" glyph={EllipsisIcon} expanded={open === "more"} disabled={ended} onPress={() => setSheet("more")} />
                <AnimatePresence>{open === "more" && <MoreMenu onClose={close} />}</AnimatePresence>
              </div>
              <EndButton labeled disabled={ended} onPress={call.hangUp} />
              <Control label="Keypad" glyph={KeypadIcon} disabled={ended} onPress={() => setSheet("keypad")} />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

type ControlProps = { label: string; glyph: Glyph; pressed?: boolean; expanded?: boolean; disabled: boolean; onPress: () => void };

// An iOS 26 in-call button: a Liquid Glass circle over its label, solid white while a toggle is on.
function Control({ label, glyph: Glyph, pressed, expanded, disabled, onPress }: ControlProps) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      className={cx("flex flex-col items-center gap-8 disabled:opacity-40", PRESS)}
    >
      <span className={cx(styles.glass, styles.round, "grid place-items-center rounded-full")}>
        <Glyph className="size-30" />
      </span>
      <span className="text-ios-subhead">{label}</span>
    </button>
  );
}

// What More opens on a real call (hold, add call, FaceTime) has no meaning here, so it says so and gets out of the way.
function MoreMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);

  return (
    <motion.div ref={ref} role="dialog" aria-label="More" tabIndex={-1} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} className="outline-none">
      <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 z-10 cursor-default" />
      <motion.p
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.2, ease: EASE_HOUSE }}
        style={{ originX: 0, originY: 1 }}
        className={cx(styles.menu, styles.popover, "absolute bottom-full left-0 z-20 mb-12 px-18 py-14 text-ios-body")}
      >
        No additional options
      </motion.p>
    </motion.div>
  );
}

// Mock voice only: a stand-in for the mic that also makes every call path scriptable in tests.
function TypeToTalk({ onSay }: { onSay: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="mb-24 w-full px-36"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim()) return;
        onSay(text);
        setText("");
      }}
    >
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Type to talk"
        aria-label="Type to talk"
        autoComplete="off"
        enterKeyHint="send"
        className={cx(styles.field, "h-40 w-full rounded-full bg-on-dark/15 px-16 text-on-dark placeholder:text-on-dark/60")}
      />
    </form>
  );
}
