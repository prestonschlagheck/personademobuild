"use client";

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReactionType, SessionEvent, Snapshot } from "@/lib/session/schema";
import { MAX_BATCH, MAX_TEXT, type LocationRequest } from "@/lib/api/contract";
import { coarseDegree } from "@/lib/agent/policy";
import { api, ApiRequestError } from "@/lib/client/api";
import { isOAuthReport } from "@/lib/client/oauth-report";

// Client mirror of the server session. The server is the source of truth: this holds the latest
// snapshot, optimistic outgoing texts, and the debounce that batches rapid messages into one turn.

// Long enough to catch texts sent back to back, short enough that a single text feels instant. Anything sent while a
// turn is in flight joins the next one, so a longer burst gets two replies at most, never one per text.
const TURN_DEBOUNCE_MS = 300;
const POLL_LIVE_MS = 1000;
const POLL_IDLE_MS = 2000;
const BUSY_RETRY_MS = 800;
// A rate-limited turn waits longer each time it is refused, up to this.
const MAX_RETRY_MS = 8_000;
// Comfortably under the server's 64 KB body cap (lib/server/http.ts), whatever the texts are written in.
const MAX_BATCH_BYTES = 48 * 1024;
// A turn runs the whole agent loop on the server, so it gets longer than an ordinary request.
const TURN_TIMEOUT_MS = 30_000;
const LOCATION_TIMEOUT_MS = 10_000;
const LOCATION_MAX_AGE_MS = 10 * 60_000;

/** `afterSeq` is the last event the thread had when the text was sent, so the thread keeps it where it was typed. */
export type Pending = {
  clientMsgId: string;
  text: string;
  at: string;
  status: "queued" | "sending" | "failed";
  replyTo?: string;
  afterSeq?: number;
};

/** A text as it goes out: trimmed, and cut at the server's limit, never through the middle of an emoji. */
export function clampText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TEXT) return trimmed;
  const cut = /[\uD800-\uDBFF]/.test(trimmed[MAX_TEXT - 1] ?? "") ? MAX_TEXT - 1 : MAX_TEXT;
  return trimmed.slice(0, cut).trimEnd();
}

const bytes = (text: string) => new TextEncoder().encode(JSON.stringify(text)).length;

/**
 * The next turn's texts: the oldest queued ones, as many as one request may carry. The first always goes, since a
 * clamped text alone is well under the body cap.
 */
export function nextBatch(pending: Pending[]): Pending[] {
  const batch: Pending[] = [];
  let size = 0;
  for (const m of pending) {
    if (m.status !== "queued") continue;
    size += bytes(m.text);
    if (batch.length === MAX_BATCH || (batch.length > 0 && size > MAX_BATCH_BYTES)) break;
    batch.push(m);
  }
  return batch;
}

/** How long a rate-limited turn waits before its `attempt`th retry (from 0): doubling from the busy wait, capped. */
export const retryDelay = (attempt: number) => Math.min(BUSY_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);

/**
 * A retried text is sent again now, so it goes to the back of the queue and the bottom of the thread, as iMessage's
 * Try Again does. `afterSeq` is the thread's last event at the retry.
 */
export function requeue(pending: Pending[], clientMsgId: string, afterSeq: number | undefined): Pending[] {
  const message = pending.find((m) => m.clientMsgId === clientMsgId);
  if (!message) return pending;
  return [...pending.filter((m) => m !== message), { ...message, status: "queued", afterSeq }];
}

// Answered the way the server judges a retry: any text in the thread after the message that is not the user's.
function answered(events: SessionEvent[], clientMsgId: string) {
  const at = events.findIndex((e) => e.clientMsgId === clientMsgId);
  return at >= 0 && events.slice(at + 1).some((e) => e.channel === "text" && e.role !== "user");
}

/**
 * An outgoing text is kept until the server answers it, not merely until the server has it, so a turn that failed
 * after storing its messages can still be retried.
 */
export function unanswered(pending: Pending[], events: SessionEvent[]): Pending[] {
  const open = pending.filter((m) => !answered(events, m.clientMsgId));
  return open.length === pending.length ? pending : open;
}

/**
 * What the thread draws. A text the server already has shows as the stored message, except one whose turn failed:
 * that one shows once, as the failed bubble with its retry, until the retry is sent.
 */
export function threadView(snapshot: Snapshot | null, pending: Pending[]): { snapshot: Snapshot | null; pending: Pending[] } {
  if (!snapshot) return { snapshot, pending };
  const failed = new Set(pending.filter((m) => m.status === "failed").map((m) => m.clientMsgId));
  const stored = new Set(snapshot.events.map((e) => e.clientMsgId));
  const shown = pending.filter((m) => failed.has(m.clientMsgId) || !stored.has(m.clientMsgId));
  const events = snapshot.events.filter((e) => !(e.clientMsgId && failed.has(e.clientMsgId)));
  return {
    snapshot: events.length === snapshot.events.length ? snapshot : { ...snapshot, events },
    pending: shown.length === pending.length ? pending : shown,
  };
}

