"use client";

import { useEffect, useState, type ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cx, PRESS } from "@/components/ios/ui";
import { useCall } from "@/lib/client/call-context";
import { EASE_HOUSE } from "@/lib/client/motion";
import { useOnboarding } from "@/lib/client/onboarding";
import { sounds } from "@/lib/client/sounds";
import styles from "./call.module.css";
import { ClockIcon, MessageIcon, PhoneDownIcon, PhoneIcon } from "@/components/ios/icons";
import { CallHeader } from "./call-header";
import { useCaller } from "./use-caller";

// Each canned reply declines the ring and continues the setup over text.
const REPLIES = ["Can't talk right now.", "Can you text me instead?", "Call me in 10 minutes."];

type Glyph = ComponentType<{ className?: string }>;

// iOS 26 incoming call, full screen: the caller top left as on the call itself, Remind Me and Message, then Decline and Accept.
export function IncomingCall() {
  const { accept, decline } = useCall();
  const { send } = useOnboarding();
  const caller = useCaller();
  const [replying, setReplying] = useState(false);

  useEffect(() => {
    sounds.startRing();
    return () => sounds.stopRing();
  }, []);

  const reply = (text: string) => {
    decline("message");
    send(text);
  };

  return (
    <div className="absolute inset-0 flex flex-col pt-(--safe-top) pb-(--safe-bottom)">
      <CallHeader status="Persona Audio" name={caller.name} detail={caller.maybe && `maybe: ${caller.maybe}`} saved={caller.saved} />

      <div className="relative mt-auto mb-44 flex flex-col gap-44">
        <div className="flex justify-between px-50">
          <SmallAction label="Remind Me" glyph={ClockIcon} onPress={() => decline("remind_later")} />
          <SmallAction label="Message" glyph={MessageIcon} expanded={replying} onPress={() => setReplying(true)} />
        </div>
        <div className="flex justify-between px-50">
          <RoundAction label="Decline" glyph={PhoneDownIcon} tone="bg-ios-red" onPress={() => decline("decline")} />
          <RoundAction label="Accept" glyph={PhoneIcon} tone="bg-ios-green" onPress={accept} />
        </div>

        <AnimatePresence>{replying && <ReplyMenu onPick={reply} onClose={() => setReplying(false)} />}</AnimatePresence>
      </div>
    </div>
  );
}

function SmallAction({ label, glyph: Glyph, expanded, onPress }: { label: string; glyph: Glyph; expanded?: boolean; onPress: () => void }) {
  return (
    <button type="button" onClick={onPress} aria-expanded={expanded} className={cx("flex w-76 flex-col items-center gap-8", PRESS)}>
      <span className={cx(styles.glass, "grid size-48 place-items-center rounded-full")}>
        <Glyph className="size-24" />
      </span>
      <span className="text-ios-footnote">{label}</span>
    </button>
  );
}

function RoundAction({ label, glyph: Glyph, tone, onPress }: { label: string; glyph: Glyph; tone: string; onPress: () => void }) {
  return (
    <button type="button" onClick={onPress} className={cx("flex w-76 flex-col items-center gap-8", PRESS)}>
      <span className={cx("grid size-76 place-items-center rounded-full text-on-dark", tone)}>
        <Glyph className="size-38" />
      </span>
      <span className="text-ios-subhead">{label}</span>
    </button>
  );
}

function ReplyMenu({ onPick, onClose }: { onPick: (text: string) => void; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <>
      <button type="button" aria-label="Close replies" onClick={onClose} className="fixed inset-0 cursor-default" tabIndex={-1} />
      <motion.div
        role="menu"
        aria-label="Reply with a message"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.22, ease: EASE_HOUSE }}
        style={{ originX: 1, originY: 1 }}
        className={cx(styles.menu, styles.glass, "absolute right-24 bottom-full mb-12 overflow-hidden")}
      >
        {REPLIES.map((text) => (
          <button
            key={text}
            type="button"
            role="menuitem"
            onClick={() => onPick(text)}
            className="block h-48 w-full border-b border-on-dark/15 px-18 text-left text-ios-body last:border-b-0 transition-colors duration-120 active:bg-on-dark/15"
          >
            {text}
          </button>
        ))}
      </motion.div>
    </>
  );
}
