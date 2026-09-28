import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSession } from "@/lib/session/schema";
import type { Store } from "@/lib/server/store/types";

vi.mock("server-only", () => ({}));

const { createMemoryStore } = await import("@/lib/server/store/memory");

const NOW = "2026-09-27T01:00:00.000Z";
let store: Store;

beforeEach(async () => {
  store = createMemoryStore();
  await store.create(newSession("s1", NOW));
});

describe("memory store", () => {
  it("saves with compare-and-set and bumps the version", async () => {
    const loaded = await store.load("s1");
    if (!loaded) throw new Error("missing session");
    const first = await store.save({ ...loaded, graduated: true }, 0);
    expect(first).toMatchObject({ ok: true, session: { version: 1, graduated: true } });
    expect(await store.save({ ...loaded, graduated: false }, 0)).toEqual({ ok: false, conflict: true });
    expect((await store.load("s1"))?.graduated).toBe(true);
  });

  it("saves a change's events and OAuth state with it, and none of them on a conflict", async () => {
    const loaded = await store.load("s1");
    if (!loaded) throw new Error("missing session");
    const link = { channel: "text", role: "agent", content: "here's the link", at: NOW } as const;
    const saved = await store.save({ ...loaded, updatedAt: NOW }, 0, { events: [link], oauthState: "st1" });
    expect(saved).toMatchObject({ ok: true, session: { version: 1 }, events: [{ seq: 1, content: "here's the link" }] });
    expect(await store.oauthStateOwner("st1")).toBe("s1");

    expect(await store.save(loaded, 0, { events: [{ ...link, content: "stale" }], oauthState: "st2" })).toEqual({ ok: false, conflict: true });
    expect((await store.listEvents("s1", 10)).map((e) => e.content)).toEqual(["here's the link"]);
    expect(await store.oauthStateOwner("st2")).toBeNull();
    expect(await store.consumeOAuthState("st1", NOW, 60_000)).toBe("s1");
  });

  it("retires a session's earlier unused states when a change issues a new one", async () => {
    const loaded = await store.load("s1");
    if (!loaded) throw new Error("missing session");
    const first = await store.save({ ...loaded, updatedAt: NOW }, 0, { oauthState: "st1" });
    if (!first.ok) throw new Error("save failed");
    await store.save(first.session, 1, { oauthState: "st2" });
    expect(await store.consumeOAuthState("st1", NOW, 60_000)).toBeNull();
    expect(await store.consumeOAuthState("st2", NOW, 60_000)).toBe("s1");
  });

  it("names a state's owner without consuming it", async () => {
    await store.createOAuthState("st1", "s1", NOW);
    expect(await store.oauthStateOwner("st1")).toBe("s1");
    expect(await store.oauthStateOwner("st1")).toBe("s1");
    expect(await store.oauthStateOwner("missing")).toBeNull();
    expect(await store.consumeOAuthState("st1", NOW, 60_000)).toBe("s1");
  });

  it("hands out copies, never its own state", async () => {
    const loaded = await store.load("s1");
    if (!loaded) throw new Error("missing session");
    loaded.steering.skipped.push("gmail");
    expect((await store.load("s1"))?.steering.skipped).toEqual([]);
  });

  it("appends in order and skips duplicate message and tool ids", async () => {
    const first = await store.appendEvents("s1", [
      { channel: "text", role: "user", content: "hi", clientMsgId: "m1" },
      { channel: "text", role: "user", content: "hi again", clientMsgId: "m1" },
      { channel: "system", role: "tool", content: "get_state", toolCallId: "c1" },
    ]);
    expect(first.map((e) => e.content)).toEqual(["hi", "get_state"]);
    expect(await store.appendEvents("s1", [{ channel: "system", role: "tool", content: "get_state", toolCallId: "c1" }])).toEqual([]);
    const listed = await store.listEvents("s1", 10);
    expect(listed.map((e) => e.seq)).toEqual([1, 2]);
    expect(await store.lastSeq("s1")).toBe(2);
    expect((await store.listEvents("s1", 1)).map((e) => e.content)).toEqual(["get_state"]);
  });

  it("holds the turn lease exclusively until released or expired", async () => {
    const first = await store.acquireTurnLease("s1", 20_000);
    expect(first).toEqual(expect.any(String));
    expect(await store.acquireTurnLease("s1", 20_000)).toBeNull();
    await store.releaseTurnLease("s1", first ?? "");
    const expired = await store.acquireTurnLease("s1", -1);
    const next = await store.acquireTurnLease("s1", 20_000);
    expect(next).toEqual(expect.any(String));
    // A turn that outlived its lease cannot free the newer holder's.
    await store.releaseTurnLease("s1", expired ?? "");
    expect(await store.acquireTurnLease("s1", 20_000)).toBeNull();
  });

  it("consumes an OAuth state once, within its age limit", async () => {
    await store.createOAuthState("st1", "s1", NOW);
    expect(await store.consumeOAuthState("st1", NOW, 60_000)).toBe("s1");
    expect(await store.consumeOAuthState("st1", NOW, 60_000)).toBeNull();
    await store.createOAuthState("st2", "s1", NOW);
    expect(await store.consumeOAuthState("st2", "2026-09-27T02:00:00.000Z", 60_000)).toBeNull();
  });

  it("tells where an OAuth state stands without consuming it", async () => {
    await store.create(newSession("s2", NOW));
    await store.createOAuthState("st1", "s1", NOW);
    expect(await store.oauthStateStatus("st1", NOW, 60_000, "s1")).toBe("unused");
    expect(await store.oauthStateStatus("st1", NOW, 60_000, "s1")).toBe("unused");
    expect(await store.oauthStateStatus("st1", NOW, 60_000)).toBe("unused");
    expect(await store.oauthStateStatus("st1", "2026-09-27T02:00:00.000Z", 60_000, "s1")).toBe("expired");
    // Another session's browser, and a state never issued, learn nothing about it.
    expect(await store.oauthStateStatus("st1", NOW, 60_000, "s2")).toBe("unknown");
    expect(await store.oauthStateStatus("missing", NOW, 60_000, "s1")).toBe("unknown");
    expect(await store.consumeOAuthState("st1", NOW, 60_000)).toBe("s1");
    expect(await store.oauthStateStatus("st1", NOW, 60_000, "s1")).toBe("used");
  });

  it("calls a state used once a newer link replaces it, and unknown once its session is gone", async () => {
    const loaded = await store.load("s1");
    if (!loaded) throw new Error("missing session");
    const first = await store.save({ ...loaded, updatedAt: NOW }, 0, { oauthState: "st1" });
    if (!first.ok) throw new Error("save failed");
    await store.save(first.session, 1, { oauthState: "st2" });
    expect(await store.oauthStateStatus("st1", NOW, 60_000, "s1")).toBe("used");
    expect(await store.oauthStateStatus("st2", NOW, 60_000, "s1")).toBe("unused");
    await store.delete("s1");
    expect(await store.oauthStateStatus("st2", NOW, 60_000, "s1")).toBe("unknown");
  });

  it("keeps the call heartbeat outside versioned state", async () => {
    await store.touchCall("s1", NOW);
    expect(await store.callLastSeen("s1")).toBe(NOW);
    expect((await store.load("s1"))?.version).toBe(0);
  });

  it("deletes the session with its events and OAuth states", async () => {
    await store.appendEvents("s1", [{ channel: "text", role: "user", content: "hi" }]);
    await store.createOAuthState("st1", "s1", NOW);
    await store.delete("s1");
    expect(await store.load("s1")).toBeNull();
    expect(await store.listEvents("s1", 10)).toEqual([]);
    expect(await store.consumeOAuthState("st1", NOW, 60_000)).toBeNull();
  });

  it("reads the session, its latest events, the last sequence number and the heartbeat in one call", async () => {
    await store.appendEvents("s1", [{ channel: "text", role: "user", content: "a" }, { channel: "text", role: "user", content: "b" }]);
    await store.touchCall("s1", NOW);
    const reading = await store.read("s1", 1);
    expect(reading).toMatchObject({ session: { id: "s1" }, lastSeq: 2, callLastSeen: NOW });
    expect(reading?.events.map((e) => e.content)).toEqual(["b"]);
    expect(await store.read("missing", 10)).toBeNull();
  });

  it("starts a turn with the lease, the messages and the history, and writes nothing while the lease is held", async () => {
    const start = await store.beginTurn("s1", 60_000, [{ channel: "text", role: "user", content: "hi", clientMsgId: "m1" }], 10);
    if (!start.lease) throw new Error("expected the lease");
    expect(start.inserted.map((e) => e.content)).toEqual(["hi"]);
    expect(start.history.map((e) => e.content)).toEqual(["hi"]);
    expect(await store.beginTurn("s1", 60_000, [{ channel: "text", role: "user", content: "again", clientMsgId: "m2" }], 10)).toEqual({ lease: null });
    expect((await store.listEvents("s1", 10)).map((e) => e.content)).toEqual(["hi"]);
    expect(await store.beginTurn("missing", 60_000, [], 10)).toEqual({ lease: null });
  });

  it("releases the lease and hands back the thread with the save that ends a turn", async () => {
    const start = await store.beginTurn("s1", 60_000, [{ channel: "text", role: "user", content: "hi" }], 10);
    if (!start.lease) throw new Error("expected the lease");
    const reply = { channel: "text", role: "agent", content: "hey" } as const;
    const saved = await store.save({ ...start.session, graduated: true }, 0, { events: [reply], releaseLease: start.lease, recent: 10 });
    expect(saved.ok && saved.recent?.map((e) => e.content)).toEqual(["hi", "hey"]);
    expect(await store.acquireTurnLease("s1", 60_000)).not.toBeNull();
  });
});
