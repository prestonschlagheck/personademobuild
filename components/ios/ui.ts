// Inside the phone every length is an iOS point. `--pt` comes from `.ios` in globals.css.
export const pt = (n: number) => `calc(var(--pt) * ${n})`;

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

/** iOS press feedback for every tappable surface in the phone: a quick opacity change, never a bounce. */
export const PRESS = "transition-opacity duration-120 active:opacity-60";

/** The same press for elements whose opacity motion animates, where an inline style would override the class. */
export const MOTION_PRESS = { opacity: 0.6, transition: { duration: 0.12 } } as const;
