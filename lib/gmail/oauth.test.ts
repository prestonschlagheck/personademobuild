import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type HelpCategory, type Session } from "@/lib/session/schema";

vi.mock("server-only", () => ({}));

// The browser's session cookie, which the callback and the return page read.
let cookieSession: string | null = null;
vi.mock("@/lib/server/cookie", () => ({
  readSessionId: async () => cookieSession,
  writeSessionId: async () => {},
}));

const {
  BASE_SCOPES,
  CALENDAR_SCOPE,
  DRIVE_SCOPE,
  connectedEmail,
  consentScopes,
  extraScopes,
  gmailScope,
  googleAuthorizeUrl,
  handleGoogleCallback,
  signInTarget,
} = await import("@/lib/gmail/oauth");
const { getStore } = await import("@/lib/server/store");
const { businessQuery, needQuery } = await import("@/lib/gmail/queries");
const { connectedOfferLine, inboxUnreadableLine, stillConnectedLine, valueUnavailableLine } = await import("@/lib/agent/messages");

const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const LABELS = "https://www.googleapis.com/auth/gmail.labels";
const CALENDAR = "https://www.googleapis.com/auth/calendar.events.readonly";
const DRIVE = "https://www.googleapis.com/auth/drive.metadata.readonly";
// Past what the agent uses: Contacts, file contents, full Drive or Calendar, Gmail settings, or deleting mail for good.
const BROADER = /contacts|people|directory|auth\/drive(?!\.metadata\.readonly)|auth\/calendar(?!\.events\.readonly)|gmail\.(?:insert|settings)|mail\.google\.com/;
const BASE = "http://localhost:3000/api/oauth/google/callback";

const requested = (mode: "" | "labels") => {
  vi.stubEnv("GMAIL_SCOPE_MODE", mode);
  return googleAuthorizeUrl("state-1", "https://persona.example").searchParams.get("scope")?.split(" ");
};

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
  vi.stubEnv("GOOGLE_REDIRECT_URI", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  cookieSession = null;
});

describe("the Google consent request", () => {
  it("asks for openid, email, Gmail read and write, and read-only Calendar events and Drive file names, and nothing else", () => {
    expect(requested("")).toEqual(["openid", "email", MODIFY, CALENDAR, DRIVE]);
    expect(consentScopes()).toEqual(["openid", "email", MODIFY, CALENDAR, DRIVE]);
    expect([CALENDAR_SCOPE, DRIVE_SCOPE]).toEqual([CALENDAR, DRIVE]);
  });

  it("swaps in the labels-only scope when that mode is set, with no Calendar or Drive", () => {
    expect(requested("labels")).toEqual(["openid", "email", LABELS]);
  });

  it("never asks for Contacts, file contents, Gmail settings or deleting mail past the Trash", () => {
    for (const mode of ["", "labels"] as const) {
      for (const scope of requested(mode) ?? []) expect(scope).not.toMatch(BROADER);
    }
  });

  it("asks the mock consent page for the same scopes as Google", () => {
    expect([...BASE_SCOPES.split(" "), gmailScope(), ...extraScopes()]).toEqual(consentScopes());
  });

  it("asks for a one-time code, a refresh token the session keeps, and no earlier grants", () => {
    const params = googleAuthorizeUrl("state-1", "https://persona.example").searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent select_account");
    expect(params.get("state")).toBe("state-1");
    expect(params.get("redirect_uri")).toBe("https://persona.example/api/oauth/google/callback");
    expect(params.has("include_granted_scopes")).toBe(false);
  });
});

type Need = { value: string; category: HelpCategory };
const SUBSCRIPTIONS: Need = { value: "cancel subscriptions i don't use", category: "subscriptions" };

async function linkSent(need: Need = SUBSCRIPTIONS, gmail?: Session["gmail"], linkAt = new Date()): Promise<{ id: string; state: string }> {
  const id = crypto.randomUUID();
  const state = crypto.randomUUID();
  const now = new Date().toISOString();
  const session: Session = {
    ...newSession(id, now),
    helpNeed: { ...need, source: "voice", setAt: now },
    gmail: gmail ?? { status: "link_sent", linkSentAt: now },
  };
  await getStore().create(session);
  await getStore().createOAuthState(state, id, linkAt.toISOString());
  cookieSession = id;
  return { id, state };
}

const answer = (state: string, fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams({ state });
  for (const [name, value] of Object.entries(fields)) for (const v of [value].flat()) params.append(name, v);
  return handleGoogleCallback(params, BASE);
};

