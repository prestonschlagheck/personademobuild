"use client";

import { AnimatePresence, motion, useDragControls } from "motion/react";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { cx, PRESS } from "@/components/ios/ui";
import { useFocusTrap } from "@/components/ios/use-focus-trap";
import { SHEET } from "@/lib/client/motion";
import { Avatar } from "./avatar";
import styles from "./messages.module.css";

type SheetProps = { open: boolean; onClose: () => void; label: string; children: ReactNode };

// An iOS page sheet inside the phone: rises on the sheet curve, drags down from the grabber to dismiss.
export function Sheet({ open, onClose, label, children }: SheetProps) {
  return <AnimatePresence>{open && <Panel onClose={onClose} label={label}>{children}</Panel>}</AnimatePresence>;
}

function Panel({ onClose, label, children }: Omit<SheetProps, "open">) {
  const panel = useRef<HTMLDivElement>(null);
  const drag = useDragControls();
  useFocusTrap(panel, onClose);

  return (
    <div className="absolute inset-0 z-50">
      <motion.div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-heading/40"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={SHEET}
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        style={{ outline: "none" }}
        className={cx(
          styles.sheet,
          "absolute inset-x-0 bottom-0 top-[calc(var(--top-inset)+var(--pt)*10)] flex flex-col rounded-t-ios-sheet bg-ios-grouped",
        )}
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={SHEET}
        drag="y"
        dragListener={false}
        dragControls={drag}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 1 }}
        onDragEnd={(_, { offset, velocity }) => {
          if (offset.y > 120 || velocity.y > 600) onClose();
        }}
      >
        <div className="flex h-20 shrink-0 cursor-grab touch-none justify-center pt-6" onPointerDown={(e) => drag.start(e)}>
          <span className="h-5 w-36 rounded-full bg-ios-label-3" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-16 pb-40">{children}</div>
      </motion.div>
    </div>
  );
}

export function SheetDone({ onClose }: { onClose: () => void }) {
  return (
    <div className="-mt-4 flex justify-end">
      <button type="button" onClick={onClose} className={cx("h-44 px-4 text-ios-body font-semibold text-ios-blue", PRESS)}>
        Done
      </button>
    </div>
  );
}

export function SheetIdentity({ name, unknown = false }: { name: string; unknown?: boolean }) {
  return (
    <div className="flex flex-col items-center pb-24 text-center">
      <Avatar unknown={unknown} size={96} />
      <h2 className="mt-12 text-ios-title1 font-semibold text-ink">{name}</h2>
      {!unknown && <p className="text-ios-subhead text-ink-soft">Persona</p>}
    </div>
  );
}

export function SheetGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mt-20 first:mt-0">
      {title && <h3 className="px-16 pb-6 text-ios-footnote font-semibold text-ink-soft">{title}</h3>}
      <div className={cx(styles.group, "overflow-hidden rounded-ios-card bg-surface")}>{children}</div>
    </section>
  );
}

export function SheetNote({ children }: { children: ReactNode }) {
  return <p className="px-16 pt-8 text-ios-footnote text-ink-soft">{children}</p>;
}

type SheetActionProps = Omit<ComponentProps<"button">, "type" | "className" | "onClick"> & { onClick: () => void; tone?: "blue" | "red" };

export function SheetAction({ onClick, tone = "blue", children, ...props }: SheetActionProps) {
  return (
    <button
      {...props}
      type="button"
      onClick={onClick}
      className={cx(
        "flex min-h-52 w-full items-center px-16 text-left text-ios-body disabled:opacity-60",
        tone === "red" ? "text-ios-red" : "text-ios-blue",
        PRESS,
      )}
    >
      {children}
    </button>
  );
}
