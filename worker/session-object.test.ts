import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type NewEvent, type Session } from "@/lib/session/schema";

// The session Durable Object in plain Node. The workers pool for vitest does not run on vitest 5, so the runtime is
// stood in for: a DurableObject base that keeps ctx and env, and object storage whose SQL runs on Node's own SQLite,
// the same engine a SQLite-backed object uses. Alarms are only recorded; a test fires one by calling alarm().

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));

const { SessionObject, nextWake, lastActive, expired, stateStatus, RETENTION_MS, REVOKE_TRIES } = await import("./session-object");

type Env = ConstructorParameters<typeof SessionObject>[1];

/** Object storage: SQL on node:sqlite, the key-value calls on a map, and the one alarm slot. */
class FakeStorage {
  db = new DatabaseSync(":memory:");
  kv = new Map<string, unknown>();
  alarm: number | null = null;

  sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      // The schema is several statements with no bindings, which only exec() runs; everything else is one statement.
      const statements = query.split(";").filter((part) => part.trim());
      const rows = bindings.length === 0 && statements.length > 1 ? (this.db.exec(query), []) : this.db.prepare(query).all(...(bindings as SQLInputValue[]));
      const copies = rows.map((row) => ({ ...row }));
      return { toArray: () => copies, one: () => copies[0], [Symbol.iterator]: () => copies[Symbol.iterator]() };
    },
  };

  async get(key: string) {
    return this.kv.get(key);
  }
  async put(key: string, value: unknown) {
    this.kv.set(key, value);
  }
  async delete(key: string) {
    return this.kv.delete(key);
  }
  async list({ prefix = "" }: { prefix?: string } = {}) {
    return new Map([...this.kv].filter(([key]) => key.startsWith(prefix)));
  }
  async deleteAll() {
    this.kv.clear();
    const tables = this.db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all();
    for (const { name } of tables) this.db.exec(`drop table "${String(name)}"`);
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at: number | Date) {
    this.alarm = typeof at === "number" ? at : at.getTime();
  }
  async deleteAlarm() {
    this.alarm = null;
  }

  tables(): string[] {
    return this.db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all().map((row) => String(row.name));
  }
}

