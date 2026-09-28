import "server-only";
import type { Session, SessionEvent } from "@/lib/session/schema";

// `next dev` only: each session's events, state changes and voice tool timings, one JSON line each, in
// .logs/sessions/<id>.jsonl, so a local run can be read back after it happens. The memory store is the only other copy,
// and it lives inside the dev server. DEV_LOG=0 turns it off; tests and the Worker never write it.

const DIR = ".logs/sessions";
const enabled = () => process.env.NODE_ENV === "development" && process.env.DEV_LOG !== "0";

// One chain, so lines land in the order they were logged.
let queue: Promise<unknown> = Promise.resolve();

export function devLog(sessionId: string, entry: Record<string, unknown>): void {
  if (!enabled()) return;
  const line = `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`;
  queue = queue
    .then(async () => {
      const fs = await import("node:fs/promises");
      await fs.mkdir(DIR, { recursive: true });
      await fs.appendFile(`${DIR}/${sessionId}.jsonl`, line);
    })
    .catch(() => {});
}

/**
 * Sessions already in memory when logging starts, or when the dev server reloads: each file gets whatever events came
 * before its first logged one, written at its start, so a session begun before logging is whole.
 */
export function devLogBackfill(rows: Iterable<{ session: Session; events: SessionEvent[] }>): void {
  if (!enabled()) return;
  for (const { session, events } of rows) {
    queue = queue
      .then(async () => {
        const fs = await import("node:fs/promises");
        const file = `${DIR}/${session.id}.jsonl`;
        const logged = await fs.readFile(file, "utf8").catch(() => "");
        const first = logged.split("\n").map(firstSeq).find((seq) => seq !== undefined) ?? Infinity;
        const missing = events.filter((e) => e.seq < first);
        if (!missing.length) return;
        const lines = missing.map((e) => `${JSON.stringify({ t: e.at, backfilled: true, ...eventEntry(e) })}\n`).join("");
        await fs.mkdir(DIR, { recursive: true });
        await fs.writeFile(file, lines + logged);
      })
      .catch(() => {});
  }
}

function firstSeq(line: string): number | undefined {
  try {
    const seq: unknown = JSON.parse(line).event?.seq;
    return typeof seq === "number" ? seq : undefined;
  } catch {
    return undefined;
  }
}

const eventEntry = (e: SessionEvent) => ({ event: { seq: e.seq, at: e.at, channel: e.channel, role: e.role, content: e.content, ...(e.meta && { meta: e.meta }) } });

export function devLogEvent(sessionId: string, e: SessionEvent): void {
  devLog(sessionId, eventEntry(e));
}

/** What changed the flow: the call, Gmail, the four slots and the last ask. */
export function devLogState(s: Session): void {
  devLog(s.id, {
    state: {
      version: s.version,
      call: s.call,
      gmail: s.gmail.status,
      agentName: s.agentName?.value ?? null,
      userName: s.userName?.value ?? null,
      helpNeed: s.helpNeed?.value ?? null,
      lastAsked: s.steering.lastAskedSlot ?? null,
      graduated: s.graduated,
    },
  });
}
