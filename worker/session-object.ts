import { DurableObject } from "cloudflare:workers";
import type { OAuthStateStatus, Reading, SaveResult, TurnStart } from "@/lib/server/store/types";
import type { NewEvent, Session, SessionEvent } from "@/lib/session/schema";

// One Durable Object per session: the single writer for its state, thread, turn lease, call heartbeat and Gmail link
// states. Requests to one object run one at a time and SQLite calls here are synchronous, so each method below is
// atomic without a transaction or a row lock.
//
// While a call rings or runs, a callback is booked, a Gmail link waits on its reminder, or a reminder they asked for
// waits to go out, the object's alarm wakes itself and asks the app to settle the session, so a hangup gets its text
// within seconds even when no tab is open.
// It also comes back for the session once it has sat unwritten for as long as the session cookie lives, has the app
// hand its Google sign-in back to Google, and deletes it with its archive copy.
//
// Every write is copied to D1 in the background, in commit order: a read-only archive for queries across sessions.

type Env = {
  WORKER_SELF_REFERENCE: Fetcher;
  CRON_SECRET?: string;
  ARCHIVE?: D1Database;
};

/** How often a ringing or live call is checked. Timeouts are 10 s and up, so this stays well inside them. */
const CALL_TICK_MS = 5_000;
/** Mirrors `LINK_REMINDER_MS` in lib/server/call-timers.ts. */
const LINK_REMINDER_MS = 2 * 60_000;
/** How soon a failed archive delete, or a failed ask to revoke Google at expiry, is tried again. */
const ARCHIVE_RETRY_MS = 30_000;
/** How many times an expiring session asks the app to revoke its Google sign-in before it is deleted anyway. */
export const REVOKE_TRIES = 3;
/** How long a session outlives its last write. Mirrors the cookie's `MAX_AGE_S` in lib/server/cookie.ts. */
export const RETENTION_MS = 30 * 24 * 60 * 60_000;

type EventRow = {
  seq: number;
  id: string;
  at: string;
  channel: SessionEvent["channel"];
  role: SessionEvent["role"];
  content: string;
  meta: string | null;
  client_msg_id: string | null;
  tool_call_id: string | null;
};

function toEvent(row: EventRow): SessionEvent {
  return {
    seq: row.seq,
    id: row.id,
    at: row.at,
    channel: row.channel,
    role: row.role,
    content: row.content,
    ...(row.meta && { meta: JSON.parse(row.meta) }),
    ...(row.client_msg_id && { clientMsgId: row.client_msg_id }),
    ...(row.tool_call_id && { toolCallId: row.tool_call_id }),
  };
}

/** A sliding-window count: the hits still inside the window, and whether one more fits under `max`. */
type Window = { hits: number[]; windowMs: number };
function slide(stored: Window | undefined, max: number, windowMs: number, now: number): { ok: boolean; next: Window } {
  const recent = (stored?.hits ?? []).filter((t) => now - t < windowMs);
  const ok = recent.length < max;
  return { ok, next: { hits: ok ? [...recent, now] : recent, windowMs } };
}

/**
 * An early hint of when this session next needs a look, set on every save. The app's answer after each alarm
 * (`nextTimerAt` in lib/server/call-timers.ts, which knows every guard) is what the object follows from then on.
 */
export function nextWake(s: Session, now: number): number | null {
  const times: number[] = [];
  if (s.call.status === "ringing" || s.call.status === "active") times.push(now + CALL_TICK_MS);
  if (s.call.status === "scheduled" && s.call.scheduledFor && !s.consent.stoppedAt) times.push(Date.parse(s.call.scheduledFor));
  if (s.gmail.status === "link_sent" && !s.gmail.remindedAt && s.gmail.linkSentAt) {
    times.push(Date.parse(s.gmail.linkSentAt) + LINK_REMINDER_MS);
  }
  if (!s.consent.stoppedAt) for (const r of s.reminders ?? []) if (!r.sentAt && !r.cancelledAt) times.push(Date.parse(r.at));
  const valid = times.filter(Number.isFinite);
  return valid.length ? Math.max(now + 1_000, Math.min(...valid)) : null;
}

