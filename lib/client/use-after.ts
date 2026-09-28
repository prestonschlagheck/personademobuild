import { useEffect, useState } from "react";

/** True once `active` has held for `ms`, and false again the moment it drops. */
export function useAfter(active: boolean, ms: number) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setLate(true), ms);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [active, ms]);
  return active && late;
}
