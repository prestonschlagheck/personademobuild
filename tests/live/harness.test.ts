import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Snapshot } from "@/lib/session/schema";
import { CHECK_IN_AT, GOODBYE_AT } from "@/lib/voice/notes";

vi.mock("server-only", () => ({}));
// Call starts are rate limited by IP, and the Google callback reads the session cookie; neither exists outside a route.
vi.mock("@/lib/server/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/http")>()),
  clientIp: async () => "127.0.0.1",
}));
let cookieId: string | null = null;
vi.mock("@/lib/server/cookie", () => ({ readSessionId: async () => cookieId, writeSessionId: async () => undefined }));

const { runHarness } = await import("@/lib/server/harness");
const { MOCK_ACCOUNTS } = await import("@/lib/gmail/fixtures");
const { applyMockGrant } = await import("@/lib/gmail/oauth");
const { applyTools } = await import("@/lib/server/session-service");
const { getStore } = await import("@/lib/server/store");
const { startCall } = await import("@/lib/server/call-service");
const { POST } = await import("@/app/api/harness/[action]/route");

const ORIGIN = "http://localhost:3000";

type Result = { say: string; ended: boolean; result?: string; snapshot: Snapshot };
const act = (id: string, action: string, body: unknown = {}) => runHarness(id, action, body, ORIGIN) as Promise<Result>;

async function namedSession() {
  const id = crypto.randomUUID();
  await getStore().create({ ...newSession(id, new Date().toISOString()), agentName: { value: "Jarvis", source: "text", setAt: new Date().toISOString() } });
  cookieId = id;
  return id;
}

