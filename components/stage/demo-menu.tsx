"use client";

import { motion } from "motion/react";
import { useEffect, useEffectEvent, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cx } from "@/components/ios/ui";
import { CheckIcon } from "./control-bar-icons";
import styles from "./control-bar.module.css";
import { MENU_MOTION } from "./segment";

export function MenuToggle({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} tabIndex={-1} className={cx(styles.item, styles.action)} onClick={onClick}>
      {children}
      {checked && <CheckIcon />}
    </button>
  );
}

export type MenuFocus = "first" | "last";

export type DemoMenuProps = {
  id: string;
  focus: MenuFocus;
  anchor: RefObject<HTMLButtonElement | null>;
  /** The bar's own controls, folded into the menu. */
  children: ReactNode;
  onClose: (restoreFocus: boolean) => void;
};

const ITEM = '[role^="menuitem"], [role="slider"]';

export function DemoMenu({ id, focus, anchor, children, onClose }: DemoMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeOutside = useEffectEvent(() => onClose(false));

  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLElement>(ITEM);
    (focus === "first" ? items?.[0] : items?.[items.length - 1])?.focus();
  }, [focus]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || ref.current?.contains(target) || anchor.current?.contains(target)) return;
      closeOutside();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
    const at = items.findIndex((item) => item === document.activeElement);
    const move = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return move(at + 1);
      case "ArrowUp":
        return move(at - 1);
      case "Home":
        return move(0);
      case "End":
        return move(items.length - 1);
      case "Escape":
        event.preventDefault();
        return onClose(true);
      case "Tab":
        return onClose(false);
    }
  };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={MENU_MOTION}
      className={cx(styles.glass, styles.menu)}
      onKeyDown={onKeyDown}
    >
      <div id={id} role="menu" aria-label="Demo controls">
        {children}
      </div>
    </motion.div>
  );
}