const T0 = Date.parse("2026-09-27T20:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let storage: FakeStorage;
let env: { CRON_SECRET?: string; WORKER_SELF_REFERENCE: { fetch: ReturnType<typeof vi.fn> } };

function object() {
  return new SessionObject({ storage } as unknown as DurableObjectState, env as unknown as Env);
}

/** A live object fires an alarm only once it is due, with the slot already cleared. */
async function fire(obj: InstanceType<typeof SessionObject>) {
  storage.alarm = null;
  await obj.alarm();
}

const text = (content: string, extra: Partial<NewEvent> = {}): NewEvent => ({ channel: "text", role: "user", content, ...extra });

async function created(session: Session = newSession("s1", iso(T0))) {
  const obj = object();
  await obj.create(session);
  return obj;
}

/** Nothing wakes the object before the day its retention runs out: no call tick, no booked callback. */
const noWakeBeforeRetention = () => expect(storage.alarm ?? Infinity).toBeGreaterThanOrEqual(T0 + RETENTION_MS);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  storage = new FakeStorage();
  env = { WORKER_SELF_REFERENCE: { fetch: vi.fn(async () => Response.json({ wake: null })) } };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session object state", () => {
  it("reads nothing and writes nothing for a session that was never created", async () => {
    const obj = object();
    expect(await obj.load()).toBeNull();
    expect(await obj.read(10)).toBeNull();
    expect(await obj.listEvents(10)).toEqual([]);
    expect(await obj.acquireTurnLease(20_000)).toBeNull();
    expect(await obj.beginTurn(20_000, [text("hi")], 10)).toEqual({ lease: null });
    await expect(obj.appendEvents([text("hi")])).rejects.toThrow("session not found");
    await obj.createOAuthState("st1", iso(T0));
    expect(await obj.consumeOAuthState("st1", iso(T0), 60_000)).toBe(false);
    expect(await obj.oauthStateStatus("st1", iso(T0), 60_000)).toBe("unknown");
    expect(await obj.take("turn", 5, 60_000, T0)).toBe(true);
    expect(storage.tables()).toEqual([]);
  });

  it("saves with compare-and-set on version and rejects a stale save", async () => {
    const obj = await created();
    const loaded = await obj.load();
    if (!loaded) throw new Error("missing session");
    expect(loaded.version).toBe(0);

    const first = await obj.save({ ...loaded, graduated: true }, 0);
    expect(first).toMatchObject({ ok: true, session: { version: 1, graduated: true } });
    // A writer that read version 0 lost the race: nothing it carried lands.
    expect(await obj.save({ ...loaded, graduated: false }, 0, [text("stale")], "st_stale")).toEqual({ ok: false, conflict: true });
    expect(await obj.load()).toMatchObject({ version: 1, graduated: true });
    expect(await obj.listEvents(10)).toEqual([]);
    expect(await obj.hasOAuthState("st_stale")).toBe(false);

    const second = await obj.save({ ...loaded, graduated: false }, 1);
    expect(second).toMatchObject({ ok: true, session: { version: 2, graduated: false } });
    // The version is the object's to bump: whatever the caller sends, the saved one is expected + 1.
    expect(await obj.save({ ...loaded, version: 99 }, 2)).toMatchObject({ ok: true, session: { version: 3 } });
  });

  it("saves a change's events with it and returns the latest thread when asked", async () => {
    const obj = await created();
    const saved = await obj.save(newSession("s1", iso(T0)), 0, [text("one"), text("two")], undefined, { recent: 1 });
    expect(saved).toMatchObject({ ok: true, events: [{ content: "one" }, { content: "two" }], recent: [{ content: "two" }] });
    const reading = await obj.read(10);
    expect(reading?.events.map((e) => e.content)).toEqual(["one", "two"]);
    expect(reading?.lastSeq).toBe(reading?.events.at(-1)?.seq);
  });

  it("survives a new instance over the same storage, as an evicted object does", async () => {
    const obj = await created();
    await obj.save(newSession("s1", iso(T0)), 0, [text("still here")]);
    const revived = object();
    expect(await revived.load()).toMatchObject({ id: "s1", version: 1 });
    expect((await revived.listEvents(10)).map((e) => e.content)).toEqual(["still here"]);
  });

  it("deletes everything, alarm included", async () => {
    const obj = await created();
    const ringing: Session = { ...newSession("s1", iso(T0)), call: { status: "ringing", attempts: 1, ringingAt: iso(T0) } };
    await obj.save(ringing, 0, [text("hi")], "st1");
    expect(storage.alarm).not.toBeNull();
    await obj.destroy();
    expect(await obj.load()).toBeNull();
    expect(await obj.listEvents(10)).toEqual([]);
    expect(await obj.hasOAuthState("st1")).toBe(false);
    expect(storage.alarm).toBeNull();
    expect(storage.tables()).toEqual([]);
  });
});

describe("session object turn lease", () => {
  it("lets one holder in at a time and frees it only for the holder's token", async () => {
    const obj = await created();
    const token = await obj.acquireTurnLease(20_000);
    expect(token).toEqual(expect.any(String));
    expect(await obj.acquireTurnLease(20_000)).toBeNull();

    await obj.releaseTurnLease("someone-else");
    expect(await obj.acquireTurnLease(20_000)).toBeNull();

    await obj.releaseTurnLease(token ?? "");
    expect(await obj.acquireTurnLease(20_000)).toEqual(expect.any(String));
  });

  it("expires a lease its holder never released, and the late holder can't free the next one", async () => {
    const obj = await created();
    const stale = await obj.acquireTurnLease(20_000);
    vi.setSystemTime(T0 + 19_999);
    expect(await obj.acquireTurnLease(20_000)).toBeNull();
    vi.setSystemTime(T0 + 20_001);
    const fresh = await obj.acquireTurnLease(20_000);
    expect(fresh).toEqual(expect.any(String));
    expect(fresh).not.toBe(stale);

    await obj.releaseTurnLease(stale ?? "");
    expect(await obj.acquireTurnLease(20_000)).toBeNull();
  });

  it("starts a turn only with the lease, writing nothing without it, and a save that names the lease frees it", async () => {
    const obj = await created();
    const turn = await obj.beginTurn(20_000, [text("hi", { clientMsgId: "m1" })], 10);
    if (!turn.lease) throw new Error("no lease");
    expect(turn.inserted.map((e) => e.content)).toEqual(["hi"]);
    expect(turn.history.map((e) => e.content)).toEqual(["hi"]);

    expect(await obj.beginTurn(20_000, [text("second tab", { clientMsgId: "m2" })], 10)).toEqual({ lease: null });
    expect((await obj.listEvents(10)).map((e) => e.content)).toEqual(["hi"]);

    await obj.save(turn.session, 0, [], undefined, { releaseLease: turn.lease });
    expect(await obj.acquireTurnLease(20_000)).toEqual(expect.any(String));
  });
});

