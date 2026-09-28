"use client";

import { useState, type ReactNode } from "react";
import { cx } from "@/components/ios/ui";
import styles from "./xray.module.css";

// Building blocks for the state panel, in Persona's dashboard style: serif section headings,
// hairline rows, right-aligned meta, no color beyond a status dot.

type Watched = string | number | boolean | null | undefined;

function useChangeCount(value: Watched) {
  const [previous, setPrevious] = useState(value);
  const [count, setCount] = useState(0);
  if (previous !== value) {
    setPrevious(value);
    setCount(count + 1);
  }
  return count;
}

/** Tints its row briefly each time `watch` changes, never on first render. */
function Flash({ watch }: { watch: Watched }) {
  const changes = useChangeCount(watch);
  return changes > 0 ? <span key={changes} aria-hidden className={styles.flash} /> : null;
}

export function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="pt-6 first:pt-4">
      <header className="flex items-baseline justify-between gap-3 pb-2">
        <h2 className="font-serif text-[24px] leading-7 tracking-[-0.3px] text-heading">{title}</h2>
        {meta !== undefined && <p className="text-[13px] text-ink-soft tabular-nums">{meta}</p>}
      </header>
      {children}
    </section>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <dl className="border-t border-hairline">{children}</dl>;
}

type RowProps = {
  label: string;
  value: ReactNode;
  /** Shown muted when there is no value. */
  empty?: string;
  /** The value to watch for the change highlight. Defaults to `value` when it is a string; null opts out. */
  watch?: Watched;
  /** User data: masked in session replay. */
  mask?: boolean;
  /** A step of the onboarding: its pill at the right, checked once it is done. */
  done?: boolean;
};

export function Row({ label, value, empty = "None", watch = typeof value === "string" ? value : null, mask = false, done }: RowProps) {
  const hasValue = value !== null && value !== undefined && value !== false && value !== "";
  const step = done !== undefined;
  return (
    <div
      className={cx(
        "relative isolate grid grid-cols-[var(--label-width)_minmax(0,1fr)_var(--pill-width)] gap-x-3 border-b border-hairline py-[7px] text-[14px] leading-5",
        step ? "items-center" : "items-baseline",
      )}
    >
      <Flash watch={watch} />
      <dt className="text-secondary">{label}</dt>
      <dd className={cx("min-w-0 break-words", !step && "col-span-2")} data-ph-mask={mask || undefined}>
        {hasValue ? <span className="font-medium text-ink">{value}</span> : <span className="text-ink-soft">{empty}</span>}
      </dd>
      {step && (
        <dd>
          <StepPill done={done} />
        </dd>
      )}
    </div>
  );
}

// A pill as a status: black with a check once the step is done, dimmed with a cross until then.
function StepPill({ done }: { done: boolean }) {
  return (
    <span className={cx(styles.step, done && styles.stepDone)}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={done ? "m3.5 8.5 3 3 6-7" : "m5 5 6 6m0-6-6 6"} />
      </svg>
      <span className="sr-only">{done ? "Done" : "Not yet"}</span>
    </span>
  );
}
