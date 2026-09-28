import type { ReactNode } from "react";
import { LocationIcon } from "@/components/ios/icons";
import { cx } from "@/components/ios/ui";
import { clockTime, formatDuration } from "@/lib/client/format";
import styles from "./bubble.module.css";
import type { RowItem } from "./thread-model";
import { stamp } from "./time";

// "iMessage / Today 9:41 PM" above the first message, then "Today 10:02 PM" between distant groups.
export function TimeRow({ at, first, now }: { at: string; first: boolean; now: number }) {
  const { day, time } = stamp(at, now);
  return (
    <p className="pb-4 pt-12 text-center text-ios-caption1 text-ink-soft">
      {first && <span className="block font-semibold">iMessage</span>}
      <span className="font-semibold">{day}</span> {time}
    </p>
  );
}

export function SystemRow({ children }: { children: ReactNode }) {
  return <p className="px-32 pb-2 pt-10 text-center text-ios-footnote text-balance text-ink-soft">{children}</p>;
}

// A call the mic stopped says which mic problem it was, since each has its own fix.
const MIC_DETAIL = new Map([
  ["mic_denied", "Mic blocked"],
  ["mic_missing", "No mic found"],
  ["mic_busy", "Mic in use"],
]);

export function callSummary(row: RowItem) {
  const { event } = row;
  switch (row.kind) {
    case "call_ended": {
      const seconds = event.meta?.callSeconds ?? 0;
      if (seconds > 0) return { title: "Audio call", detail: formatDuration(seconds) };
      return { title: "Call ended", detail: MIC_DETAIL.get(event.content) ?? clockTime(event.at) };
    }
    case "missed_call":
      return { title: "Missed call", detail: clockTime(event.at) };
    case "call_declined":
      return { title: "Call declined", detail: clockTime(event.at) };
    default:
      return null;
  }
}

// A call gets one quiet caption line, set like the timestamps: no capsule, nothing to tap.
export function CallRow({ row }: { row: RowItem }) {
  const summary = callSummary(row);
  if (!summary) return null;
  return (
    <p className={cx("pb-4 pt-12 text-center text-ios-caption1 text-ink-soft", row.fresh && styles.fade)}>
      <span className="font-semibold">{summary.title}</span> {summary.detail}
    </p>
  );
}

// Under a sent location, Messages stamps when sharing began and with whom.
export function LocationStartedRow({ row, sender, now }: { row: RowItem; sender: string; now: number }) {
  const { day, time } = stamp(row.at, now);
  return (
    <p className={cx("pb-4 pt-12 text-center text-ios-caption1 text-ink-soft", row.fresh && styles.fade)}>
      <span className="block">
        <span className="font-semibold">{day}</span> {time}
      </span>
      <span className="inline-flex items-center gap-4">
        <LocationIcon className="size-11" />
        You started sharing location with {sender}.
      </span>
    </p>
  );
}
