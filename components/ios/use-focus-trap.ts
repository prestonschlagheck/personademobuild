import { useEffect, useEffectEvent, type RefObject } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Modal surfaces inside the phone keep focus to themselves, close on Escape when they can, and hand focus
// back on close. The surface itself takes focus first, so opening with a tap shows no focus ring; Tab then
// walks its controls.
export function useFocusTrap(ref: RefObject<HTMLElement | null>, onEscape?: () => void) {
  const escape = useEffectEvent(() => onEscape?.());
  const escapable = Boolean(onEscape);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.focus({ preventScroll: true });

    // On the document, because a control that unmounts (a confirmed action) drops focus to the body.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && escapable) {
        e.preventDefault();
        escape();
        return;
      }
      if (e.key !== "Tab") return;
      const list = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = list[0];
      const last = list.at(-1);
      if (!first || !last) return;
      const current = document.activeElement;
      const inside = current instanceof Node && root.contains(current) && current !== root;
      if (!inside || (e.shiftKey ? current === first : current === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, [ref, escapable]);
}
