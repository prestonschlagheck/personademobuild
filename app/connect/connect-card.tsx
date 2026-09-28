import type { ReactNode } from "react";
import { cx } from "@/components/ios/ui";

// The frame for the sign-in stand-in and the return page, in Persona's dashboard style: a white card on
// the page background.

export const pill =
  "inline-flex h-11 items-center justify-center rounded-full px-6 text-[15px] font-semibold tracking-[-0.2px] transition-[opacity,background-color] duration-[140ms] ease-(--ease-standard)";

export const primaryPill = `${pill} bg-accent text-surface active:opacity-75`;
export const secondaryPill = `${pill} border border-button-border bg-surface text-ink hover:bg-sunken active:bg-tile`;

type ConnectCardProps = {
  title: string;
  /** A status glyph over the title. A card with one is a result, so it centers like Persona's return page. */
  icon?: ReactNode;
  /** Sits under the card, outside it. */
  footer?: ReactNode;
  children: ReactNode;
};

export function ConnectCard({ title, icon, footer, children }: ConnectCardProps) {
  const result = icon !== undefined;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-page px-4 py-10">
      <section
        className={cx(
          "w-full max-w-[440px] rounded-lg border border-hairline bg-surface p-6 sm:p-8",
          result && "flex flex-col items-center text-center",
        )}
      >
        {icon}
        <h1
          className={cx(
            "font-serif text-[28px] leading-[1.1] tracking-[-0.4px] text-balance text-heading sm:text-[32px]",
            result && "mt-5",
          )}
        >
          {title}
        </h1>
        {children}
      </section>
      {footer}
    </main>
  );
}
