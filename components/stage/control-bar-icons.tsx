import { type ReactNode } from "react";
import { cx } from "@/components/ios/ui";
import styles from "./control-bar.module.css";

// The bar's own glyphs, drawn after SF Symbols at regular weight: one 20px grid, a 1.5px line, round ends.
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[18px]" aria-hidden>
      {children}
    </svg>
  );
}

// speaker: a small box and its cone.
const SPEAKER = "M3 8.2c0-.55.45-1 1-1h2.25l3.4-2.85c.43-.36 1.1-.05 1.1.5v10.3c0 .55-.67.86-1.1.5l-3.4-2.85H4a1 1 0 0 1-1-1V8.2Z";

// speaker.wave.2
export function SoundOnIcon() {
  return (
    <Glyph>
      <path d={SPEAKER} />
      <path d="M13.3 7.6a3.4 3.4 0 0 1 0 4.8M15.6 5.3a6.6 6.6 0 0 1 0 9.4" />
    </Glyph>
  );
}

// speaker.slash
export function SoundOffIcon() {
  return (
    <Glyph>
      <path d={SPEAKER} />
      <path d="m3.5 3.5 13 13" />
    </Glyph>
  );
}

export function BellIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="size-[15px]" aria-hidden>
      <path d="M5.2 13.8V9.2a4.8 4.8 0 0 1 9.6 0v4.6l1.2 1.5H4l1.2-1.5Z" />
      <path d="M8.3 17.2a1.9 1.9 0 0 0 3.4 0" />
    </svg>
  );
}

export function CallIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="size-[15px]" aria-hidden>
      <path d="M6.6 3.5 8 6.9a1 1 0 0 1-.3 1.2L6.4 9.2a8.4 8.4 0 0 0 4.4 4.4l1.1-1.3a1 1 0 0 1 1.2-.3l3.4 1.4a1 1 0 0 1 .6 1.1l-.3 1.7a1.6 1.6 0 0 1-1.7 1.3C8.7 17 3 11.3 2.5 4.9a1.6 1.6 0 0 1 1.3-1.7l1.7-.3a1 1 0 0 1 1.1.6Z" />
    </svg>
  );
}

// list.bullet.rectangle: the session, line by line.
export function LogsIcon() {
  return (
    <Glyph>
      <rect x="2.5" y="3.5" width="15" height="13" rx="3" />
      <path d="M9 7.75h5M9 10h5M9 12.25h5" />
      <path d="M6.25 7.75h.01M6.25 10h.01M6.25 12.25h.01" strokeWidth="1.9" />
    </Glyph>
  );
}

// arrow.uturn.backward: back to the start.
export function RestartIcon() {
  return (
    <Glyph>
      <path d="M7.25 4 3.75 7.5 7.25 11" />
      <path d="M3.75 7.5h7.5a4.75 4.75 0 0 1 0 9.5H9.5" />
    </Glyph>
  );
}

// checkmark: the press that erases.
export function ConfirmIcon() {
  return (
    <Glyph>
      <path d="m4.75 10.4 3.4 3.35 7.1-7.5" />
    </Glyph>
  );
}

export function ChevronIcon({ large }: { large?: boolean }) {
  return (
    <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cx(styles.chevron, large && styles.chevronLarge)} aria-hidden>
      <path d="m2.5 3.75 2.5 2.5 2.5-2.5" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={styles.check} aria-hidden>
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}