const gmailOf = async (id: string) => (await getStore().load(id))?.gmail;
const lastAgentLine = async (id: string) => (await getStore().listEvents(id, 50)).findLast((e) => e.role === "agent")?.content;

// The mock consent page's answers, run through the real callback against the memory store.
describe("the sign-in callback", () => {
  it("connects, stores the fact for the stated need, and shows the address on the return page", async () => {
    const { id, state } = await linkSent();
    expect(await connectedEmail()).toBeNull();
    expect(await answer(state, { code: "mock.subscriptions", scope: [BASE_SCOPES, gmailScope()] })).toBe("connected");
    const gmail = await gmailOf(id);
    expect(gmail?.status).toBe("connected");
    expect(gmail?.valueFact).toMatch(/^i see what look like 4 subscriptions, including streamloop, cadence music and draftline studio\./);
    expect(gmail?.valueFact).not.toMatch(/priya|patel/);
    expect(await connectedEmail()).toBe("riley.sato@example.com");
  });

  it("adds the Calendar and Drive facts when both are allowed, and leaves each out when it is unticked", async () => {
    const both = await linkSent();
    expect(await answer(both.state, { code: "mock.inbox", scope: [BASE_SCOPES, gmailScope(), CALENDAR, DRIVE] })).toBe("connected");
    const full = await gmailOf(both.id);
    // The first event is someone else's invite, so it is counted, never named.
    expect(full?.calendarFact).toMatch(/^4 events on your calendar this week\. next up: an invite from someone else, /);
    expect(full?.calendarFact).not.toMatch(/coffee/);
    expect(full?.driveFact).toBe("5 folders at the top of your drive: work, photos, apartment, plus 2 more.");

    const gmailOnly = await linkSent();
    expect(await answer(gmailOnly.state, { code: "mock.inbox", scope: [BASE_SCOPES, gmailScope(), DRIVE] })).toBe("connected");
    const partial = await gmailOf(gmailOnly.id);
    expect(partial?.calendarFact).toBeUndefined();
    expect(partial?.driveFact).toMatch(/^5 folders/);
  });

  it("never connects Calendar or Drive without Gmail", async () => {
    const { id, state } = await linkSent();
    expect(await answer(state, { code: "mock.inbox", scope: [BASE_SCOPES, CALENDAR, DRIVE] })).toBe("partial");
    expect((await gmailOf(id))?.calendarFact).toBeUndefined();
  });

  it("treats an unticked Gmail box as not connected", async () => {
    const { id, state } = await linkSent();
    expect(await answer(state, { code: "mock.inbox", scope: BASE_SCOPES })).toBe("partial");
    expect((await gmailOf(id))?.status).toBe("denied");
    expect(await connectedEmail()).toBeNull();
  });

  it("records a cancel as a skip", async () => {
    const { id, state } = await linkSent();
    expect(await answer(state, { error: "access_denied" })).toBe("denied");
    expect((await gmailOf(id))?.status).toBe("denied");
    expect((await getStore().load(id))?.steering.skipped).toContain("gmail");
  });

  it("refuses a link the second time", async () => {
    const { state } = await linkSent();
    expect(await answer(state, { code: "mock.inbox", scope: [BASE_SCOPES, gmailScope()] })).toBe("connected");
    expect(await answer(state, { code: "mock.bills", scope: [BASE_SCOPES, gmailScope()] })).toBe("expired");
    expect(await connectedEmail()).toBe("jordan.lee@example.com");
  });

  it("never attaches an inbox to a session in another browser", async () => {
    const { id, state } = await linkSent();
    cookieSession = crypto.randomUUID();
    expect(await answer(state, { code: "mock.inbox", scope: [BASE_SCOPES, gmailScope()] })).toBe("expired");
    expect((await gmailOf(id))?.status).toBe("link_sent");
  });

  it("shows no address without a session", async () => {
    expect(await connectedEmail()).toBeNull();
  });
});

