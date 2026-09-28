"use client";

import { useSyncExternalStore } from "react";
import { StatusBarIcons } from "@/components/ios/icons";
import { cx } from "@/components/ios/ui";
import { useCall } from "@/lib/client/call-context";

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

// iOS drops the AM/PM marker from the status bar but keeps the visitor's 12 or 24 hour setting.
function readClock() {
  const parts = clockFormat.formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("hour")}:${part("minute")}`;
}

function subscribeClock(onChange: () => void) {
  const untilNextMinute = () => 60_000 - (Date.now() % 60_000);
  let timer = setTimeout(function tick() {
    onChange();
    timer = setTimeout(tick, untilNextMinute());
  }, untilNextMinute());
  // Background tabs throttle timers, so catch up as soon as the tab is visible again.
  document.addEventListener("visibilitychange", onChange);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onChange);
  };
}

export function StatusBar() {
  const { fullscreen, island } = useCall();
  // Empty on the server: only the browser knows the visitor's time and time zone.
  const time = useSyncExternalStore(subscribeClock, readClock, () => "");

  return (
    <div
      aria-hidden
      className={cx(
        "pointer-events-none absolute inset-x-0 top-0 z-40 h-62 transition-colors duration-140 ease-standard",
        fullscreen ? "text-on-dark" : "text-ink",
      )}
    >
      {/* Shares the glyphs' 402 x 22 frame, so the clock sits exactly where iOS draws it. */}
      <svg viewBox="0 0 402 22" fill="currentColor" className="absolute inset-x-0 top-18.5 h-22 w-full">
        <text x="74" y="17" textAnchor="middle" fontSize="17" fontWeight="590" letterSpacing="-0.4">
          {time}
        </text>
      </svg>
      {/* A live activity widens the island over the cellular and Wi-Fi glyphs, so iOS keeps only the battery. */}
      <StatusBarIcons className={cx("absolute inset-x-0 top-18.5 h-22 w-full", island && "[clip-path:inset(0_0_0_84%)]")} />
    </div>
  );
}