describe("session object events", () => {
  it("numbers events in strictly increasing order and lists the latest ones oldest first", async () => {
    const obj = await created();
    await obj.appendEvents([text("a"), text("b")]);
    await obj.appendEvents([text("c")]);
    const all = await obj.listEvents(10);
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(3);
    expect((await obj.listEvents(2)).map((e) => e.content)).toEqual(["b", "c"]);
    expect(await obj.lastSeq()).toBe(seqs.at(-1));
    expect(new Set(all.map((e) => e.id)).size).toBe(3);
  });

  it("skips a message or tool call sent again with the same id, and numbering carries on after it", async () => {
    const obj = await created();
    const first = await obj.appendEvents([text("i'm preston", { clientMsgId: "m1" })]);
    expect(first).toHaveLength(1);
    expect(await obj.appendEvents([text("i'm preston", { clientMsgId: "m1" })])).toEqual([]);

    const tool = (ok: boolean): NewEvent => ({ channel: "voice", role: "tool", content: "send_gmail_link", toolCallId: "call_1", meta: { tool: { name: "send_gmail_link", args: {}, ok } } });
    expect(await obj.appendEvents([tool(true)])).toHaveLength(1);
    expect(await obj.appendEvents([tool(false)])).toEqual([]);

    const after = await obj.appendEvents([text("next", { clientMsgId: "m2" })]);
    const all = await obj.listEvents(10);
    expect(all.map((e) => e.content)).toEqual(["i'm preston", "send_gmail_link", "next"]);
    expect(all.find((e) => e.toolCallId === "call_1")?.meta?.tool?.ok).toBe(true);
    expect(after[0]?.seq).toBeGreaterThan(first[0]?.seq ?? Infinity);
    expect(after[0]?.seq).toBe(await obj.lastSeq());
  });

  it("keeps a message's fields through storage", async () => {
    const obj = await created();
    const at = iso(T0 - 1_000);
    const [saved] = await obj.appendEvents([{ channel: "text", role: "agent", content: "hey", at, meta: { kind: "greeting", quickReplies: ["a", "b"] } }]);
    expect(saved).toMatchObject({ at, channel: "text", role: "agent", content: "hey", meta: { kind: "greeting", quickReplies: ["a", "b"] } });
    expect(saved).not.toHaveProperty("clientMsgId");
    expect(saved).not.toHaveProperty("toolCallId");
  });
});

