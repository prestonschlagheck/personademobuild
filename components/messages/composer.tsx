"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { SendArrowIcon } from "@/components/ios/icons";
import { cx, PRESS } from "@/components/ios/ui";
import { MAX_TEXT } from "@/lib/api/contract";
import { EASE_HOUSE } from "@/lib/client/motion";
import { StagedLocationCard } from "./attachments";
import { BubbleView } from "./bubble";
import { AudioButton, PlusMenu, RecordingStrip } from "./composer-controls";
import { DesktopKeyboard } from "./keyboard";
import type { KeyAction } from "./keyboard-layout";
import styles from "./messages.module.css";
import type { BubbleItem } from "./thread-model";
import { startsSentence, useComposerField } from "./use-composer-field";
import { useDictation } from "./use-dictation";
import { useVoiceMemo } from "./use-voice-memo";

type ComposerAreaProps = {
  chromeRef: Ref<HTMLDivElement>;
  placeholder: string;
  prefill: { sessionId: string; text: string } | null;
  /** The desktop keyboard. `wake` brings it up from rest: the person typed, or pressed the field. */
  keyboard: { enabled: boolean; open: boolean; wake: () => void };
  micAllowed: boolean;
  /** Reply from the message menu: the message waits above the field, and Escape backs out. */
  replying: { item: BubbleItem; onCancel: () => void } | null;
  /** Share My Location, offered in the plus menu while the agent's request for it is open. */
  onShareLocation: (() => void) | null;
  /** A location waiting in the field for Send, with an optional comment that goes after it. */
  staged: {
    device: string;
    onRemove: () => void;
    onSend: (comment: string) => void;
  } | null;
  onSubmit: (text: string) => boolean;
  onFocusChange: (focused: boolean) => void;
};

