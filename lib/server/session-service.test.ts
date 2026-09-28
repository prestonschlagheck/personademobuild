import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "@/lib/session/schema";
import { mockTextAgent } from "@/lib/agent/text-agent";

vi.mock("server-only", () => ({}));
// Turns are rate limited by address and Gmail links are checked against the session cookie; neither exists outside a route.
vi.mock("@/lib/server/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/http")>()),
  clientIp: async () => "127.0.0.1",
}));
let cookieSession: string | null = null;
vi.mock("@/lib/server/cookie", () => ({ readSessionId: async () => cookieSession, writeSessionId: async () => undefined }));

const { applyTools, readSnapshot, takeTurn } = await import("@/lib/server/session-service");
const { getStore } = await import("@/lib/server/store");
const { BASE_SCOPES, gmailScope } = await import("@/lib/gmail/oauth");
const { loadGrant, saveGrant } = await import("@/lib/gmail/grant");
const callback = await import("@/app/api/oauth/google/callback/route");
const start = await import("@/app/api/oauth/google/start/route");

const ORIGIN = "http://localhost:3000";

async function named(id: string): Promise<Session> {
  const now = new Date().toISOString();
  const session: Session = {
    ...newSession(id, now),
    agentName: { value: "Jarvis", source: "text", setAt: now },
    consent: { termsShownAt: now },
  };
  await getStore().create(session);
  return session;
}

const agentTexts = async (id: string) => (await getStore().listEvents(id, 100)).filter((e) => e.channel === "text" && e.role === "agent");
const stateOf = (url: string | undefined) => (url ? new URL(url).searchParams.get("state") : null);

async function sendLink(id: string) {
  const { snapshot } = await applyTools(id, { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: {} }]);
  const card = snapshot.events.findLast((e) => e.meta?.kind === "gmail_link");
  return { card, state: stateOf(card?.meta?.link?.url) };
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GOOGLE_CLIENT_ID", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("saving a change", () => {
  it("writes the Gmail link's card and state with the session, in one write", async () => {
    await named("commit-link");
    const store = getStore();
    // Neither a separate append nor a separate state insert is on the path, so neither failing can lose the link.
    vi.spyOn(store, "appendEvents").mockRejectedValue(new Error("append down"));
    vi.spyOn(store, "createOAuthState").mockRejectedValue(new Error("insert down"));

    const { card, state } = await sendLink("commit-link");
    expect(card?.content).toContain("/api/oauth/google/start?state=");
    expect(state && (await store.oauthStateOwner(state))).toBe("commit-link");
    expect((await store.load("commit-link"))?.gmail.status).toBe("link_sent");
  });

  it("leaves nothing half written when the save fails, so the next request starts clean", async () => {
    await named("commit-fail");
    const store = getStore();
    vi.spyOn(store, "save").mockRejectedValueOnce(new Error("save down"));
    await expect(sendLink("commit-fail")).rejects.toThrow("save down");
    expect((await store.load("commit-fail"))?.gmail.status).toBe("not_started");
    expect(await agentTexts("commit-fail")).toEqual([]);

    const { state } = await sendLink("commit-fail");
    expect(state && (await store.oauthStateOwner(state))).toBe("commit-fail");
    expect((await agentTexts("commit-fail")).map((e) => e.meta?.kind)).toEqual(["gmail_link"]);
  });
});

describe("retrying a turn that failed after storing its messages", () => {
  const msg = (text: string) => ({ clientMsgId: crypto.randomUUID(), text });

  it("answers the stored message exactly once", async () => {
    await named("turn-retry");
    const respond = vi.spyOn(mockTextAgent, "respond");
    respond.mockRejectedValueOnce(new Error("agent down"));
    const first = msg("call me preston");

    await expect(takeTurn("turn-retry", [first], ORIGIN)).rejects.toThrow("agent down");
    const stored = await getStore().listEvents("turn-retry", 100);
    expect(stored.filter((e) => e.clientMsgId === first.clientMsgId)).toHaveLength(1);
    expect(await agentTexts("turn-retry")).toEqual([]);

    await takeTurn("turn-retry", [first], ORIGIN);
    const answered = (await agentTexts("turn-retry")).length;
    expect(answered).toBeGreaterThan(0);
    expect(respond.mock.lastCall?.[1]).toEqual(["call me preston"]);

    await takeTurn("turn-retry", [first], ORIGIN);
    expect(respond).toHaveBeenCalledTimes(2);
    expect(await agentTexts("turn-retry")).toHaveLength(answered);
  });

  it("answers a stored message and a new one together when the retry carries both", async () => {
    await named("turn-mixed");
    const respond = vi.spyOn(mockTextAgent, "respond");
    respond.mockRejectedValueOnce(new Error("agent down"));
    const first = msg("call me preston");
    const second = msg("and i want help with my inbox");

    await expect(takeTurn("turn-mixed", [first], ORIGIN)).rejects.toThrow("agent down");
    await takeTurn("turn-mixed", [first, second], ORIGIN);
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.lastCall?.[1]).toEqual(["call me preston", "and i want help with my inbox"]);
  });
});