type OnboardingValue = {
  snapshot: Snapshot | null;
  pending: Pending[];
  agentTyping: boolean;
  offline: boolean;
  apply: (next: Snapshot | null) => void;
  refresh: () => Promise<void>;
  /** `replyTo` threads it under that message, as an inline reply. */
  send: (text: string, replyTo?: string) => void;
  retry: (clientMsgId: string) => void;
  react: (targetId: string, type: ReactionType | null) => void;
  saveContact: () => void;
  /** Share My Location: asks the browser, and resolves with the rounded point to stage, or null when it gave none. */
  locate: () => Promise<StagedLocation | null>;
  /** Sends the staged point, which the agent then hears about. */
  sendLocation: (point: StagedLocation) => Promise<void>;
  reset: () => Promise<void>;
};

/** A position already rounded to two decimals (about 1 km), waiting in the composer for Send. */
export type StagedLocation = { lat: number; lng: number; accuracy: number };

const OnboardingContext = createContext<OnboardingValue | null>(null);

export function useOnboarding() {
  const value = use(OnboardingContext);
  if (!value) throw new Error("useOnboarding must be used inside <OnboardingProvider>");
  return value;
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPendingState] = useState<Pending[]>([]);
  const [agentTyping, setAgentTyping] = useState(false);
  const [offline, setOffline] = useState(false);

  const latest = useRef<Snapshot | null>(null);
  const pendingRef = useRef<Pending[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  // Bumped by a reset, so a poll sent before it cannot bring the old thread back.
  const generation = useRef(0);

  // Mirrored in a ref so the debounced flush reads the queue synchronously.
  const setPending = useCallback((update: (p: Pending[]) => Pending[]) => {
    pendingRef.current = update(pendingRef.current);
    setPendingState(pendingRef.current);
  }, []);

  // Snapshots can arrive out of order (poll vs. mutation). Keep whichever is newest.
  const apply = useCallback((next: Snapshot | null) => {
    if (!next) return;
    const cur = latest.current;
    if (cur && cur.session.id === next.session.id) {
      const older = next.session.version < cur.session.version ||
        (next.session.version === cur.session.version && next.lastSeq < cur.lastSeq);
      if (older) return;
    }
    latest.current = next;
    setSnapshot(next);
    setPending((p) => unanswered(p, next.events));
  }, [setPending]);

  const refresh = useCallback(async () => {
    const cur = latest.current;
    const query = cur ? `?v=${cur.session.version}&e=${cur.lastSeq}` : "?resume=1";
    const sent = generation.current;
    try {
      const next = await api<Snapshot>(`/api/session${query}`);
      if (sent === generation.current) apply(next);
      setOffline(false);
    } catch (err) {
      if (!(err instanceof ApiRequestError)) setOffline(true);
    }
  }, [apply]);

  // One turn at a time. Texts sent while a turn is in flight go out as the next batch, and a long burst goes out
  // a request's worth at a time. A 409 (another tab holds the turn lease) waits briefly and sends the same batch
  // again; a 429 does too, waiting longer each time. Any other failure, a 400 included, is marked for the
  // person's own retry and the loop moves on, so nothing queued behind it is stranded. A batch leaves the queue
  // only once its turn succeeds, so a failure after the server stored it still has something to retry.
  const flush = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setAgentTyping(true);
    let limited = 0;
    try {
      for (let batch = nextBatch(pendingRef.current); batch.length > 0; batch = nextBatch(pendingRef.current)) {
        const ids = new Set(batch.map((m) => m.clientMsgId));
        setPending((p) => p.map((m) => (ids.has(m.clientMsgId) ? { ...m, status: "sending" } : m)));
        try {
          const messages = batch.map(({ clientMsgId, text, replyTo }) => ({ clientMsgId, text, ...(replyTo && { replyTo }) }));
          const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const sent = generation.current;
          const result = await api<Snapshot>("/api/turn", { body: { messages, timeZone }, timeoutMs: TURN_TIMEOUT_MS });
          // A reset can land while this turn is in flight. Its response is for a conversation that no
          // longer exists, so only apply it (and clear its messages from the queue) if nothing reset since.
          if (sent === generation.current) {
            apply(result);
            setPending((p) => p.filter((m) => !ids.has(m.clientMsgId)));
          }
          limited = 0;
          setOffline(false);
        } catch (err) {
          const status = err instanceof ApiRequestError ? err.status : null;
          const again = status === 409 || status === 429;
          setPending((p) => p.map((m) => (ids.has(m.clientMsgId) ? { ...m, status: again ? "queued" : "failed" } : m)));
          if (status === null) setOffline(true);
          if (!again) continue;
          await new Promise((resolve) => setTimeout(resolve, status === 429 ? retryDelay(limited++) : BUSY_RETRY_MS));
        }
      }
    } finally {
      inFlight.current = false;
      setAgentTyping(false);
    }
  }, [apply, setPending]);

  const schedule = useCallback(() => {
    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => void flush(), TURN_DEBOUNCE_MS);
  }, [flush]);

  // The composer already stops a paste at the limit; this catches anything typed in some other way.
  const send = useCallback(
    (text: string, replyTo?: string) => {
      const clamped = clampText(text);
      if (!clamped) return;
      const message: Pending = {
        clientMsgId: crypto.randomUUID(),
        text: clamped,
        at: new Date().toISOString(),
        status: "queued",
        afterSeq: latest.current?.lastSeq,
        ...(replyTo && { replyTo }),
      };
      setPending((p) => [...p, message]);
      schedule();
    },
    [schedule, setPending],
  );

  const retry = useCallback(
    (clientMsgId: string) => {
      setPending((p) => requeue(p, clientMsgId, latest.current?.lastSeq));
      schedule();
    },
    [schedule, setPending],
  );

  const mutate = useCallback(
    (path: string, body: unknown) => {
      const sent = generation.current;
      return api<Snapshot>(path, { body }).then(
        (result) => {
          if (sent === generation.current) apply(result);
        },
        (err) => {
          if (!(err instanceof ApiRequestError)) setOffline(true);
        },
      );
    },
    [apply],
  );

  const react = useCallback((targetId: string, type: ReactionType | null) => mutate("/api/react", { targetId, type }), [mutate]);
  const saveContact = useCallback(() => mutate("/api/contact", { saved: true }), [mutate]);
  // The browser asks for permission on the tap, and the point waits in the composer until they send it, as in
  // Messages. Only two decimals (about 1 km) are ever kept, and a refusal is reported at once, so the agent can say so
  // and the card stays tappable.
  const locate = useCallback(
    () =>
      new Promise<StagedLocation | null>((resolve) => {
        const refused = (reason: Extract<LocationRequest, { status: "denied" }>["reason"]) => {
          void mutate("/api/location", { status: "denied", reason } satisfies LocationRequest);
          resolve(null);
        };
        if (!("geolocation" in navigator)) return refused("unavailable");
        navigator.geolocation.getCurrentPosition(
          ({ coords }) => resolve({ lat: coarseDegree(coords.latitude), lng: coarseDegree(coords.longitude), accuracy: coords.accuracy }),
          (err) => refused(err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable"),
          { timeout: LOCATION_TIMEOUT_MS, maximumAge: LOCATION_MAX_AGE_MS },
        );
      }),
    [mutate],
  );
  const sendLocation = useCallback(
    (point: StagedLocation) => mutate("/api/location", { status: "shared", ...point } satisfies LocationRequest),
    [mutate],
  );

  // The thread clears at once; the fresh session arrives in the same response that erased the old one.
  const reset = useCallback(async () => {
    clearTimeout(flushTimer.current);
    generation.current++;
    latest.current = null;
    setSnapshot(null);
    setPending(() => []);
    const fresh = await api<Snapshot>("/api/session", { method: "DELETE" }).catch(() => null);
    if (fresh) apply(fresh);
    else await refresh();
  }, [apply, refresh, setPending]);

  // Poll faster while something live is happening: a call, an open Gmail link, or a turn in flight.
  const live = snapshot
    ? ["ringing", "active", "scheduled"].includes(snapshot.session.call.status) || snapshot.session.gmail.status === "link_sent"
    : false;

  // Once it has the session, a hidden tab with nothing live stops polling, since nothing on the server is due.
  // It catches up on return.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let inFlight = false;
    const busy = live || agentTyping;
    const tick = async () => {
      clearTimeout(timer);
      if (stopped || inFlight || (document.hidden && !busy && latest.current)) return;
      inFlight = true;
      await refresh();
      inFlight = false;
      if (!stopped) timer = setTimeout(tick, busy ? POLL_LIVE_MS : POLL_IDLE_MS);
    };
    const onVisibility = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, live, agentTyping]);

  useEffect(() => () => clearTimeout(flushTimer.current), []);

  // Sign-in reports back from its own window, so the result shows at once rather than on the next poll.
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (isOAuthReport(event)) void refresh();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh]);

  // Every consumer gets the thread's view, so a failed text is drawn once wherever it shows.
  const view = useMemo(() => threadView(snapshot, pending), [snapshot, pending]);
  const value = useMemo<OnboardingValue>(
    () => ({ ...view, agentTyping, offline, apply, refresh, send, retry, react, saveContact, locate, sendLocation, reset }),
    [view, agentTyping, offline, apply, refresh, send, retry, react, saveContact, locate, sendLocation, reset],
  );

  return <OnboardingContext value={value}>{children}</OnboardingContext>;
}
