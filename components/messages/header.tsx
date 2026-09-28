"use client";

import { AnimatePresence, motion } from "motion/react";
import { BackChevronIcon, DisclosureChevronIcon, VideoIcon } from "@/components/ios/icons";
import { cx, PRESS } from "@/components/ios/ui";
import { EASE_HOUSE } from "@/lib/client/motion";
import { Avatar } from "./avatar";
import styles from "./messages.module.css";

type HeaderProps = {
  contact: { saved: boolean; name: string };
  call: { label: string; disabled: boolean; onPress: () => void };
  onDetails: () => void;
};

// iOS 26 Messages header, laid out from Persona's mockup: glass back and call buttons, the avatar with its name pill.
// Until the contact card is saved it shows what iOS would: the bare number and the blank silhouette.
export function Header({ contact, call, onDetails }: HeaderProps) {
  const title = contact.name;
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 pt-(--top-inset)">
      <div className="relative flex h-87 items-start justify-between px-16">
        <span aria-hidden className={cx(styles.glass, styles.sheer, "grid size-44 place-items-center rounded-full text-ink")}>
          <BackChevronIcon className="h-20 w-12.25" />
        </span>

        <button
          type="button"
          onClick={onDetails}
          aria-label={`${title}, contact details`}
          className={cx("pointer-events-auto absolute left-1/2 top-0 flex -translate-x-1/2 flex-col items-center rounded-full", PRESS)}
        >
          <Avatar unknown={!contact.saved} size={60} className={cx(styles.avatarShadow, "relative z-20")} />
          <span
            className={cx(
              styles.glass,
              styles.sheer,
              "relative z-10 -mt-5 flex h-32 items-center gap-7 whitespace-nowrap rounded-full pl-14 pr-11 text-ios-body leading-none font-bold tracking-normal text-ink",
            )}
          >
            <span className="max-w-200 truncate">{title}</span>
            <DisclosureChevronIcon className="h-10 w-5.5 translate-y-1 text-ios-gray-2" />
          </span>
        </button>

        <button
          type="button"
          onClick={call.onPress}
          disabled={call.disabled}
          aria-label={call.label}
          className={cx(styles.glass, styles.sheer, PRESS, "pointer-events-auto grid size-44 place-items-center rounded-full text-ink disabled:opacity-35")}
        >
          <VideoIcon className="size-26" />
        </button>
      </div>
    </header>
  );
}

export function NetworkBanner({ offline }: { offline: boolean }) {
  return (
    <AnimatePresence>
      {offline && (
        <motion.div
          role="status"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.24, ease: EASE_HOUSE }}
          className="pointer-events-none absolute inset-x-0 top-(--header-h) z-20 flex justify-center"
        >
          <span className={cx(styles.glass, "flex h-30 items-center gap-8 rounded-full px-14 text-ios-footnote font-semibold text-ink-soft")}>
            <span className="size-7 animate-pulse-soft rounded-full bg-ios-gray-2" />
            Waiting for network
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