// Sized to its text, up to five lines, after which the field scrolls.
function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// Everything at the bottom of the screen: the iOS 26 glass composer and the desktop keyboard.
// Typing state lives here so keystrokes never re-render the thread.
export function ComposerArea({
  chromeRef,
  placeholder,
  prefill,
  keyboard,
  micAllowed,
  replying,
  onShareLocation,
  staged,
  onSubmit,
  onFocusChange,
}: ComposerAreaProps) {
  const field = useComposerField();
  const dictation = useDictation(field);
  const memo = useVoiceMemo((text) => void onSubmit(text));
  const { ref, value, setValue } = field;
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);

  // A call takes the mic: dictation or a memo already running stops, so the two never fight over it.
  const { cancel: cancelDictation } = dictation;
  const { cancel: cancelMemo } = memo;
  useEffect(() => {
    if (micAllowed) return;
    cancelDictation();
    cancelMemo();
  }, [micAllowed, cancelDictation, cancelMemo]);

  // Every fresh conversation starts the way Persona's text link does: the first message already typed. That
  // includes one after Restart, which is a new session; anything they typed themselves stays.
  if (prefill && prefilledFor !== prefill.sessionId) {
    setPrefilledFor(prefill.sessionId);
    if (!value) setValue(prefill.text);
  }

  useEffect(() => {
    if (prefilledFor && keyboard.enabled) ref.current?.focus({ preventScroll: true });
  }, [prefilledFor, keyboard.enabled, ref]);

  const replyKey = replying?.item.key;
  useEffect(() => {
    if (replyKey) ref.current?.focus({ preventScroll: true });
  }, [replyKey, ref]);

  const pointerDown = useRef(false);
  useEffect(() => {
    const down = () => (pointerDown.current = true);
    const up = () => (pointerDown.current = false);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
    };
  }, []);

  // A tap elsewhere blurs the field on pointerdown. Closing the keyboard right then would move the tapped
  // bubble or card before the click lands, so the close waits until the click has gone through.
  const onBlur = () => {
    const close = () => {
      if (document.activeElement !== ref.current) onFocusChange(false);
    };
    if (!pointerDown.current) return close();
    window.addEventListener("pointerup", () => setTimeout(close), {
      once: true,
    });
  };

  useLayoutEffect(() => {
    if (ref.current) fitHeight(ref.current);
  }, [value, ref]);

  // The device rescales with the window, which changes the field's width and its line height together.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth === width) return;
      width = el.offsetWidth;
      fitHeight(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  const submit = () => {
    dictation.cancel();
    if (staged) staged.onSend(value);
    else if (!onSubmit(value)) return;
    setValue("");
  };

  const onKey = (action: KeyAction) => {
    keyboard.wake();
    switch (action.kind) {
      case "char":
        return field.insert(action.char);
      case "word":
        return field.complete(action.word);
      case "space":
        return field.insert(" ");
      case "delete":
        return field.backspace();
      case "return":
        return submit();
      case "mic":
        return micAllowed && dictation.supported ? dictation.toggle() : undefined;
      // The keyboard handles shift and the emoji key itself; the 123 key has no layout behind it yet.
      case "shift":
      case "switch":
      case "emoji":
        return;
      default: {
        const unknown: never = action;
        return unknown;
      }
    }
  };

  const hasText = value.trim().length > 0 || staged !== null;
  const canRecord = micAllowed && memo.supported;
  const tapRecording = memo.recording?.mode === "tap";

  return (
    <>
      <div ref={chromeRef} data-lifted={keyboard.open || undefined} className={cx(styles.chrome, "absolute inset-x-0 bottom-0 z-20")}>
        <AnimatePresence initial={false}>
          {replying && (
            <motion.div
              key={replying.item.key}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              transition={{ duration: 0.25, ease: EASE_HOUSE }}
              className={cx("flex px-16 pb-12", replying.item.side === "user" ? "justify-end" : "justify-start")}
            >
              <BubbleView side={replying.item.side} tail reactions={replying.item.reactions} className="max-w-[75%]">
                {replying.item.text}
              </BubbleView>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="relative flex items-end gap-12 px-16 pt-4">
          <PlusMenu onAudio={canRecord ? () => memo.start("tap") : null} onLocation={onShareLocation} />
          <div
            className={cx(
              styles.glass,
              styles.sheer,
              "flex min-h-40 min-w-0 flex-1 cursor-text flex-col justify-end py-9 pl-18 pr-10",
              staged ? "rounded-[calc(var(--pt)*22)] pt-6" : "rounded-ios-bubble",
            )}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget || e.target === e.currentTarget.lastElementChild) {
                e.preventDefault();
                ref.current?.focus();
                keyboard.wake();
              }
            }}
          >
            {staged && (
              <div className="-ml-12 -mr-4 mb-9 border-b border-ios-separator pb-6">
                <StagedLocationCard device={staged.device} onRemove={staged.onRemove} />
              </div>
            )}
            {/* The field and its button keep their own row, so a staged card above never squeezes them. */}
            <div className="flex min-w-0 items-end">
              <RecordingStrip memo={memo} />
              <textarea
                ref={ref}
                hidden={memo.recording !== null}
                rows={1}
                value={value}
                // A paste stops at what one message may carry, rather than failing to send at all.
                maxLength={MAX_TEXT}
                onChange={(e) => {
                  setValue(e.target.value);
                  keyboard.wake();
                }}
                onPointerDown={keyboard.wake}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && replying) {
                    e.preventDefault();
                    replying.onCancel();
                  } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
                onFocus={() => onFocusChange(true)}
                onBlur={onBlur}
                placeholder={staged ? "Add comment or Send" : placeholder}
                aria-label="Message"
                enterKeyHint="send"
                autoComplete="off"
                className={cx(
                  styles.input,
                  "block max-h-110 min-w-0 flex-1 resize-none bg-transparent text-ios-body text-ink [scrollbar-width:none] placeholder:text-ios-label-2",
                )}
                // The caret is the focus cue, as on iOS.
                style={{ outline: "none" }}
              />
              <span className="-my-4 -mr-5 ml-6 grid size-30 shrink-0 place-items-center">
                <AnimatePresence initial={false} mode="popLayout">
                  {tapRecording || (hasText && !memo.recording) ? (
                    <motion.button
                      key="send"
                      type="button"
                      aria-label={tapRecording ? "Send audio message" : "Send"}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={tapRecording ? memo.finish : submit}
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }}
                      transition={{ duration: 0.2, ease: EASE_HOUSE }}
                      className={cx("grid size-30 place-items-center rounded-full bg-ios-blue text-surface", PRESS)}
                    >
                      <SendArrowIcon className="size-18" />
                    </motion.button>
                  ) : (
                    canRecord && (
                      <motion.span
                        key="audio"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                      >
                        <AudioButton memo={memo} />
                      </motion.span>
                    )
                  )}
                </AnimatePresence>
              </span>
            </div>
          </div>
        </div>
      </div>
      {keyboard.enabled && <DesktopKeyboard open={keyboard.open} caps={startsSentence(value)} listening={dictation.listening} onKey={onKey} />}
    </>
  );
}