describe("a text turn", () => {
  it("keeps the language they text in, so the next call opens in it", async () => {
    await named("turn-lang");
    const message = (text: string) => ({ clientMsgId: crypto.randomUUID(), text });
    expect((await takeTurn("turn-lang", [message("hola, necesito ayuda con mis correos")], ORIGIN)).session.lang).toBe("es");
    expect((await takeTurn("turn-lang", [message("ok back to english please")], ORIGIN)).session.lang).toBe("en");
  });
});

describe("stop", () => {
  const stop = (id: string) => takeTurn(id, [{ clientMsgId: crypto.randomUUID(), text: "stop" }], ORIGIN);

  it("cancels a ringing call and drops a booked one, so nothing rings after it", async () => {
    const ringing = await named("stop-ringing");
    await getStore().save({ ...ringing, call: { status: "ringing", attempts: 1, initiator: "agent", ringingAt: ringing.createdAt } }, ringing.version);
    const rung = await stop("stop-ringing");
    expect(rung.session.consent.stoppedAt).toBeDefined();
    expect(rung.session.call.status).toBe("declined");
    expect(rung.events.slice(-2).map((e) => [e.meta?.kind, e.content])).toEqual([
      ["call_declined", "cancelled"],
      ["stopped", "got it, i'll stop here. text start to pick back up, or delete everything to wipe your data."],
    ]);

    const booked = await named("stop-booked");
    const at = new Date(Date.now() + 10 * 60_000).toISOString();
    await getStore().save({ ...booked, call: { status: "scheduled", attempts: 0, scheduledFor: at } }, booked.version);
    const dropped = await stop("stop-booked");
    expect(dropped.session.call.status).toBe("offered");
    expect(dropped.session.call.scheduledFor).toBeUndefined();
  });

  it("ends a live call through the same end step, with the stop line as the only text", async () => {
    const live = await named("stop-live");
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    await getStore().save({ ...live, call: { status: "active", attempts: 1, initiator: "agent", startedAt, activeCallId: "mock_1" } }, live.version);
    const ended = await stop("stop-live");
    expect(ended.session.call).toMatchObject({ status: "ended", lastEndReason: "user_hangup" });
    expect(ended.session.call.activeCallId).toBeUndefined();
    const after = ended.events.slice(-2);
    expect(after.map((e) => e.meta?.kind)).toEqual(["call_ended", "stopped"]);
    expect((await agentTexts("stop-live")).map((e) => e.meta?.kind)).toEqual(["stopped"]);
  });

  it("cancels every reminder still waiting, and start leaves them cancelled", async () => {
    const s = await named("stop-reminders");
    const at = new Date(Date.now() + 60_000).toISOString();
    await getStore().save({ ...s, reminders: [{ id: "r1", at, what: "stretch", setAt: s.createdAt }] }, s.version);
    const stopped = await stop("stop-reminders");
    const cancelledAt = stopped.session.reminders?.[0]?.cancelledAt;
    expect(cancelledAt).toBeDefined();
    const resumed = await takeTurn("stop-reminders", [{ clientMsgId: crypto.randomUUID(), text: "start" }], ORIGIN);
    expect(resumed.session.consent.stoppedAt).toBeUndefined();
    expect(resumed.session.reminders).toEqual([{ id: "r1", at, what: "stretch", setAt: s.createdAt, cancelledAt }]);
  });
});

describe("reminders", () => {
  it("texts a due reminder once, from the read that finds it due", async () => {
    const s = await named("reminder-due");
    const at = new Date(Date.now() - 1_000).toISOString();
    await getStore().save({ ...s, reminders: [{ id: "r1", at, what: "Stretch", setAt: s.createdAt }] }, s.version);
    await readSnapshot("reminder-due");
    await readSnapshot("reminder-due");
    expect((await agentTexts("reminder-due")).map((e) => [e.meta?.kind, e.content])).toEqual([["reminder", "quick reminder: stretch."]]);
  });
});