describe("the value line at connect", () => {
  it("leads with the business the need names, and ties in their own event about it", async () => {
    const { id, state } = await linkSent({ value: "cancel my planet fitness", category: "subscriptions" });
    expect(await answer(state, { code: "mock.membership", scope: [BASE_SCOPES, gmailScope(), CALENDAR, DRIVE] })).toBe("connected");
    const gmail = await gmailOf(id);
    expect(gmail?.valueFact).toMatch(
      /^i found 4 planet fitness emails from the last 3 months, including a \$24\.99 charge on [a-z]{3} \d{1,2}\. "planet fitness" is on your calendar [^.]+\. want me to text you before the next one\?$/,
    );
    expect(gmail?.valueFact).not.toMatch(/rowan|@/);
    // The Calendar and Drive facts are still kept on their own.
    expect(gmail?.calendarFact).toMatch(/on your calendar this week/);
    expect(gmail?.driveFact).toMatch(/fitness, receipts/);
    const lines = (await getStore().listEvents(id, 50)).filter((e) => e.role === "agent");
    expect(lines.map((e) => e.meta?.kind)).toEqual(["confirm_account", "value_moment"]);
    // The line is long enough that the lead-in would push the bubble past 200, so it goes on its own.
    expect(lines.at(-1)?.content).toBe(gmail?.valueFact);
    expect(lines.at(-1)?.content.length).toBeLessThanOrEqual(200);
  });

  it("gives a dentist need the appointments it can see, never naming the dental office", async () => {
    const { id, state } = await linkSent({ value: "reschedule my dentist appointment", category: "appointments" });
    expect(await answer(state, { code: "mock.appointments", scope: [BASE_SCOPES, gmailScope(), CALENDAR] })).toBe("connected");
    const fact = (await gmailOf(id))?.valueFact ?? "";
    expect(fact).toMatch(/^i see 2 appointment emails from the last month, the latest from (?:today|yesterday)\. "dentist" is on your calendar /);
    expect(fact).toMatch(/ want a reminder the day before\?$/);
    expect(fact).not.toMatch(/brightsmile|jess|lunch/);
  });
});

describe("the text at connect for a general need", () => {
  const INBOX: Need = { value: "gmail", category: "inbox" };
  const agentLines = async (id: string) => (await getStore().listEvents(id, 50)).filter((e) => e.role === "agent");

  it("names the access they allowed and makes one offer, reading out no fact, and keeps every fact on the session", async () => {
    const { id, state } = await linkSent(INBOX);
    expect(await answer(state, { code: "mock.inbox", scope: [BASE_SCOPES, gmailScope(), CALENDAR, DRIVE] })).toBe("connected");
    const gmail = await gmailOf(id);
    expect(gmail?.valueFact).toBeTruthy();
    expect(gmail?.calendarFact).toMatch(/on your calendar this week/);
    expect(gmail?.driveFact).toMatch(/at the top of your drive/);
    const lines = await agentLines(id);
    expect(lines.map((e) => e.meta?.kind)).toEqual(["confirm_account", "value_moment"]);
    expect(lines.at(-1)?.content).toBe(connectedOfferLine("calendar and drive").text);
    const texted = lines.map((e) => e.content).join(" ");
    for (const fact of [gmail?.valueFact, gmail?.calendarFact, gmail?.driveFact]) expect(texted).not.toContain(fact ?? "missing");
  });

  it("names drive alone when only drive was allowed", async () => {
    const { id, state } = await linkSent(INBOX);
    expect(await answer(state, { code: "mock.inbox", scope: [BASE_SCOPES, gmailScope(), DRIVE] })).toBe("connected");
    const last = (await agentLines(id)).at(-1)?.content;
    expect(last).toBe(connectedOfferLine("drive").text);
    expect(last).not.toContain("calendar");
  });
});

describe("a fresh link while Gmail is connected", () => {
  const connected: Session["gmail"] = {
    status: "connected",
    email: "old@example.com",
    connectedAt: "2026-09-26T16:00:00.000Z",
    scopes: ["openid", "email", MODIFY],
    valueFact: "you've got 9 unread from the last 2 days. want me to flag anything that needs you?",
  };

  it.each([
    ["a cancel", { error: "access_denied" }, "denied"],
    ["an unticked Gmail box", { code: "mock.bills", scope: BASE_SCOPES }, "partial"],
    ["a Google error", { error: "admin_policy_enforced" }, "error"],
  ] as const)("keeps the connection through %s, spends the pending link, and says so", async (_label, fields, result) => {
    const { id, state } = await linkSent(SUBSCRIPTIONS, { ...connected, pendingLinkAt: new Date().toISOString() });
    expect(await answer(state, fields)).toBe(result);
    expect(await gmailOf(id)).toEqual(connected);
    expect(await lastAgentLine(id)).toBe(stillConnectedLine("old@example.com").text);
  });

  it("keeps a connection with no pending link just as it was", async () => {
    const { id, state } = await linkSent(SUBSCRIPTIONS, connected);
    expect(await answer(state, { error: "access_denied" })).toBe("denied");
    expect(await getStore().load(id)).toMatchObject({ version: 0, gmail: connected });
  });

  it("replaces the connection only when the new grant lands", async () => {
    const pending = { ...connected, pendingLinkAt: new Date().toISOString() };
    const { id, state } = await linkSent({ value: "help me not miss bills", category: "bills" }, pending);
    expect(await answer(state, { code: "mock.bills", scope: [BASE_SCOPES, gmailScope()] })).toBe("connected");
    const gmail = await gmailOf(id);
    expect(gmail).toMatchObject({ status: "connected", email: "casey.morgan@example.com" });
    expect(gmail?.pendingLinkAt).toBeUndefined();
    expect(gmail?.valueFact).toMatch(/^i see bills from 3 companies in the last 6 weeks: northwind energy, harbor mobile and cobalt card\./);
  });
});

