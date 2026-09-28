import { clockTime } from "@/lib/client/format";

const weekdayFormat = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const dateFormat = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

const DAY_MS = 86_400_000;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// iOS thread stamps: "Today 9:41 PM", "Yesterday 9:41 PM", "Friday 9:41 PM", then "Sat, Sep 20 at 9:41 PM".
export function stamp(iso: string, now: number) {
  const date = new Date(iso);
  const days = Math.round((midnight(new Date(now)) - midnight(date)) / DAY_MS);
  const time = clockTime(iso);
  if (days <= 0) return { day: "Today", time };
  if (days === 1) return { day: "Yesterday", time };
  if (days < 7) return { day: weekdayFormat.format(date), time };
  return { day: dateFormat.format(date), time: `at ${time}` };
}
