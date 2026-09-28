import { useEffect, useEffectEvent, useState } from "react";
import type { Snapshot } from "@/lib/session/schema";
import { isAgentBubble } from "./thread-model";

type Revealed = { sessionId: string; cursor: number; baseline: number };

// A person sends each text on its own, so a burst of agent bubbles reveals one at a time, paced by
// length. The first bubble of a reply shows almost at once, since the turn itself was the wait.
// Anything already there on load shows instantly.
const typingDelay = (text: string, first: boolean) => (first ? 120 : Math.min(600, 300 + text.length * 4));

export function useReveal(snapshot: Snapshot | null, onReveal: () => void) {
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const sessionId = snapshot?.session.id;

  if (snapshot && revealed?.sessionId !== snapshot.session.id) {
    setRevealed({ sessionId: snapshot.session.id, cursor: snapshot.lastSeq, baseline: snapshot.lastSeq });
  }

  const current = revealed?.sessionId === sessionId ? revealed : null;
  const baseline = current?.baseline ?? snapshot?.lastSeq ?? 0;

  // Everything but agent bubbles (user texts, tapbacks, call rows) appears as soon as it is next in line.
  let cursor = current?.cursor ?? baseline;
  let next: { seq: number; content: string } | undefined;
  let first = true;
  for (const e of snapshot?.events ?? []) {
    if (e.seq <= cursor) {
      first = !isAgentBubble(e);
      continue;
    }
    if (isAgentBubble(e)) {
      next = e;
      break;
    }
    cursor = e.seq;
    first = true;
  }

  const announce = useEffectEvent(onReveal);
  const nextSeq = next?.seq;
  const nextText = next?.content ?? "";
  const nextFirst = first;

  useEffect(() => {
    if (!sessionId || nextSeq === undefined) return;
    const timer = setTimeout(() => {
      setRevealed((r) => (r?.sessionId === sessionId ? { ...r, cursor: Math.max(r.cursor, nextSeq) } : r));
      announce();
    }, typingDelay(nextText, nextFirst));
    return () => clearTimeout(timer);
  }, [sessionId, nextSeq, nextText, nextFirst]);

  return { cursor, baseline };
}
