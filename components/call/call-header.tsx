import { PersonaMark } from "@/components/brand/persona-logo";
import { cx } from "@/components/ios/ui";
import styles from "./call.module.css";

type CallHeaderProps = {
  /** The small line over the name: "Calling mobile…", the running timer, "Call Ended". Left out entirely for an unsaved number, as iOS has nothing to label. */
  status?: string;
  /** A ticking timer is left out of the live region, which would otherwise announce every second. */
  ticking?: boolean;
  name: string;
  detail?: string | null;
  /** Whether this caller has a saved contact card. Unsaved shows the bare number, no photo, no status line, on one line. */
  saved?: boolean;
};

// iOS 26 names the caller top left: its photo (Persona's mark), then a quiet status line over the name in
// large bold. Without a saved contact, iOS has no card to draw from, so it centers the bare number instead,
// a little further down the screen, with no photo and no status line.
export function CallHeader({ status, ticking = false, name, detail, saved = true }: CallHeaderProps) {
  if (!saved) {
    return (
      <header className={cx(styles.headerUnsaved, "flex flex-col items-center text-center")}>
        <h2 className={cx(styles.name, "whitespace-nowrap")}>{name}</h2>
        {detail && <p className="text-ios-footnote text-on-dark/75">{detail}</p>}
      </header>
    );
  }

  return (
    <header className={cx(styles.header, "flex items-center")}>
      <span aria-hidden className={cx(styles.avatar, "grid shrink-0 place-items-center rounded-full bg-on-dark text-accent")}>
        <PersonaMark className="h-[46%] w-auto overflow-visible" />
      </span>
      <div className="min-w-0">
        {status && (
          <p role={ticking ? undefined : "status"} className="text-ios-subhead tabular-nums text-on-dark/75">
            {status}
          </p>
        )}
        <h2 className={cx(styles.name, "line-clamp-2 break-words")}>{name}</h2>
        {detail && <p className="text-ios-footnote text-on-dark/75">{detail}</p>}
      </div>
    </header>
  );
}