describe("session object gmail link states", () => {
  it("consumes a state once, and never after", async () => {
    const obj = await created();
    await obj.createOAuthState("st1", iso(T0));
    expect(await obj.hasOAuthState("st1")).toBe(true);
    expect(await obj.consumeOAuthState("st1", iso(T0 + 1_000), 60_000)).toBe(true);
    expect(await obj.consumeOAuthState("st1", iso(T0 + 2_000), 60_000)).toBe(false);
    // Used, but still known, so the start page can tell a used link from a made-up one.
    expect(await obj.hasOAuthState("st1")).toBe(true);
    expect(await obj.consumeOAuthState("missing", iso(T0), 60_000)).toBe(false);
  });

  it("refuses a state past its age limit", async () => {
    const obj = await created();
    await obj.createOAuthState("st1", iso(T0));
    expect(await obj.consumeOAuthState("st1", iso(T0 + 60_001), 60_000)).toBe(false);
    await obj.createOAuthState("st2", iso(T0));
    expect(await obj.consumeOAuthState("st2", iso(T0 + 60_000), 60_000)).toBe(true);
  });

  it("retires every earlier unused link when a save issues a fresh one", async () => {
    const obj = await created();
    const first = await obj.save({ ...newSession("s1", iso(T0)), updatedAt: iso(T0) }, 0, [], "st1");
    if (!first.ok) throw new Error("save failed");
    await obj.save({ ...first.session, updatedAt: iso(T0 + 1_000) }, 1, [], "st2");
    expect(await obj.consumeOAuthState("st1", iso(T0 + 2_000), 60_000)).toBe(false);
    expect(await obj.consumeOAuthState("st2", iso(T0 + 2_000), 60_000)).toBe(true);
  });

  it("says where a state stands without using it up", async () => {
    const obj = await created();
    await obj.createOAuthState("st1", iso(T0));
    expect(await obj.oauthStateStatus("st1", iso(T0 + 1_000), 60_000)).toBe("unused");
    expect(await obj.oauthStateStatus("st1", iso(T0 + 1_000), 60_000)).toBe("unused");
    expect(await obj.oauthStateStatus("st1", iso(T0 + 60_001), 60_000)).toBe("expired");
    expect(await obj.consumeOAuthState("st1", iso(T0 + 2_000), 60_000)).toBe(true);
    expect(await obj.oauthStateStatus("st1", iso(T0 + 3_000), 60_000)).toBe("used");
    expect(await obj.oauthStateStatus("missing", iso(T0), 60_000)).toBe("unknown");
    expect(stateStatus(undefined, iso(T0), 60_000)).toBe("unknown");
    expect(stateStatus({ created_at: iso(T0), used_at: iso(T0) }, iso(T0), 60_000)).toBe("used");
  });

  it("retires the old link for status too: a fresh link leaves the one before it used", async () => {
    const obj = await created();
    const first = await obj.save({ ...newSession("s1", iso(T0)), updatedAt: iso(T0) }, 0, [], "st1");
    if (!first.ok) throw new Error("save failed");
    await obj.save({ ...first.session, updatedAt: iso(T0 + 1_000) }, 1, [], "st2");
    expect(await obj.oauthStateStatus("st1", iso(T0 + 2_000), 60_000)).toBe("used");
    expect(await obj.oauthStateStatus("st2", iso(T0 + 2_000), 60_000)).toBe("unused");
  });

  it("issuing the same state twice does not reset its clock or its use", async () => {
    const obj = await created();
    await obj.createOAuthState("st1", iso(T0));
    expect(await obj.consumeOAuthState("st1", iso(T0 + 1_000), 60_000)).toBe(true);
    await obj.createOAuthState("st1", iso(T0 + 2_000));
    expect(await obj.consumeOAuthState("st1", iso(T0 + 3_000), 60_000)).toBe(false);
  });
});