// The harness runs only under `next dev` with HARNESS=1, which vitest is not.
beforeEach(() => {
  vi.stubEnv("HARNESS", "1");
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("harness route", () => {
  const post = () => POST(new NextRequest(`${ORIGIN}/api/harness/state`, { method: "POST" }), { params: Promise.resolve({ action: "state" }) });

  it("does not exist without HARNESS=1", async () => {
    vi.stubEnv("HARNESS", "");
    expect((await post()).status).toBe(404);
  });

  it.each(["NODE_ENV", "APP_ENV"])("does not exist with %s=production, even with HARNESS=1", async (name) => {
    const id = await namedSession();
    vi.stubEnv(name, "production");
    expect((await post()).status).toBe(404);
    await expect(act(id, "state")).rejects.toMatchObject({ status: 404 });
    await expect(act(id, "link", { which: "latest" })).rejects.toMatchObject({ status: 404 });
    await expect(applyMockGrant(id, "mock.inbox", [])).rejects.toMatchObject({ status: 404 });
  });
});

describe("harness with the mock brains", () => {
  beforeEach(() => vi.stubEnv("OPENAI_API_KEY", ""));

  it("rings, takes the call without WebRTC and opens with a hello by name", async () => {
    const id = await namedSession();
    const { say, snapshot } = await act(id, "connect");
    expect(snapshot.session.call).toMatchObject({ status: "active", attempts: 1, activeCallId: "harness_1" });
    expect(say).toMatch(/\bJarvis\b/);
    expect(say).not.toMatch(/\bai\b|transcribed/);
    expect(snapshot.events.filter((e) => e.channel === "voice").map((e) => e.role)).toEqual(["agent"]);
  });

  it("saves both sides of a voice turn and relays its tools through the call path", async () => {
    const id = await namedSession();
    await act(id, "connect");
    const { snapshot } = await act(id, "voice", { text: "i'm preston" });
    expect(snapshot.session.userName?.value).toBe("Preston");
    const voice = snapshot.events.filter((e) => e.channel === "voice");
    expect(voice.map((e) => e.role)).toEqual(["agent", "user", "agent"]);
    expect(snapshot.events.some((e) => e.meta?.tool?.name === "set_user_name" && e.toolCallId?.startsWith("harness_"))).toBe(true);
  });

  it("waits through silence, checks in once, and hangs up after a long silence through the normal end path", async () => {
    const id = await namedSession();
    await act(id, "connect");
    const quiet = await act(id, "silence", { count: 1 });
    expect(quiet.snapshot.session.call.status).toBe("active");
    const first = await act(id, "silence", { count: CHECK_IN_AT });
    expect(first.snapshot.session.call.status).toBe("active");
    const second = await act(id, "silence", { count: GOODBYE_AT });
    expect(second.ended).toBe(true);
    expect(second.snapshot.session.call).toMatchObject({ status: "ended", lastEndReason: "agent_end" });
    expect(second.snapshot.events.at(-1)).toMatchObject({ channel: "text", role: "agent" });
  });

  it("finishes the latest gmail link as a fixture account, and a second use is a dead link", async () => {
    const id = await namedSession();
    await applyTools(id, { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: {} }]);
    const connected = await act(id, "gmail", { account: "bills" });
    expect(connected.result).toBe("connected");
    expect(connected.snapshot.session.gmail).toMatchObject({ status: "connected", email: "casey.morgan@example.com" });
    const reused = await act(id, "gmail", { account: "bills" });
    expect(reused.result).toBe("expired");
  });

  it("has the call say the value fact for a specific need while the thread only confirms the account", async () => {
    const id = await namedSession();
    await applyTools(id, { runtime: "text", origin: ORIGIN }, [{ name: "set_help_need", args: { need: "help me with my bills", category: "bills" } }]);
    await act(id, "connect");
    await act(id, "voice", { text: "send me the gmail link" });
    const connected = await act(id, "gmail", { account: "bills" });
    expect(connected.say).toContain(connected.snapshot.session.gmail.valueFact ?? "missing");
    expect(connected.say).toMatch(/calendar and drive/);
    const kinds = connected.snapshot.events.filter((e) => e.channel === "text" && e.role === "agent").map((e) => e.meta?.kind);
    expect(kinds).toContain("confirm_account");
    expect(kinds).not.toContain("value_moment");
  });

  it("has the call say only that gmail came through, with calendar and drive, for a general need", async () => {
    const id = await namedSession();
    await act(id, "connect");
    await act(id, "voice", { text: "send me the gmail link" });
    const connected = await act(id, "gmail", { account: "bills" });
    const { valueFact, calendarFact, driveFact } = connected.snapshot.session.gmail;
    expect(valueFact).toBeDefined();
    expect(connected.say).toMatch(/calendar and drive/);
    for (const fact of [valueFact, calendarFact, driveFact]) if (fact) expect(connected.say).not.toContain(fact);
    const kinds = connected.snapshot.events.filter((e) => e.channel === "text" && e.role === "agent").map((e) => e.meta?.kind);
    expect(kinds).toEqual(expect.arrayContaining(["confirm_account"]));
    expect(kinds).not.toContain("value_moment");
  });

  it("saves a reply the user talked over only as far as it got, marked cut off", async () => {
    const id = await namedSession();
    await act(id, "connect");
    const { say, snapshot } = await act(id, "voice", { text: "i'm preston", cut: 0.4 });
    expect(say).toMatch(/\.\.\. \(cut off\)$/);
    expect(snapshot.events.filter((e) => e.channel === "voice").at(-1)?.content).toBe(say);
  });

  it("connects gmail with no fact when the inbox can't be read, and the link is then dead", async () => {
    const id = await namedSession();
    await applyTools(id, { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: {} }]);
    const connected = await act(id, "gmail", { account: "inbox", result: "unreadable" });
    expect(connected.result).toBe("connected");
    expect(connected.snapshot.session.gmail).toMatchObject({ status: "connected", email: "jordan.lee@example.com" });
    expect(connected.snapshot.session.gmail.valueFact).toBeUndefined();
    const kinds = connected.snapshot.events.filter((e) => e.channel === "text" && e.role === "agent").map((e) => e.meta?.kind);
    expect(kinds).toEqual(expect.arrayContaining(["confirm_account", "value_unavailable"]));
    expect((await act(id, "gmail", { account: "inbox", result: "unreadable" })).result).toBe("expired");
  });

  it("refuses a gmail step before any link was sent", async () => {
    const id = await namedSession();
    await expect(act(id, "gmail")).rejects.toMatchObject({ status: 409, error: "no_link" });
  });

  it("finishes sign-in as any fixture inbox by id, and refuses one that does not exist", async () => {
    for (const account of MOCK_ACCOUNTS) {
      const id = await namedSession();
      await applyTools(id, { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: {} }]);
      const connected = await act(id, "gmail", { account: account.id });
      expect(connected.snapshot.session.gmail).toMatchObject({ status: "connected", email: account.email });
    }
    const id = await namedSession();
    await applyTools(id, { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: {} }]);
    await expect(act(id, "gmail", { account: "nobody" })).rejects.toMatchObject({ status: 400, error: "unknown_account" });
    expect((await act(id, "state")).snapshot.session.gmail.status).toBe("link_sent");
  });

  it("opens the latest gmail link through the start route, on to sign-in", async () => {
    const id = await namedSession();
    await applyTools(id, { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: {} }]);
    expect((await act(id, "link", { which: "latest" })).result).toBe("mock");
  });

  it("stops the link a fresh one replaced at the start route, before any sign-in", async () => {
    const id = await namedSession();
    await applyTools(id, { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: {} }]);
    await applyTools(id, { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: { fresh: true } }]);
    const older = await act(id, "link");
    expect(older.result).toBe("expired");
    expect(older.snapshot.session.gmail.status).toBe("link_sent");
    // The fresh link still leads on to sign-in, and still finishes it.
    expect((await act(id, "link", { which: "latest" })).result).toBe("mock");
    expect((await act(id, "gmail", { account: "travel" })).snapshot.session.gmail).toMatchObject({ status: "connected", email: "avery.quinn@example.com" });
  });

  it("stops a link issued to another session at the start route", async () => {
    const owner = await namedSession();
    await applyTools(owner, { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: {} }]);
    const [link] = (await act(owner, "state")).snapshot.events.flatMap((e) => (e.meta?.link ? [e.meta.link.url] : []));
    const other = await namedSession();
    await getStore().appendEvents(other, [{ channel: "text", role: "agent", content: "forwarded", meta: { link: { url: link ?? "", title: "Gmail", subtitle: "" } } }]);
    expect((await act(other, "link", { which: "latest" })).result).toBe("expired");
  });

  it("refuses to open an older link when only one was sent", async () => {
    const id = await namedSession();
    await expect(act(id, "link")).rejects.toMatchObject({ status: 409, error: "no_link" });
    await applyTools(id, { runtime: "text", origin: ORIGIN }, [{ name: "send_gmail_link", args: {} }]);
    await expect(act(id, "link")).rejects.toMatchObject({ status: 409, error: "no_link" });
  });

  it.each(["mic_missing", "mic_busy"])("ends a ringing call as %s through the normal end path, with a text that is not about a blocked mic", async (reason) => {
    const id = await namedSession();
    await act(id, "connect");
    await act(id, "end", { reason: "user_hangup" });
    await startCall(id, "user");
    const { snapshot } = await act(id, "end", { reason });
    expect(snapshot.session.call).toMatchObject({ status: "failed", lastEndReason: reason });
    const text = snapshot.events.findLast((e) => e.channel === "text" && e.role === "agent");
    expect(text?.content).toMatch(/mic|microphone/i);
    expect(text?.content).not.toMatch(/blocked|lock icon/i);
  });
});

