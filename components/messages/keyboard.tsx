"use client";

import { useEffect, useEffectEvent, useRef, useState, type PointerEvent } from "react";
import { cx, pt } from "@/components/ios/ui";
import { DEFAULT_RECENTS, EmojiPanel, withRecent } from "./emoji-panel";
import { KEYS, keyIdFor, type KeyAction, type KeyDef } from "./keyboard-layout";
import styles from "./keyboard.module.css";

const HIT_X = 3;
const HIT_Y = 5.5;
const MIN_LIT_MS = 90;
const REPEAT_DELAY_MS = 450;
const REPEAT_MS = 70;

const KEY_BY_ID = new Map(KEYS.map((k) => [k.id, k]));
const SHIFT = KEY_BY_ID.get("shift");
const DELETE = KEY_BY_ID.get("delete");
const MIC = KEY_BY_ID.get("mic");

const rect = (k: KeyDef) => ({ left: pt(k.x), top: pt(k.y), width: pt(k.w), height: pt(k.h) });

type KeyboardProps = { open: boolean; caps: boolean; listening: boolean; onKey: (action: KeyAction) => void };

// The desktop stand-in for the iPhone keyboard. Clicks type into the composer; real typing lights the drawn keys.
// The emoji key swaps the letters for the emoji keyboard, and the mic key dictates.
export function DesktopKeyboard({ open, caps, listening, onKey }: KeyboardProps) {
  const [lit, setLit] = useState<{ id: string; label?: string } | null>(null);
  const [shift, setShift] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [recents, setRecents] = useState(DEFAULT_RECENTS);
  const litAt = useRef(0);
  const release = useRef<ReturnType<typeof setTimeout>>(undefined);
  const repeat = useRef<ReturnType<typeof setTimeout>>(undefined);
  const upper = shift || caps;

  const light = (id: string, label?: string) => {
    clearTimeout(release.current);
    litAt.current = performance.now();
    setLit({ id, label });
  };

  // A tap is quicker than a frame or two, so every press stays visible for a moment, like the iOS key popup.
  const unlight = () => {
    clearTimeout(repeat.current);
    release.current = setTimeout(() => setLit(null), Math.max(0, MIN_LIT_MS - (performance.now() - litAt.current)));
  };

  // Typing on a real keyboard brings the letters back, so the key it lights is on screen.
  const onPhysicalDown = useEffectEvent((e: KeyboardEvent) => {
    const id = keyIdFor(e);
    if (!id) return;
    setEmoji(false);
    light(id, e.key.length === 1 ? e.key : undefined);
  });
  const onPhysicalUp = useEffectEvent(unlight);

  useEffect(() => {
    if (!open) return;
    const down = (e: KeyboardEvent) => onPhysicalDown(e);
    const up = () => onPhysicalUp();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [open]);

  useEffect(
    () => () => {
      clearTimeout(release.current);
      clearTimeout(repeat.current);
    },
    [],
  );

  const pressKey = (k: KeyDef) => {
    const { action } = k;
    if (action.kind === "char") {
      const char = upper ? action.char.toUpperCase() : action.char;
      light(k.id, char);
      setShift(false);
      onKey({ kind: "char", char });
      return;
    }
    light(k.id);
    if (action.kind === "shift") return setShift((s) => !s);
    if (action.kind === "emoji") return setEmoji((on) => !on);
    onKey(action);
    if (action.kind === "delete") {
      repeat.current = setTimeout(function again() {
        onKey(action);
        repeat.current = setTimeout(again, REPEAT_MS);
      }, REPEAT_DELAY_MS);
    }
  };

  const press = (k: KeyDef) => (e: PointerEvent) => {
    if (e.button === 0) pressKey(k);
  };

  const pickEmoji = (char: string) => {
    setRecents((list) => withRecent(list, char));
    onKey({ kind: "char", char });
  };

  const litKey = lit && KEY_BY_ID.get(lit.id);

  return (
    // Blocked from session replay: the key popup's position alone would spell out what was typed.
    <div
      aria-hidden
      data-ph-block
      data-open={open || undefined}
      onMouseDown={(e) => e.preventDefault()}
      className={cx(styles.keyboard, "absolute inset-x-0 bottom-0 z-30 bg-ios-keyboard select-none")}
    >
      <div className={styles.art} />
      {upper && SHIFT && <ShiftOn k={SHIFT} />}
      {KEYS.map((k) => (
        <div
          key={k.id}
          className="absolute"
          style={{ left: pt(k.x - HIT_X), top: pt(k.y - HIT_Y), width: pt(k.w + HIT_X * 2), height: pt(k.h + HIT_Y * 2) }}
          onPointerDown={press(k)}
          onPointerUp={unlight}
          onPointerLeave={lit?.id === k.id ? unlight : undefined}
          onPointerCancel={unlight}
        />
      ))}
      {listening && MIC && <span className="pointer-events-none absolute animate-pulse-soft rounded-full bg-ink/12" style={rect(MIC)} />}
      {emoji && DELETE && (
        <EmojiPanel
          recents={recents}
          onPick={pickEmoji}
          onDeleteDown={() => pressKey(DELETE)}
          onDeleteUp={unlight}
          onLetters={() => setEmoji(false)}
        />
      )}
      {litKey &&
        !(emoji && litKey.action.kind !== "emoji" && litKey.action.kind !== "mic") &&
        (litKey.action.kind === "char" ? (
          <KeyPopup k={litKey} label={lit.label ?? (upper ? litKey.id.toUpperCase() : litKey.id)} />
        ) : (
          <span className="pointer-events-none absolute rounded-[calc(var(--pt)*9)] bg-ink/12" style={rect(litKey)} />
        ))}
    </div>
  );
}

// iOS shows an active shift as a white key with a filled arrow.
function ShiftOn({ k }: { k: KeyDef }) {
  return (
    <span className="pointer-events-none absolute grid place-items-center rounded-[calc(var(--pt)*9)] bg-surface text-ink" style={rect(k)}>
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-20">
        <path d="M12 3.5 2.5 13H8v7.5h8V13h5.5L12 3.5Z" />
      </svg>
    </span>
  );
}

// The balloon that rises from a letter key while it is held.
function KeyPopup({ k, label }: { k: KeyDef; label: string }) {
  const width = k.w + 14;
  const left = Math.min(Math.max(k.x - 7, 2), 400 - width);
  return (
    <span className={styles.popup} style={{ left: pt(left), top: pt(k.y - 54), width: pt(width) }}>
      <span className="grid h-56 place-items-center rounded-[calc(var(--pt)*11)] bg-surface text-ink" style={{ fontSize: pt(32) }}>
        {label}
      </span>
      <span
        className="-mt-4 block rounded-b-[calc(var(--pt)*9)] bg-surface"
        style={{ marginLeft: pt(k.x - left), width: pt(k.w), height: pt(k.h + 2) }}
      />
    </span>
  );
}
