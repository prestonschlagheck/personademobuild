import { useCallback, useLayoutEffect, useRef, useState } from "react";

// The composer's text plus caret-aware edits, so the on-screen keyboard types exactly where a real one would.
export type ComposerField = ReturnType<typeof useComposerField>;

type Edit = (value: string, start: number, end: number) => [next: string, caret: number];

// iOS capitalizes the first letter of the field and of each new sentence.
export const startsSentence = (text: string) => text.trim() === "" || /[.!?]\s+$/.test(text);

// Backspace removes the whole character before the caret, so a flag, a skin tone or a ZWJ emoji goes in one press.
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const charBefore = (value: string, at: number) => {
  const last = segmenter ? [...segmenter.segment(value.slice(0, at))].at(-1)?.segment : undefined;
  if (last) return last.length;
  // Without Segmenter: a lone low surrogate means an astral character, so delete both halves.
  return at > 1 && /[\uDC00-\uDFFF]/.test(value[at - 1] ?? "") ? 2 : 1;
};

export function useComposerField() {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const caret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || caret.current === null) return;
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  const edit = useCallback((fn: Edit) => {
    const el = ref.current;
    if (!el) return;
    const [next, at] = fn(el.value, el.selectionStart, el.selectionEnd);
    caret.current = at;
    setValue(next);
  }, []);

  const insert = useCallback(
    (text: string) => edit((v, s, e) => [v.slice(0, s) + text + v.slice(e), s + text.length]),
    [edit],
  );

  const backspace = useCallback(
    () =>
      edit((v, s, e) => {
        if (s !== e) return [v.slice(0, s) + v.slice(e), s];
        const from = Math.max(0, s - charBefore(v, s));
        return [v.slice(0, from) + v.slice(s), from];
      }),
    [edit],
  );

  // An autocomplete suggestion replaces the word being typed, then adds a space.
  const complete = useCallback(
    (word: string) =>
      edit((v, s, e) => {
        const from = s - (/\S*$/.exec(v.slice(0, s))?.[0].length ?? 0);
        return [`${v.slice(0, from)}${word} ${v.slice(e)}`, from + word.length + 1];
      }),
    [edit],
  );

  return { ref, value, setValue, insert, backspace, complete };
}
