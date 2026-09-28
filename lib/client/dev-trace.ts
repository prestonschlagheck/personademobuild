// `next dev` only: what happens on the call's Realtime channel, which the server never sees (a response that failed or
// was cut off, an error, a response asked for), added to the session's local log by /api/dev-log. A no-op in production.
// voiceDiag, at the end, is the one piece that runs in production.

const dev = process.env.NODE_ENV === "development";

export function devTrace(entry: Record<string, unknown>): void {
  if (!dev) return;
  const body = JSON.stringify({ ct: new Date().toISOString(), ...entry });
  void fetch("/api/dev-log", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
}

type Output = { type?: string; name?: string; status?: string };
type Raw = {
  type?: string;
  error?: unknown;
  call_id?: string;
  name?: string;
  response?: { id?: string; status?: string; status_details?: unknown; output?: Output[]; usage?: unknown };
};

/** One Realtime event off the wire, kept only when it says how a response went. */
export function traceRealtime(data: string): void {
  if (!dev) return;
  let event: Raw;
  try {
    event = JSON.parse(data) as Raw;
  } catch {
    return;
  }
  switch (event.type) {
    case "error":
      devTrace({ realtime: "error", error: event.error });
      break;
    case "response.created":
      devTrace({ realtime: "response.created", id: event.response?.id });
      break;
    case "response.done": {
      const r = event.response;
      const outputs = (r?.output ?? []).map((o) => (o.name ? `${o.type}:${o.name}` : o.type));
      devTrace({ realtime: "response.done", id: r?.id, status: r?.status, details: r?.status_details, outputs, usage: r?.usage });
      break;
    }
    case "response.function_call_arguments.done":
      devTrace({ realtime: "function_call", name: event.name, callId: event.call_id });
      break;
  }
}

/** What the browser sent that decides whether the agent speaks next: a response asked for or cancelled, a tool's result. */
export function traceSent(event: { type?: string; item?: { type?: string; call_id?: string; output?: string } }): void {
  if (!dev) return;
  if (event.type === "response.create" || event.type === "response.cancel") devTrace({ sent: event.type });
  else if (event.item?.type === "function_call_output") devTrace({ sent: "tool_output", callId: event.item.call_id, chars: event.item.output?.length });
}

// Production too, unlike everything above: a live call's own record of how its replies went, as codes and nothing else
// (a reply's status, an error code, a watchdog that fired), so a call that went quiet can be read back afterwards.

/** The most entries one batch carries. Past it, entries are only counted, as one "lost" entry. */
export const DIAG_CAP = 50;
// A reply that went as it should, or that they talked over: kept with the rest, but never a reason to send a batch early.
// One that completed with no output at all reached no one, so it is not routine.
const ROUTINE = /^done:(?:completed(?::n[1-9]\d*)?|none(?::n\d+)?|cancelled(?::[a-z_]+)?(?::n\d+)?)$/;
// How often a batch goes out early at most, so a call that keeps tripping never floods the thread with rows.
const EARLY_MS = 30_000;

export type VoiceDiag = {
  add(code: string): void;
  /**
   * The entries waiting: all of them when `all`, otherwise only once one says something went wrong or they fill a batch,
   * and no sooner than EARLY_MS after the last batch.
   */
  take(all: boolean): string[];
  /** Puts back a batch whose request failed, ahead of anything newer, as far as the cap allows. */
  restore(batch: string[]): void;
};

/** Each entry is the seconds since the call's record began, then the code: "12.3:done:failed:rate_limit_exceeded". */
export function voiceDiag(now: () => number = Date.now): VoiceDiag {
  const start = now();
  let entries: string[] = [];
  let lost = 0;
  let urgent = false;
  let sentAt = -Infinity;
  const room = DIAG_CAP - 1;
  const stamp = () => ((now() - start) / 1_000).toFixed(1);
  return {
    add(code) {
      const clean = code.toLowerCase().replace(/[^a-z0-9_.:]/g, "_").slice(0, 64);
      if (entries.length >= room) lost += 1;
      else entries.push(`${stamp()}:${clean}`);
      // Something went wrong, or the batch is full: it goes with the next heartbeat.
      if (!ROUTINE.test(clean) || entries.length >= room) urgent = true;
    },
    take(all) {
      if (!all && (!urgent || now() - sentAt < EARLY_MS)) return [];
      sentAt = now();
      const batch = lost ? [...entries, `${stamp()}:lost:${lost}`] : entries;
      entries = [];
      lost = 0;
      urgent = false;
      return batch;
    },
    restore(batch) {
      if (!batch.length) return;
      entries = [...batch, ...entries];
      lost += Math.max(0, entries.length - room);
      entries = entries.slice(0, room);
      urgent = true;
      // It never landed, so it goes with the retry.
      sentAt = -Infinity;
    },
  };
}

// Production too: browser errors on the page (a crash, a rejected promise), sent to the archive as name and message only,
// at most CLIENT_ERROR_CAP per page load so a loop can never flood it.
const CLIENT_ERROR_CAP = 10;

/** Starts reporting the page's uncaught errors. Returns the cleanup. */
export function watchClientErrors(): () => void {
  let sent = 0;
  const report = (error: string, where: string) => {
    if (sent >= CLIENT_ERROR_CAP || !error) return;
    sent += 1;
    const body = JSON.stringify({ error: error.slice(0, 200), where });
    void fetch("/api/client-error", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  };
  const described = (value: unknown) => (value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? ""));
  const onError = (event: ErrorEvent) => report(described(event.error ?? event.message), "error");
  const onRejection = (event: PromiseRejectionEvent) => report(described(event.reason), "unhandledrejection");
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