/**
 * When the session was last written: the stamp every write leaves, or its last save for one written before stamps.
 * One that can't be told is taken as active now, so nothing is ever deleted early.
 */
export function lastActive(stamp: string | null, session: Session, now: number): number {
  const stamped = Number(stamp);
  if (stamp && Number.isFinite(stamped)) return stamped;
  const saved = Date.parse(session.updatedAt);
  return Number.isFinite(saved) ? saved : now;
}

/** Whether a session last written at `activeAt` has outlived its retention. */
export function expired(activeAt: number, now: number): boolean {
  return now - activeAt >= RETENTION_MS;
}

/** Where a link's state stands at `at`, from its row: the test `consumeOAuthState` applies, without using it up. */
export function stateStatus(row: { created_at: string; used_at: string | null } | undefined, at: string, maxAgeMs: number): OAuthStateStatus {
  if (!row) return "unknown";
  if (row.used_at) return "used";
  return Date.parse(at) - Date.parse(row.created_at) > maxAgeMs ? "expired" : "unused";
}

const SCHEMA = `
  create table if not exists meta (key text primary key, value text);
  create table if not exists events (
    seq integer primary key autoincrement,
    id text not null unique,
    at text not null,
    channel text not null,
    role text not null,
    content text not null,
    meta text,
    client_msg_id text unique,
    tool_call_id text unique
  );
  create table if not exists oauth_states (state text primary key, created_at text not null, used_at text);
`;