describe("a Gmail link opened in another browser", () => {
  const open = (route: typeof start | typeof callback, path: string, params: Record<string, string>) =>
    route.GET(new NextRequest(`${ORIGIN}${path}?${new URLSearchParams(params)}`));
  const signIn = (state: string) => ({ state, code: "mock.inbox", scope: `${BASE_SCOPES} ${gmailScope()}` });

  it("is refused there without using up the owner's link", async () => {
    await named("link-owner");
    await named("link-other");
    const { state } = await sendLink("link-owner");
    if (!state) throw new Error("no state in the link");

    cookieSession = "link-other";
    const elsewhere = await open(start, "/api/oauth/google/start", { state });
    expect(elsewhere.headers.get("location")).toContain("result=expired");
    const forged = await open(callback, "/api/oauth/google/callback", signIn(state));
    expect(forged.headers.get("location")).toContain("result=expired");
    expect((await getStore().load("link-owner"))?.gmail.status).toBe("link_sent");

    cookieSession = "link-owner";
    expect((await open(start, "/api/oauth/google/start", { state })).headers.get("location")).toContain("/connect/mock?state=");
    const own = await open(callback, "/api/oauth/google/callback", signIn(state));
    expect(own.headers.get("location")).toContain("result=connected");
    expect((await getStore().load("link-owner"))?.gmail.status).toBe("connected");
  });
});

describe("handing Google access back", () => {
  const REVOKE = "https://oauth2.googleapis.com/revoke";
  const connected = (id: string, gmail: Partial<Session["gmail"]> = {}) =>
    named(id).then(async (session) => {
      await getStore().save({ ...session, gmail: { status: "connected", email: "wrong@gmail.com", connectedAt: session.createdAt, valueFact: "x", ...gmail } }, 0);
      await saveGrant(id, { accessToken: "ya29.old", refreshToken: "1//old", expiresAt: Number.MAX_SAFE_INTEGER, email: "wrong@gmail.com", scopes: [] });
    });
  /** Google's revoke endpoint, which also records how the session stood when the revoke went out. */
  function google(id: string, answer: () => Promise<Response>) {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url) !== REVOKE) throw new Error(`unexpected fetch ${String(url)}`);
        seen.push(`${(await getStore().load(id))?.gmail.status}:${String(init?.body)}`);
        return answer();
      }),
    );
    return seen;
  }
  const ok = async () => new Response(null, { status: 200 });
  afterEach(() => vi.unstubAllGlobals());

  it("revokes and deletes the wrong account's sign-in as soon as its new link is saved", async () => {
    await connected("wrong-account");
    const seen = google("wrong-account", ok);
    await applyTools("wrong-account", { runtime: "voice", origin: ORIGIN }, [{ name: "send_gmail_link", args: { fresh: true, reason: "wrong_account" } }]);
    expect(seen).toEqual(["link_sent:token=1%2F%2Fold"]);
    expect(await getStore().googleGrant("wrong-account")).toBeNull();
  });

  it("keeps the sign-in while a link for more access is out", async () => {
    await connected("more-access");
    const seen = google("more-access", ok);
    await applyTools("more-access", { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: { reason: "more_access" } }]);
    expect(seen).toEqual([]);
    expect(await loadGrant("more-access")).toMatchObject({ refreshToken: "1//old" });
  });

  it("revokes nothing when the change that asked for it lost the save", async () => {
    await connected("lost-race");
    const seen = google("lost-race", ok);
    vi.spyOn(getStore(), "save").mockResolvedValue({ ok: false, conflict: true });
    await expect(applyTools("lost-race", { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: { fresh: true, reason: "wrong_account" } }])).rejects.toThrow(
      "conflict",
    );
    expect(seen).toEqual([]);
    expect(await getStore().googleGrant("lost-race")).not.toBeNull();
  });

  it("has the fallback brain disconnect by text, with the revoke's result on the tool's row and in the line after it", async () => {
    const turn = (id: string) => takeTurn(id, [{ clientMsgId: crypto.randomUUID(), text: "can you disconnect my gmail?" }], ORIGIN);
    const disconnected = async (id: string) => {
      const events = await getStore().listEvents(id, 100);
      return { row: events.find((e) => e.meta?.tool?.name === "disconnect_google")?.meta?.tool, said: events.filter((e) => e.role === "agent").map((e) => e.content) };
    };

    await connected("fallback-ok");
    const seen = google("fallback-ok", ok);
    const snapshot = await turn("fallback-ok");
    expect(seen).toEqual(["disconnected:token=1%2F%2Fold"]);
    expect(snapshot.session.gmail).toEqual({ status: "disconnected" });
    expect(snapshot.events.at(-1)?.content).toMatch(/disconnected/);
    expect(await disconnected("fallback-ok")).toEqual({ row: { name: "disconnect_google", args: {}, ok: true }, said: [expect.stringMatching(/disconnected/)] });

    await connected("fallback-down");
    google("fallback-down", () => Promise.reject(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await turn("fallback-down");
    const down = await disconnected("fallback-down");
    expect(down.row).toEqual({ name: "disconnect_google", args: {}, ok: false, error: "revoke_failed" });
    expect(down.said).toEqual([expect.stringMatching(/google didn't answer.*third-party connections/)]);
    expect(await getStore().googleGrant("fallback-down")).toBeNull();
  });
});