describe("opening the texted link", () => {
  const open = async (state: string) => new URL(await signInTarget(state, BASE));
  const staleNotices = async (id: string) => (await getStore().listEvents(id, 50)).filter((e) => e.meta?.kind === "stale_link").length;

  it("sends a live link on to sign-in and stamps when it was opened", async () => {
    const { id, state } = await linkSent();
    expect((await gmailOf(id))?.openedAt).toBeUndefined();
    const target = await open(state);
    expect(target.pathname).toBe("/connect/mock");
    expect(target.searchParams.get("state")).toBe(state);
    expect(Date.parse((await gmailOf(id))?.openedAt ?? "")).toBeGreaterThan(Date.now() - 5_000);
  });

  it("refuses a link that already worked before it reaches Google, and says so once", async () => {
    const { id, state } = await linkSent();
    expect(await answer(state, { code: "mock.inbox", scope: [BASE_SCOPES, gmailScope()] })).toBe("connected");
    const opened = (await gmailOf(id))?.openedAt;
    for (let i = 0; i < 2; i++) {
      const target = await open(state);
      expect(target.pathname).toBe("/connect/done");
      expect(target.searchParams.get("result")).toBe("expired");
    }
    expect(await staleNotices(id)).toBe(1);
    expect((await gmailOf(id))?.openedAt).toBe(opened);
  });

  it("refuses a link a fresh one replaced, and still opens the fresh one", async () => {
    const { id, state } = await linkSent();
    const store = getStore();
    const session = await store.load(id);
    if (!session) throw new Error("missing session");
    const fresh = crypto.randomUUID();
    await store.save({ ...session, updatedAt: new Date().toISOString() }, session.version, { oauthState: fresh });
    expect((await open(state)).searchParams.get("result")).toBe("expired");
    expect((await open(fresh)).pathname).toBe("/connect/mock");
  });

  it("refuses an expired link and one issued to another session", async () => {
    const expired = await linkSent(SUBSCRIPTIONS, undefined, new Date(Date.now() - 31 * 60_000));
    expect((await open(expired.state)).searchParams.get("result")).toBe("expired");
    expect((await gmailOf(expired.id))?.openedAt).toBeUndefined();

    const theirs = await linkSent();
    const mine = await linkSent();
    cookieSession = mine.id;
    expect((await open(theirs.state)).searchParams.get("result")).toBe("expired");
    expect((await gmailOf(theirs.id))?.openedAt).toBeUndefined();
  });
});

