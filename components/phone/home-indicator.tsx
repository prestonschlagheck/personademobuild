"use client";

import { cx } from "@/components/ios/ui";
import { useCall } from "@/lib/client/call-context";

export function HomeIndicator() {
  const { fullscreen, screen, showMessages } = useCall();
  // Over a live call the bar goes home like iOS does: back to Messages, with the call still on.
  const home = fullscreen && (screen === "active" || screen === "outgoing");
  const bar = cx(
    "pointer-events-none absolute bottom-8 left-1/2 z-40 h-5 w-134 -translate-x-1/2 rounded-full transition-colors duration-140 ease-standard",
    fullscreen ? "bg-on-dark" : "bg-ink",
  );

  if (!home) return <span aria-hidden className={bar} />;
  return (
    <>
      <span aria-hidden className={bar} />
      <button
        type="button"
        aria-label="Go to Messages"
        onClick={showMessages}
        className="absolute bottom-0 left-1/2 z-40 h-34 w-200 -translate-x-1/2 cursor-pointer"
      />
    </>
  );
}
