import { cx, pt } from "@/components/ios/ui";
import type { ReactionType } from "@/lib/session/schema";
import styles from "./bubble.module.css";
import type { Reaction, Side } from "./thread-model";

export const REACTIONS: { type: ReactionType; label: string }[] = [
  { type: "love", label: "Heart" },
  { type: "like", label: "Thumbs up" },
  { type: "dislike", label: "Thumbs down" },
  { type: "laugh", label: "Ha ha" },
  { type: "emphasize", label: "Exclamation marks" },
  { type: "question", label: "Question mark" },
];

// Every tapback is the emoji itself, drawn by the system emoji font: Apple's own art on a Mac or iPhone.
const EMOJI: Record<ReactionType, string> = {
  love: "\u{1FA77}",
  like: "\u{1F44D}",
  dislike: "\u{1F44E}",
  laugh: "\u{1F602}",
  emphasize: "\u203C\uFE0F",
  question: "\u2753",
  check: "\u2705",
  eyes: "\u{1F440}",
};
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

export function TapbackIcon({ type, size }: { type: ReactionType; size: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center leading-none select-none"
      style={{ width: pt(size), height: pt(size), fontSize: pt(size), fontFamily: EMOJI_FONT }}
    >
      {EMOJI[type]}
    </span>
  );
}

// iMessage's tapback, measured from its screenshots: a round badge over the bubble's outer top corner, mostly above
// it, trailing two dots away from the bubble like a thought bubble. Blue when it is yours, gray when the agent's.
// All in points, for a 32 pt badge: each dot's center offset from the badge's center, and its size.
const BADGE = 32;
const DOTS = [
  { dx: 10.9, dy: 13.1, size: 8 },
  { dx: 15.8, dy: 19.9, size: 4 },
];

export function ReactionBadges({ reactions, side }: { reactions: Reaction[]; side: Side }) {
  // On the agent's bubbles the badge sits top right and its dots trail right; on yours, mirrored.
  const out = side === "agent" ? 1 : -1;
  return reactions.map((r, i) => {
    const fill = r.from === "user" ? "bg-ios-blue" : "bg-ios-gray";
    const shapes = [
      { key: "badge", style: { inset: 0 } },
      ...DOTS.map(({ dx, dy, size }, d) => ({
        key: `dot${d}`,
        style: { width: pt(size), height: pt(size), left: pt(BADGE / 2 + out * dx - size / 2), top: pt(BADGE / 2 + dy - size / 2) },
      })),
    ];
    return (
      <span
        key={r.from}
        aria-hidden
        className={cx("pointer-events-none absolute", side === "agent" ? "-right-14" : "-left-14")}
        style={{ top: pt(-25), width: pt(BADGE), height: pt(BADGE), translate: `${pt(-out * i * 16)} 0` }}
      >
        {/* The ring in the thread's color goes around the badge and its dots as one shape, so it is drawn first. */}
        {shapes.map((shape) => (
          <span key={`ring-${shape.key}`} className={cx(styles.badge, fill, "absolute rounded-full")} style={shape.style} />
        ))}
        {shapes.map((shape) => (
          <span key={shape.key} className={cx(fill, "absolute rounded-full")} style={shape.style} />
        ))}
        <span className="absolute inset-0 grid place-items-center">
          <TapbackIcon type={r.type} size={17} />
        </span>
      </span>
    );
  });
}