// The live path with Google's endpoints stubbed: what is asked of Gmail, and what happens when a read fails.
describe("the live Google grant", () => {
  const TOKEN = "ya29.test-token";
  type Call = { url: URL; init?: RequestInit };
  let calls: Call[] = [];
  const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const HEADERS: Record<string, [string, string]> = {
    b1: ["Planet Fitness <billing@planetfitness.example>", "Your Planet Fitness receipt: $24.99"],
    b2: ["Planet Fitness <billing@planetfitness.example>", "Your Planet Fitness receipt: $24.99"],
    n1: ["Streamloop <billing@streamloop.example>", "Your subscription renews tomorrow"],
  };

  function google({ labels = 200, list = 200 }: { labels?: number; list?: number } = {}) {
    calls = [];
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ url, init });
        if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
          return json({ access_token: TOKEN, refresh_token: "1//refresh", expires_in: 3599, scope: [BASE_SCOPES, MODIFY].join(" "), id_token: idToken("real.person@gmail.com") });
        }
        if (url.pathname === "/revoke") return new Response(null, { status: 200 });
        if (url.pathname.endsWith("/labels/INBOX")) return labels === 200 ? json({ threadsUnread: 12 }) : json({}, labels);
        if (url.pathname.endsWith("/messages")) {
          if (list !== 200) return json({}, list);
          const q = url.searchParams.get("q") ?? "";
          return json({ messages: (q.startsWith("newer_than:90d (from:") ? ["b1", "b2"] : ["n1", "b1"]).map((id) => ({ id })) });
        }
        const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const [from, subject] = HEADERS[id] ?? ["", ""];
        const date = new Date(Date.now() - (id === "b2" ? 40 : id === "b1" ? 10 : 1) * 86_400_000).toUTCString();
        return json({ payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: subject }, { name: "Date", value: date }] } });
      }),
    );
  }

  const gmailCalls = () => calls.filter((c) => c.url.hostname === "gmail.googleapis.com");
  const revokes = () => calls.filter((c) => c.url.pathname === "/revoke");

  it("searches for the need and the business it names, two list calls at most, reads headers only, then keeps the sign-in sealed", async () => {
    google();
    const { id, state } = await linkSent({ value: "cancel my planet fitness", category: "subscriptions" });
    expect(await answer(state, { code: "live-code" })).toBe("connected");
    const lists = gmailCalls().filter((c) => c.url.pathname.endsWith("/messages"));
    expect(lists.map((c) => c.url.searchParams.get("q")).sort()).toEqual([businessQuery("planet fitness"), needQuery("subscriptions")].sort());
    const reads = gmailCalls().filter((c) => /\/messages\/[^/]+$/.test(c.url.pathname));
    // Each message is read once, however many searches found it, and only for its headers.
    expect(reads.map((c) => c.url.pathname.split("/").pop()).sort()).toEqual(["b1", "b2", "n1"]);
    for (const read of reads) expect(read.url.searchParams.get("format")).toBe("metadata");
    // Kept for the agent's tools, sealed and apart from the session, so no read of the session ever carries it.
    expect(revokes()).toHaveLength(0);
    const sealed = await getStore().googleGrant(id);
    expect(sealed).toBeTruthy();
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain("1//refresh");
    const gmail = await gmailOf(id);
    expect(gmail).toMatchObject({ status: "connected", email: "real.person@gmail.com" });
    expect(gmail?.valueFact).toMatch(
      /^i found 2 planet fitness emails from the last 3 months, the latest a \$24\.99 charge (?:on [a-z]+ \d+|on [a-z]+|yesterday)\. want me to text you before the next one\?$/,
    );
    expect(JSON.stringify(await getStore().load(id))).not.toContain(TOKEN);
  });

  it("makes one search when the need names no business", async () => {
    google();
    const { state } = await linkSent({ value: "help me not miss bills", category: "bills" });
    expect(await answer(state, { code: "live-code" })).toBe("connected");
    expect(gmailCalls().filter((c) => c.url.pathname.endsWith("/messages")).map((c) => c.url.searchParams.get("q"))).toEqual([needQuery("bills")]);
  });

  it("says the inbox couldn't be read, not an admin block, when Gmail won't answer after a grant, and still revokes", async () => {
    google({ labels: 503 });
    const { id, state } = await linkSent();
    expect(await answer(state, { code: "live-code" })).toBe("unreadable");
    const gmail = await gmailOf(id);
    expect(gmail?.status).toBe("error");
    expect(gmail?.email).toBeUndefined();
    const line = await lastAgentLine(id);
    expect(line).toBe(inboxUnreadableLine().text);
    expect(line).not.toContain("@gmail.com");
    expect(revokes()).toHaveLength(1);
    expect(await connectedEmail()).toBeNull();
  });

  it("connects with no fact when only the searches fail, and offers a fresh link rather than a retry it can't make", async () => {
    google({ list: 500 });
    const { id, state } = await linkSent();
    expect(await answer(state, { code: "live-code" })).toBe("connected");
    const gmail = await gmailOf(id);
    expect(gmail?.status).toBe("connected");
    expect(gmail?.valueFact).toBeUndefined();
    expect(await lastAgentLine(id)).toBe(valueUnavailableLine().text);
    expect(valueUnavailableLine().text).not.toMatch(/try again in a bit|i'll try/);
    expect(revokes()).toHaveLength(0);
  });
});

describe("the lines a grant ends in", () => {
  it("keep the product voice, and each unfinished one offers the next step", () => {
    for (const line of [inboxUnreadableLine(), valueUnavailableLine(), stillConnectedLine("p@gmail.com")]) {
      expect(line.text).toBe(line.text.toLowerCase());
      expect(line.text.length).toBeLessThanOrEqual(120);
      expect(line.text).not.toMatch(/[\u2013\u2014]|i'll try again/);
    }
    for (const line of [inboxUnreadableLine(), valueUnavailableLine()]) expect(line.text).toMatch(/fresh link.*\?$/);
    // Gmail answered nothing, so the line never claims a connection or blames a Workspace admin.
    expect(inboxUnreadableLine().text).not.toMatch(/connected|@gmail\.com|admin/);
  });
});