export class SessionObject extends DurableObject<Env> {
  private sql: SqlStorage;
  // An object is only given tables by a write, so a request with a made-up session id reads nothing and leaves nothing.
  private ready: boolean;
  private archive: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ready = this.sql.exec("select 1 from sqlite_master where type = 'table' and name = 'meta'").toArray().length > 0;
  }

  private migrate(): void {
    if (this.ready) return;
    this.sql.exec(SCHEMA);
    this.ready = true;
  }

  private get(key: string): string | null {
    if (!this.ready) return null;
    return this.sql.exec<{ value: string }>("select value from meta where key = ?", key).toArray()[0]?.value ?? null;
  }

  private set(key: string, value: string | null): void {
    this.migrate();
    if (value === null) this.sql.exec("delete from meta where key = ?", key);
    else this.sql.exec("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", key, value);
  }

  private session(): Session | null {
    const raw = this.get("session");
    return raw ? (JSON.parse(raw) as Session) : null;
  }

  private events(limit: number): SessionEvent[] {
    if (!this.ready) return [];
    return this.sql.exec<EventRow>("select * from events order by seq desc limit ?", limit).toArray().reverse().map(toEvent);
  }

  private insert(events: NewEvent[]): SessionEvent[] {
    const inserted: SessionEvent[] = [];
    for (const { at, ...event } of events) {
      const rows = this.sql
        .exec<EventRow>(
          `insert into events (id, at, channel, role, content, meta, client_msg_id, tool_call_id)
           values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning *`,
          crypto.randomUUID(),
          at ?? new Date().toISOString(),
          event.channel,
          event.role,
          event.content,
          event.meta ? JSON.stringify(event.meta) : null,
          event.clientMsgId ?? null,
          event.toolCallId ?? null,
        )
        .toArray();
      if (rows[0]) inserted.push(toEvent(rows[0]));
    }
    return inserted;
  }

  private lease(ms: number): string | null {
    if (Number(this.get("lease_until") ?? 0) > Date.now()) return null;
    const token = crypto.randomUUID();
    this.set("lease_token", token);
    this.set("lease_until", String(Date.now() + ms));
    return token;
  }

  private release(token: string): void {
    if (this.get("lease_token") !== token) return;
    this.set("lease_token", null);
    this.set("lease_until", null);
  }

  private async arm(wake: number | null): Promise<void> {
    if (wake === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > wake) await this.ctx.storage.setAlarm(wake);
  }

  // Every write restarts the retention clock and leaves an alarm set no later than it runs out.
  private async touch(wake: number | null = null): Promise<void> {
    const now = Date.now();
    this.set("active_at", String(now));
    await this.arm(Math.min(wake ?? Infinity, now + RETENTION_MS));
  }

  async create(session: Session): Promise<void> {
    this.set("session", JSON.stringify(session));
    await this.touch();
    this.mirror({ session });
  }

  async load(): Promise<Session | null> {
    return this.session();
  }

  async read(limit: number): Promise<Reading | null> {
    const session = this.session();
    if (!session) return null;
    const events = this.events(limit);
    return { session, events, lastSeq: events.at(-1)?.seq ?? 0, callLastSeen: this.get("call_last_seen") };
  }

  async beginTurn(leaseMs: number, events: NewEvent[], historyLimit: number): Promise<TurnStart> {
    const session = this.session();
    const lease = session ? this.lease(leaseMs) : null;
    if (!session || !lease) return { lease: null };
    const inserted = this.insert(events);
    await this.touch();
    this.mirror({ events: inserted });
    return { lease, session, inserted, history: this.events(historyLimit) };
  }

  async save(
    next: Session,
    expected: number,
    events: NewEvent[] = [],
    oauthState?: string,
    { releaseLease, recent }: { releaseLease?: string; recent?: number } = {},
  ): Promise<SaveResult> {
    const stored = this.session();
    if (!stored || stored.version !== expected) return { ok: false, conflict: true };
    const session = { ...next, version: expected + 1 };
    this.set("session", JSON.stringify(session));
    if (oauthState) {
      // A fresh link replaces the one before it, so no earlier link can still finish sign-in.
      this.sql.exec("update oauth_states set used_at = ? where used_at is null", next.updatedAt);
      this.sql.exec("insert into oauth_states (state, created_at) values (?, ?)", oauthState, next.updatedAt);
    }
    const inserted = this.insert(events);
    if (releaseLease) this.release(releaseLease);
    await this.touch(nextWake(session, Date.now()));
    this.mirror({ session, events: inserted });
    return { ok: true, session, events: inserted, ...(recent && { recent: this.events(recent) }) };
  }

  /**
   * Deletes everything. The archive copy has to go too, so until D1 confirms it the object keeps one row naming the
   * session and retries from its alarm.
   */
  async destroy(): Promise<void> {
    const id = this.session()?.id;
    await this.wipe();
    if (!id || (await this.mirror({ deleted: id }))) return;
    this.set("archive_delete", id);
    await this.ctx.storage.setAlarm(Date.now() + ARCHIVE_RETRY_MS);
  }

  private async wipe(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }

  async appendEvents(events: NewEvent[]): Promise<SessionEvent[]> {
    if (!this.session()) throw new Error("session not found");
    const inserted = this.insert(events);
    await this.touch();
    this.mirror({ events: inserted });
    return inserted;
  }

  async listEvents(limit: number): Promise<SessionEvent[]> {
    return this.events(limit);
  }

  async lastSeq(): Promise<number> {
    return this.events(1)[0]?.seq ?? 0;
  }

  async acquireTurnLease(ms: number): Promise<string | null> {
    return this.session() ? this.lease(ms) : null;
  }

  async releaseTurnLease(token: string): Promise<void> {
    this.release(token);
  }

  /**
   * A per-session rate limit, kept in the session's own object: it is already warm, so a session's first message never
   * waits on a new object being created somewhere. A session that does not exist takes nothing and stores nothing.
   */
  async take(bucket: string, max: number, windowMs: number, now: number): Promise<boolean> {
    if (!this.session()) return true;
    const raw = this.get(`limit:${bucket}`);
    const { ok, next } = slide(raw ? (JSON.parse(raw) as Window) : undefined, max, windowMs, now);
    this.set(`limit:${bucket}`, JSON.stringify(next));
    return ok;
  }

  // A meta row, so the archive, which copies only the session and its events, never sees it.
  async setGoogleGrant(sealed: string | null): Promise<void> {
    if (sealed === null || this.session()) this.set("google_grant", sealed);
  }

  async googleGrant(): Promise<string | null> {
    return this.get("google_grant");
  }

  async touchCall(at: string): Promise<void> {
    if (this.session()) this.set("call_last_seen", at);
  }

  async callLastSeen(): Promise<string | null> {
    return this.get("call_last_seen");
  }

  async createOAuthState(state: string, at: string): Promise<void> {
    if (!this.session()) return;
    this.sql.exec("insert into oauth_states (state, created_at) values (?, ?) on conflict do nothing", state, at);
  }

  async hasOAuthState(state: string): Promise<boolean> {
    if (!this.session()) return false;
    return this.sql.exec("select 1 from oauth_states where state = ?", state).toArray().length > 0;
  }

  private stateRow(state: string) {
    return this.sql
      .exec<{ created_at: string; used_at: string | null }>("select created_at, used_at from oauth_states where state = ?", state)
      .toArray()[0];
  }

  async oauthStateStatus(state: string, at: string, maxAgeMs: number): Promise<OAuthStateStatus> {
    return this.session() ? stateStatus(this.stateRow(state), at, maxAgeMs) : "unknown";
  }

  /** Single use: true once for a state this session issued within the age limit, false forever after. */
  async consumeOAuthState(state: string, at: string, maxAgeMs: number): Promise<boolean> {
    if (!this.session() || stateStatus(this.stateRow(state), at, maxAgeMs) !== "unused") return false;
    this.sql.exec("update oauth_states set used_at = ? where state = ?", at, state);
    return true;
  }

  /**
   * Retries a pending archive delete, revokes Google for and deletes a session past its retention, or settles its timers, and
   * always leaves an alarm set for the day its retention runs out.
   */
  async alarm(): Promise<void> {
    const pending = this.get("archive_delete");
    if (pending) {
      if (await this.mirror({ deleted: pending })) await this.wipe();
      else await this.ctx.storage.setAlarm(Date.now() + ARCHIVE_RETRY_MS);
      return;
    }
    const session = this.session();
    if (!session) return;
    const activeAt = lastActive(this.get("active_at"), session, Date.now());
    // Past its retention the session goes, archive copy and all, as a delete the user asked for would: Google access first.
    if (expired(activeAt, Date.now())) {
      if (await this.handBackGoogle(session)) await this.destroy();
      return;
    }
    await this.settle(session);
    await this.arm(activeAt + RETENTION_MS);
  }

  /**
   * Asks the app to revoke the session's Google sign-in, which only the app can unseal, before the object deletes it.
   * True once nothing is left to ask about: no sign-in, the app answered (whatever Google said, the app deleted it), or
   * the tries ran out, since the sealed sign-in goes with the object either way. False has the alarm try again soon.
   */
  private async handBackGoogle(session: Session): Promise<boolean> {
    if (!this.get("google_grant")) return true;
    if (!this.env.CRON_SECRET) {
      console.error("[alarm] CRON_SECRET is not set; an expiring session's google sign-in is deleted without a revoke");
      return true;
    }
    const answered = await this.env.WORKER_SELF_REFERENCE.fetch(`https://self/api/cron/revoke?session=${session.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.CRON_SECRET}` },
    })
      .then(async (res) => {
        await res.text();
        if (!res.ok) console.error("[alarm] revoke failed", res.status);
        return res.ok;
      })
      .catch((err: unknown) => {
        console.error("[alarm] revoke failed", err instanceof Error ? err.name : "unknown");
        return false;
      });
    const tries = Number(this.get("revoke_failures") ?? 0) + 1;
    if (answered || tries >= REVOKE_TRIES) return true;
    this.set("revoke_failures", String(tries));
    await this.ctx.storage.setAlarm(Date.now() + ARCHIVE_RETRY_MS);
    return false;
  }

  /**
   * Asks the app to run the session's due timers and wakes again when the app says the next one falls due. A failed
   * settle backs off (5 s, 10 s, 20 s, up to 10 minutes) instead of spinning.
   */
  private async settle(session: Session): Promise<void> {
    // Without the secret the app's route does not exist, so there is nothing to wake for.
    if (!this.env.CRON_SECRET) {
      console.error("[alarm] CRON_SECRET is not set; session timers only settle when a tab reads them");
      return;
    }
    const wake = await this.env.WORKER_SELF_REFERENCE.fetch(`https://self/api/cron/calls?session=${session.id}`, {
      headers: { authorization: `Bearer ${this.env.CRON_SECRET}` },
    })
      .then(async (res) => {
        if (res.ok) return ((await res.json()) as { wake: number | null }).wake;
        await res.text();
        console.error("[alarm] settle failed", res.status);
        return undefined;
      })
      .catch((err: unknown) => {
        console.error("[alarm] settle failed", err instanceof Error ? err.name : "unknown");
        return undefined;
      });
    if (wake !== undefined) {
      this.set("alarm_failures", null);
      await this.arm(wake === null ? null : Math.max(wake, Date.now() + 1_000));
      return;
    }
    const failures = Number(this.get("alarm_failures") ?? 0) + 1;
    this.set("alarm_failures", String(failures));
    const after = this.session();
    const hint = after && nextWake(after, Date.now());
    if (hint) await this.arm(Math.max(hint, Date.now() + Math.min(CALL_TICK_MS * 2 ** failures, 10 * 60_000)));
  }

  // One D1 batch per write, chained so the archive sees writes in commit order; a batch is one transaction, and the
  // version guard keeps an older copy from ever landing over a newer one. A copy is best effort, since the object is
  // the source of truth; a delete reports whether it landed, so destroy() can retry it.
  private mirror(change: { session?: Session; events?: SessionEvent[]; deleted?: string }): Promise<boolean> {
    const db = this.env.ARCHIVE;
    const id = change.deleted ?? change.session?.id ?? this.session()?.id;
    if (!db || !id) return Promise.resolve(!db);
    const statements: D1PreparedStatement[] = [];
    if (change.deleted) {
      statements.push(db.prepare("delete from events where session_id = ?").bind(id));
      statements.push(db.prepare("delete from sessions where id = ?").bind(id));
    }
    if (change.session) {
      const s = change.session;
      statements.push(
        db
          .prepare(
            `insert into sessions (id, state, version, created_at, updated_at) values (?, ?, ?, ?, ?)
             on conflict (id) do update set state = excluded.state, version = excluded.version, updated_at = excluded.updated_at
             where excluded.version > sessions.version`,
          )
          .bind(s.id, JSON.stringify(s), s.version, s.createdAt, s.updatedAt),
      );
    }
    for (const e of change.events ?? []) {
      statements.push(
        db
          .prepare(
            `insert into events (id, session_id, client_msg_id, tool_call_id, channel, role, content, meta, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing`,
          )
          .bind(e.id, id, e.clientMsgId ?? null, e.toolCallId ?? null, e.channel, e.role, e.content, e.meta ? JSON.stringify(e.meta) : null, e.at),
      );
    }
    if (statements.length === 0) return Promise.resolve(true);
    const landed = this.archive.then(() => db.batch(statements)).then(
      () => true,
      (err: unknown) => {
        console.error("[archive]", err);
        return false;
      },
    );
    this.archive = landed.then(() => undefined);
    return landed;
  }
}

/**
 * The rate limits for one address, every bucket in one object: the page load's session-create check warms it, so the
 * first message's address check finds it ready. Requests to an object run one at a time, so each count is exact across
 * every instance of the worker. It forgets each bucket once its window has passed, and itself once all are empty.
 */
export class LimiterObject extends DurableObject<Env> {
  async take(bucket: string, max: number, windowMs: number, now: number): Promise<boolean> {
    const { ok, next } = slide(await this.ctx.storage.get<Window>(`hits:${bucket}`), max, windowMs, now);
    await this.ctx.storage.put(`hits:${bucket}`, next);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > now + windowMs) await this.ctx.storage.setAlarm(now + windowMs);
    return ok;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const buckets = await this.ctx.storage.list<Window>({ prefix: "hits:" });
    let next = 0;
    for (const [key, window] of buckets) {
      const hits = window.hits.filter((t) => now - t < window.windowMs);
      if (hits.length === 0) await this.ctx.storage.delete(key);
      else {
        await this.ctx.storage.put(key, { ...window, hits });
        next = Math.max(next, Math.min(...hits) + window.windowMs);
      }
    }
    if (next) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAll();
  }
}
