import { afterEach, describe, expect, it, vi } from "vitest";
import { newSession, type NewEvent, type Session } from "@/lib/session/schema";

vi.mock("server-only", () => ({}));

const { disconnectGoogle, disconnectRows, REVOKE_FAILED } = await import("@/lib/gmail/disconnect");
const { isGoogleTool, googleToolSpecs, runGoogleTool } = await import("@/lib/gmail/tools");
const { loadGrant, revokeGrant, saveGrant } = await import("@/lib/gmail/grant");
const { getStore } = await import("@/lib/server/store");
const { POST } = await import("@/app/api/cron/revoke/route");

const NOW = new Date().toISOString();
const REVOKE = "https://oauth2.googleapis.com/revoke";

/** A session with a Google sign-in stored: a real-looking one unless `token` names a fixture. */
async function withGrant(gmail: Session["gmail"], token = "ya29.live"): Promise<string> {
  const id = crypto.randomUUID();
  await getStore().create({ ...newSession(id, NOW), gmail });
  await saveGrant(id, { accessToken: token, refreshToken: token.startsWith("mock:") ? undefined : "1//refresh", expiresAt: Number.MAX_SAFE_INTEGER, email: "p@gmail.com", scopes: [] });
  return id;
}
const connected: Session["gmail"] = { status: "connected", email: "p@gmail.com", connectedAt: NOW, valueFact: "3 bills are due.", calendarFact: "2 events tomorrow." };

/** Google's revoke endpoint, answering `respond`, which also sees the session as it stood when the revoke went out. */
function google(respond: (seen: Session | null) => Response | Promise<Response>, id: () => string) {
  const calls: { url: string; body: string }[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return respond(await getStore().load(id()));
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("disconnect_google on the live runtimes", () => {
  it("is run like a lookup, so the model hears the result, but is offered with the session's tools", () => {
    expect(isGoogleTool("disconnect_google")).toBe(true);
    expect(googleToolSpecs().map((spec) => spec.name)).not.toContain("disconnect_google");
  });

  it("saves the disconnect first, then revokes at Google and deletes the sign-in, and reports it went back", async () => {
    let id = "";
    let seen: Session["gmail"]["status"] | undefined;
    const calls = google((session) => ((seen = session?.gmail.status), new Response(null, { status: 200 })), () => id);
    id = await withGrant(connected);

    const out = await runGoogleTool("disconnect_google", {}, { sessionId: id, session: newSession(id, NOW), lastHeardAt: null, heard: null });
    expect(out).toMatchObject({ ok: true, result: expect.stringContaining("disconnected") });
    expect(seen).toBe("disconnected");
    expect(calls).toEqual([{ url: REVOKE, body: "token=1%2F%2Frefresh" }]);
    expect(await getStore().googleGrant(id)).toBeNull();
    expect((await getStore().load(id))?.gmail).toEqual({ status: "disconnected" });
    // The runtime writes the tool's row with the result, so the disconnect itself adds none.
    expect(await getStore().listEvents(id, 10)).toEqual([]);
  });

  it("says honestly that Google didn't confirm when it can't be reached, and still forgets the sign-in", async () => {
    let id = "";
    google(() => Promise.reject(new Error("offline")), () => id);
    id = await withGrant(connected);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await disconnectGoogle(id);
    expect(out).toMatchObject({ ok: false, error: REVOKE_FAILED });
    expect(out.hint).toMatch(/never that google access is gone/);
    expect(out.hint).toMatch(/third-party connections in their google account/);
    expect(await loadGrant(id)).toBeNull();
    expect((await getStore().load(id))?.gmail.status).toBe("disconnected");
  });

  it("counts a token Google already calls invalid as handed back", async () => {
    let id = "";
    google(() => Response.json({ error: "invalid_token" }, { status: 400 }), () => id);
    id = await withGrant(connected);
    expect((await disconnectGoogle(id)).ok).toBe(true);
  });

  it("is refused with nothing connected and no sign-in stored, and then asks Google for nothing", async () => {
    let id = "";
    const calls = google(() => new Response(null, { status: 200 }), () => id);
    id = crypto.randomUUID();
    await getStore().create({ ...newSession(id, NOW), gmail: { status: "link_sent", linkSentAt: NOW } });

    expect(await disconnectGoogle(id)).toMatchObject({ ok: false, error: "not_connected" });
    expect(calls).toEqual([]);
    expect((await getStore().load(id))?.gmail.status).toBe("link_sent");
  });

  it("still disconnects a sign-in stored for a session that doesn't say connected", async () => {
    let id = "";
    google(() => new Response(null, { status: 200 }), () => id);
    id = await withGrant({ status: "link_sent", linkSentAt: NOW });
    expect((await disconnectGoogle(id)).ok).toBe(true);
    expect(await getStore().googleGrant(id)).toBeNull();
  });

  it("hands a fixture sign-in back without calling Google", async () => {
    const calls = google(() => new Response(null, { status: 500 }), () => "");
    const id = await withGrant(connected, "mock:inbox");
    expect(await revokeGrant(id)).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("a disconnect the mock brain made", () => {
  const row: NewEvent = { channel: "system", role: "tool", content: "disconnect_google", meta: { kind: "tool_call", tool: { name: "disconnect_google", args: {}, ok: true } } };

  it("records the revoke's result on its row, and says only that", () => {
    const [done, line] = disconnectRows([row], true, "en");
    expect(done?.meta?.tool).toEqual({ name: "disconnect_google", args: {}, ok: true });
    expect(line).toMatchObject({ channel: "text", role: "agent", content: expect.stringContaining("disconnected") });

    const [failed, honest] = disconnectRows([row], false, undefined);
    expect(failed?.meta?.tool).toEqual({ name: "disconnect_google", args: {}, ok: false, error: REVOKE_FAILED });
    expect(honest?.content).toMatch(/google didn't answer/);
    expect(honest?.content).toMatch(/third-party connections/);
    expect(honest?.content).not.toMatch(/disconnected/);
    expect(disconnectRows([row], true, "es")[1]?.content).toMatch(/desconectado/);
  });
});

describe("the revoke a session's expiry asks for", () => {
  const ask = (id: string, secret = "s3cret") =>
    POST(new Request(`http://self/api/cron/revoke?session=${id}`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }));
  afterEach(() => vi.unstubAllEnvs());

  it("does not exist without the shared secret, and hands the sign-in back with it", async () => {
    let id = "";
    const calls = google(() => new Response(null, { status: 200 }), () => id);
    id = await withGrant(connected);
    expect((await ask(id)).status).toBe(404);
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await ask(id, "wrong!")).status).toBe(404);
    expect((await ask("not-a-session")).status).toBe(400);

    const res = await ask(id);
    expect(await res.json()).toEqual({ revoked: true });
    expect(calls.map((c) => c.url)).toEqual([REVOKE]);
    expect(await getStore().googleGrant(id)).toBeNull();
  });
});
