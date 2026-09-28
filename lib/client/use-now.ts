import { useEffect, useState } from "react";

/** The time in epoch ms, refreshed every `intervalMs`. Only for client-rendered parts: the thread and the event log. */
export function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