describe("harness with the live voice prompt", () => {
  type Body = { instructions: string; tools: { name: string }[]; tool_choice: string; input: { type?: string; role?: string; content?: unknown }[] };
  const scripted = (replies: object[][]) => {
    const bodies: Body[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return Response.json({ output: replies.shift() ?? [] });
      }),
    );
    return bodies;
  };
  const says = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });
  const calls = (id: string, name: string, args: object) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });

  it("runs the exact Realtime session config, and answers a silent hangup the way the call screen does", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const bodies = scripted([
      [says("hey, it's jarvis. what should i call you?")],
      [calls("c1", "end_call", { reason: "user_request" })],
      [says("talk soon!"), calls("c2", "end_call", { reason: "user_request" })],
    ]);
    const id = await namedSession();
    await act(id, "connect");
    expect(bodies[0]?.tools.map((tool) => tool.name)).toContain("end_call");
    expect(bodies[0]?.instructions).toContain("you are on a live voice call.");

    const bye = await act(id, "voice", { text: "hmm, i'm not sure" });
    expect(bodies[2]?.input.findLast((item) => item.type === "function_call_output")).toMatchObject({ call_id: "c1" });
    expect(JSON.stringify(bodies[2]?.input)).toContain("say_goodbye_first");
    expect(bye).toMatchObject({ say: "talk soon!", ended: true });
    expect(bye.snapshot.session.call).toMatchObject({ status: "ended", lastEndReason: "agent_end" });
    expect(bye.snapshot.events.filter((e) => e.meta?.tool?.name === "end_call").map((e) => e.toolCallId)).toEqual(["c2"]);
  });

  it("lets a hangup with nothing said through when they asked it to hang up, as the call screen does", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    scripted([[says("hey, it's jarvis. what should i call you?")], [calls("c1", "end_call", { reason: "user_request" })]]);
    const id = await namedSession();
    await act(id, "connect");
    const bye = await act(id, "voice", { text: "Hang up now." });
    expect(bye.ended).toBe(true);
    expect(bye.snapshot.session.call).toMatchObject({ status: "ended", lastEndReason: "agent_end" });
    expect(bye.snapshot.events.filter((e) => e.meta?.tool?.name === "end_call").map((e) => e.toolCallId)).toEqual(["c1"]);
  });

  it("ends the call when the model says goodbye back to theirs without end_call, as the live transport does", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    scripted([[says("hey, it's jarvis. what should i call you?")], [says("Bye, Preston. Talk soon.")]]);
    const id = await namedSession();
    await act(id, "connect");
    const bye = await act(id, "voice", { text: "perfect, that's everything for now. bye!" });
    expect(bye.ended).toBe(true);
    expect(bye.snapshot.session.call).toMatchObject({ status: "ended", lastEndReason: "agent_end" });
    expect(bye.snapshot.events.find((e) => e.meta?.tool?.name === "end_call")?.meta?.tool?.args).toEqual({ reason: "user_request" });
  });

  it("gives a turn that keeps calling tools one last round with none, so something is always said", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const bodies = scripted([
      [says("hey, it's jarvis. what should i call you?")],
      ...Array.from({ length: 5 }, (_, i) => [calls(`g${i}`, "clear_help_need", {})]),
      [says("got it. what could i take off your plate?")],
    ]);
    const id = await namedSession();
    await act(id, "connect");
    const { say } = await act(id, "voice", { text: "hmm" });
    expect(say).toBe("got it. what could i take off your plate?");
    expect(bodies.at(-1)?.tool_choice).toBe("none");
  });

  it("runs the voice tools on the text model, answers each call, and saves what was said", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const bodies: { input: { type?: string; role?: string; content?: unknown }[] }[] = [];
    const replies = [
      [{ type: "message", content: [{ type: "output_text", text: "hey, it's jarvis. what should i call you?" }] }],
      [{ type: "function_call", call_id: "call_1", name: "set_user_name", arguments: '{"name":"Preston"}' }],
      [{ type: "message", content: [{ type: "output_text", text: "got it, preston. what could i take off your plate?" }] }],
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return Response.json({ output: replies.shift() ?? [] });
      }),
    );

    const id = await namedSession();
    const opened = await act(id, "connect");
    expect(opened.say).toMatch(/^hey, it's jarvis/i);
    expect(bodies[0]?.input[0]).toMatchObject({ role: "system" });

    const { say, snapshot } = await act(id, "voice", { text: "i'm preston" });
    expect(say).toBe("got it, Preston. what could i take off your plate?");
    expect(snapshot.session.userName?.value).toBe("Preston");
    expect(bodies[2]?.input.some((item) => item.type === "function_call_output")).toBe(true);
    expect(snapshot.events.filter((e) => e.channel === "voice").map((e) => e.content)).toEqual([opened.say, "i'm preston", say]);
  });
});
