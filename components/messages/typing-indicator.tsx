import { motion } from "motion/react";
import { EASE_HOUSE } from "@/lib/client/motion";

const DOT_DELAYS = ["0s", "0.15s", "0.3s"];

// The iOS typing bubble: Persona's ob-typing dots in a gray pill with the two-circle thought tail.
export function TypingIndicator() {
  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.15 } }}
      transition={{ duration: 0.3, ease: EASE_HOUSE }}
      className="relative mt-8 flex h-39 w-fit origin-bottom-left items-center gap-4 rounded-full bg-ios-gray px-14"
    >
      {DOT_DELAYS.map((delay) => (
        <span key={delay} className="size-7 animate-typing rounded-full bg-ios-gray-2" style={{ animationDelay: delay }} />
      ))}
      <span className="absolute -bottom-1 -left-1 size-12 rounded-full bg-ios-gray" />
      <span className="absolute -bottom-5 -left-5 size-6 rounded-full bg-ios-gray" />
    </motion.div>
  );
}