describe("session object alarm", () => {
  const scheduled = (stopped: boolean): Session => {
    const base = newSession("s1", iso(T0));
    return {
      ...base,
      call: { status: "scheduled", attempts: 0, scheduledFor: iso(T0 + 60_000) },
      consent: stopped ? { stoppedAt: iso(T0) } : {},
    };
  };

  it("arms for a booked callback, and not at all once the session is stopped", async () => {
    const booked = await created();
    await booked.save(scheduled(false), 0);
    expect(storage.alarm).toBe(T0 + 60_000);

    storage = new FakeStorage();
    const stopped = await created();
    await stopped.save(scheduled(true), 0);
    noWakeBeforeRetention();
    expect(nextWake(scheduled(true), T0)).toBeNull();
  });

  it("arms for the earliest reminder still waiting, and never for one cancelled or sent, or while stopped", async () => {
    const reminder = (id: string, ms: number, done?: "sentAt" | "cancelledAt") => ({ id, at: iso(T0 + ms), what: id, setAt: iso(T0), ...(done && { [done]: iso(T0) }) });
    const base = newSession("s1", iso(T0));
    const waiting: Session = { ...base, reminders: [reminder("sent", 10_000, "sentAt"), reminder("gone", 20_000, "cancelledAt"), reminder("later", 90_000), reminder("soon", 60_000)] };
    const obj = await created();
    await obj.save(waiting, 0);
    expect(storage.alarm).toBe(T0 + 60_000);
    expect(nextWake({ ...waiting, consent: { stoppedAt: iso(T0) } }, T0)).toBeNull();
    expect(nextWake({ ...base, reminders: [reminder("gone", 20_000, "cancelledAt")] }, T0)).toBeNull();
  });

  it("does not re-arm for a stopped session with a booked call, whatever the app answers", async () => {
    env.CRON_SECRET = "test-secret";
    const obj = await created();
    await obj.save(scheduled(true), 0);

    await fire(obj);
    expect(env.WORKER_SELF_REFERENCE.fetch).toHaveBeenCalledWith(
      "https://self/api/cron/calls?session=s1",
      expect.objectContaining({ headers: { authorization: "Bearer test-secret" } }),
    );
    noWakeBeforeRetention();

    // A failed settle backs off off the session's own hint, which a stopped booking does not give.
    env.WORKER_SELF_REFERENCE.fetch.mockImplementation(async () => new Response("down", { status: 500 }));
    await fire(obj);
    noWakeBeforeRetention();
    env.WORKER_SELF_REFERENCE.fetch.mockImplementation(async () => {
      throw new Error("unreachable");
    });
    await fire(obj);
    noWakeBeforeRetention();
    expect(await obj.load()).toMatchObject({ call: { status: "scheduled" }, consent: { stoppedAt: iso(T0) } });
  });

  it("follows the app's next wake, never sooner than a second out, and backs off a live call when the app fails", async () => {
    env.CRON_SECRET = "test-secret";
    const obj = await created();
    await obj.save({ ...newSession("s1", iso(T0)), call: { status: "ringing", attempts: 1, ringingAt: iso(T0) } }, 0);

    env.WORKER_SELF_REFERENCE.fetch.mockImplementation(async () => Response.json({ wake: T0 + 30_000 }));
    await fire(obj);
    expect(storage.alarm).toBe(T0 + 30_000);

    env.WORKER_SELF_REFERENCE.fetch.mockImplementation(async () => Response.json({ wake: T0 - 5_000 }));
    await fire(obj);
    expect(storage.alarm).toBe(T0 + 1_000);

    env.WORKER_SELF_REFERENCE.fetch.mockImplementation(async () => new Response("down", { status: 500 }));
    await fire(obj);
    expect(storage.alarm).toBe(T0 + 10_000);
    await fire(obj);
    expect(storage.alarm).toBe(T0 + 20_000);
  });

  it("does nothing without the cron secret, since the app's route would not exist", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const obj = await created();
    await obj.save({ ...newSession("s1", iso(T0)), call: { status: "active", attempts: 1, startedAt: iso(T0) } }, 0);
    await fire(obj);
    expect(env.WORKER_SELF_REFERENCE.fetch).not.toHaveBeenCalled();
    noWakeBeforeRetention();
    error.mockRestore();
  });
});

