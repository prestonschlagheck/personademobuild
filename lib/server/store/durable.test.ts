import { afterEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "@/lib/session/schema";

vi.mock("server-only", () => ({}));
// The Workers runtime is not here; the object's pure helpers and the store's calls into it are what is tested.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

// One stub per session object, standing in for `env.SESSIONS.getByName(id)`.
const objects = new Map<string, { oauthStateStatus: ReturnType<typeof vi.fn> }>();
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      SESSIONS: {
        getByName: (id: string) => {
          const object = objects.get(id) ?? { oauthStateStatus: vi.fn(async () => "unused") };
          objects.set(id, object);
          return object;
        },
      },
    },
  }),
}));

const { createDurableStore } = await import("@/lib/server/store/durable");
const { RETENTION_MS, expired, lastActive, stateStatus } = await import("@/worker/session-object");

const NOW = "2026-09-27T01:00:00.000Z";
const DAY_MS = 86_400_000;

afterEach(() => objects.clear());

describe("durable store oauthStateStatus", () => {
  it("asks only the browser's own session object, and knows nothing without one", async () => {
    const store = createDurableStore();
    expect(await store.oauthStateStatus("st1", NOW, 60_000, "s1")).toBe("unused");
    expect(objects.get("s1")?.oauthStateStatus).toHaveBeenCalledWith("st1", NOW, 60_000);
    expect(await store.oauthStateStatus("st1", NOW, 60_000)).toBe("unknown");
    expect([...objects.keys()]).toEqual(["s1"]);
  });

  it("passes the object's answer through", async () => {
    objects.set("s2", { oauthStateStatus: vi.fn(async () => "used") });
    expect(await createDurableStore().oauthStateStatus("st1", NOW, 60_000, "s2")).toBe("used");
  });
});

describe("the session object's link states", () => {
  const row = (created: string, used: string | null = null) => ({ created_at: created, used_at: used });

  it("answers what consuming would find: unused, used, expired or unknown", () => {
    expect(stateStatus(row(NOW), NOW, 60_000)).toBe("unused");
    expect(stateStatus(row(NOW, NOW), NOW, 60_000)).toBe("used");
    expect(stateStatus(row("2026-09-27T00:58:59.000Z"), NOW, 60_000)).toBe("expired");
    expect(stateStatus(row("2026-09-27T00:59:00.000Z"), NOW, 60_000)).toBe("unused");
    expect(stateStatus(undefined, NOW, 60_000)).toBe("unknown");
    // Used wins over expired, so a finished link is always "already worked".
    expect(stateStatus(row("2026-09-20T00:00:00.000Z", NOW), NOW, 60_000)).toBe("used");
  });
});

describe("the session object's retention", () => {
  const session: Session = { ...newSession("s1", NOW), updatedAt: NOW };
  const now = Date.parse(NOW);

  it("keeps a session for 30 days after its last write, the cookie's lifetime", () => {
    expect(RETENTION_MS).toBe(30 * DAY_MS);
    expect(expired(now, now + 30 * DAY_MS - 1)).toBe(false);
    expect(expired(now, now + 30 * DAY_MS)).toBe(true);
    expect(expired(now, now)).toBe(false);
  });

  it("reads the last write from the stamp every write leaves, else the last save, else takes it as active now", () => {
    expect(lastActive(String(now + 5 * DAY_MS), session, now)).toBe(now + 5 * DAY_MS);
    expect(lastActive(null, session, now + DAY_MS)).toBe(now);
    expect(lastActive("not a number", session, now + DAY_MS)).toBe(now);
    expect(lastActive(null, { ...session, updatedAt: "garbage" }, now + 40 * DAY_MS)).toBe(now + 40 * DAY_MS);
  });

  it("never deletes a session written since it was last looked at", () => {
    const stamp = String(now + 29 * DAY_MS);
    // The alarm set by the first write fires 30 days after it, but the later write moved the clock.
    expect(expired(lastActive(stamp, session, now + 30 * DAY_MS), now + 30 * DAY_MS)).toBe(false);
    expect(expired(lastActive(stamp, session, now + 59 * DAY_MS), now + 59 * DAY_MS)).toBe(true);
  });
});