describe("session object retention", () => {
  const DAY_MS = 24 * 60 * 60_000;

  it("keeps a session its alarm finds inside retention, and deletes it, archive copy and all, once retention runs out", async () => {
    const obj = await created();
    await obj.appendEvents([text("hi")]);
    expect(storage.alarm).toBe(T0 + RETENTION_MS);

    vi.setSystemTime(T0 + RETENTION_MS - 1);
    await fire(obj);
    expect(await obj.load()).toMatchObject({ id: "s1" });
    expect(storage.alarm).toBe(T0 + RETENTION_MS);

    vi.setSystemTime(T0 + RETENTION_MS);
    await fire(obj);
    expect(await obj.load()).toBeNull();
    expect(storage.tables()).toEqual([]);
    expect(storage.alarm).toBeNull();
  });

  it("has the app hand the Google sign-in back to Google before a session past its retention is deleted", async () => {
    env.CRON_SECRET = "secret";
    const obj = await created();
    await obj.setGoogleGrant("sealed");
    env.WORKER_SELF_REFERENCE.fetch.mockImplementation(async () => {
      // The app's revoke deletes the sign-in through the object, while the object still exists.
      expect(await obj.load()).toMatchObject({ id: "s1" });
      await obj.setGoogleGrant(null);
      return Response.json({ revoked: true });
    });

    vi.setSystemTime(T0 + RETENTION_MS);
    await fire(obj);
    expect(env.WORKER_SELF_REFERENCE.fetch).toHaveBeenCalledWith("https://self/api/cron/revoke?session=s1", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    expect(await obj.load()).toBeNull();
    expect(storage.tables()).toEqual([]);
  });

  it("asks again when the app can't be reached, and deletes the session anyway once the tries run out", async () => {
    env.CRON_SECRET = "secret";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const obj = await created();
    await obj.setGoogleGrant("sealed");
    env.WORKER_SELF_REFERENCE.fetch.mockRejectedValue(new Error("down"));

    vi.setSystemTime(T0 + RETENTION_MS);
    for (let tries = 1; tries < REVOKE_TRIES; tries++) {
      await fire(obj);
      expect(await obj.load()).toMatchObject({ id: "s1" });
      expect(storage.alarm).toBe(Date.now() + 30_000);
    }
    await fire(obj);
    expect(env.WORKER_SELF_REFERENCE.fetch).toHaveBeenCalledTimes(REVOKE_TRIES);
    expect(await obj.load()).toBeNull();
    error.mockRestore();
  });

  it("deletes a session with no Google sign-in without asking the app", async () => {
    env.CRON_SECRET = "secret";
    const obj = await created();
    vi.setSystemTime(T0 + RETENTION_MS);
    await fire(obj);
    expect(env.WORKER_SELF_REFERENCE.fetch).not.toHaveBeenCalled();
    expect(await obj.load()).toBeNull();
  });

  it("restarts the clock on every write, so an alarm set before it moves out instead of deleting", async () => {
    const obj = await created();
    vi.setSystemTime(T0 + 10 * DAY_MS);
    await obj.appendEvents([text("still here")]);
    vi.setSystemTime(T0 + RETENTION_MS);
    await fire(obj);
    expect((await obj.listEvents(10)).map((e) => e.content)).toEqual(["still here"]);
    expect(storage.alarm).toBe(T0 + 10 * DAY_MS + RETENTION_MS);
  });

  it("dates a session written before the stamp by its last save, and one it can't date as active now", () => {
    const session = { ...newSession("s1", iso(T0)), updatedAt: iso(T0 - DAY_MS) };
    expect(lastActive(String(T0), session, T0 + 5)).toBe(T0);
    expect(lastActive(null, session, T0 + 5)).toBe(T0 - DAY_MS);
    expect(lastActive("garbage", { ...session, updatedAt: "never" }, T0 + 5)).toBe(T0 + 5);
    expect(expired(T0, T0 + RETENTION_MS - 1)).toBe(false);
    expect(expired(T0, T0 + RETENTION_MS)).toBe(true);
  });
});

describe("session object rate limit", () => {
  it("counts a session's hits in a sliding window", async () => {
    const obj = await created();
    expect(await obj.take("turn", 2, 60_000, T0)).toBe(true);
    expect(await obj.take("turn", 2, 60_000, T0 + 1)).toBe(true);
    expect(await obj.take("turn", 2, 60_000, T0 + 2)).toBe(false);
    expect(await obj.take("other", 2, 60_000, T0 + 2)).toBe(true);
    expect(await obj.take("turn", 2, 60_000, T0 + 60_001)).toBe(true);
  });
});
