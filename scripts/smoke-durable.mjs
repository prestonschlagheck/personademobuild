// Smoke test for the Durable Object store, run against `npm run cf:preview` (BASE_URL, default http://localhost:8787)
// through public routes only: a session survives a reload and stays apart from a new browser, two call starts at
// once ring once, STOP stops the ring, and a Gmail link's state is single use and dies when a fresh link replaces it.
// Usage: npm run smoke:durable. Prints one line per check and exits 1 on any failure.

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const TIME_ZONE = "America/New_York";
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";

let failed = 0;
const check = (ok, what, detail = "") => {
  if (!ok) failed++;
  process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? ` (${detail})` : ""}\n`);
  return ok;
};

/** A browser: its own cookie jar and address, so sessions and rate limits never mix. */
const client = (n) => ({ cookie: "", ip: `10.77.${Math.floor(Math.random() * 250)}.${n}` });

async function send(who, method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "x-forwarded-for": who.ip,
      ...(who.cookie && { cookie: who.cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  for (const header of res.headers.getSetCookie()) {
    const pid = /^pid=([^;]+)/.exec(header)?.[1];
    if (pid) who.cookie = `pid=${pid}`;
  }
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  return { status: res.status, data, location: res.headers.get("location") ?? "" };
}

const message = (text, clientMsgId = crypto.randomUUID()) => ({ clientMsgId, text });
const turn = (who, ...messages) => send(who, "POST", "/api/turn", { messages, timeZone: TIME_ZONE });

/** Where a link or callback sent the browser: Google, the mock consent page, or the result a dead link gets. */
const landed = ({ location, status }) =>
  /accounts\.google\.com/.test(location) ? "google" : location.includes("/connect/mock") ? "mock" : (/result=(\w+)/.exec(location)?.[1] ?? `status ${status}`);

const links = (snapshot) =>
  (snapshot?.events ?? []).flatMap((e) => (e.meta?.link?.url?.includes("/api/oauth/google/start") ? [new URL(e.meta.link.url).searchParams.get("state")] : []));

async function main() {
  const a = client(1);
  const opened = await send(a, "GET", "/api/session?resume=1");
  if (!check(opened.status === 200 && opened.data.session?.id, `a session opens at ${BASE_URL}`, `status ${opened.status}`)) return;
  const id = opened.data.session.id;
  const modes = opened.data.modes ?? {};
  if (!check(modes.store === "durable", "the session lives in a Durable Object", `store is ${modes.store}`)) return;

  // Persistence: what one request wrote, the next one (a reload) reads back from the object.
  const first = message("hey, what's a persona?");
  const hello = await turn(a, first);
  check(hello.status === 200 && hello.data.events?.some((e) => e.role === "agent"), "the opening is answered", `status ${hello.status}`);
  const named = await turn(a, message("call yourself nova"));
  check(named.data.session?.agentName?.value === "Nova", "the agent name is saved", JSON.stringify(named.data.session?.agentName ?? null));
  const again = await turn(a, first);
  const reloaded = await send(a, "GET", "/api/session?resume=1");
  const thread = reloaded.data.events ?? [];
  check(reloaded.data.session?.id === id, "a reload finds the same session");
  check(reloaded.data.session?.agentName?.value === "Nova", "a reload keeps the agent name");
  check(thread.filter((e) => e.clientMsgId === first.clientMsgId).length === 1, "a message sent twice is stored once", `status ${again.status}`);
  check((reloaded.data.session?.version ?? -1) >= (named.data.session?.version ?? 0), "the version never goes back");
  const b = client(2);
  const other = await send(b, "GET", "/api/session?resume=1");
  check(other.data.session?.id && other.data.session.id !== id, "a new browser gets its own session");

  // Two taps on call at once: the object takes one, and the other is refused as already ringing.
  const starts = await Promise.all([1, 2].map(() => send(a, "POST", "/api/call/start", { initiator: "user" })));
  const statuses = starts.map((s) => s.status).sort();
  check(statuses[0] === 200 && statuses[1] === 409, "two call starts at once ring once, and the other gets a 409", statuses.join(", "));
  check(starts.some((s) => s.data.error === "call_ringing"), "the refused start says call_ringing", starts.map((s) => s.data.error ?? "ok").join(", "));
  const ringing = await send(a, "GET", "/api/session");
  check(ringing.data.session?.call?.status === "ringing" && ringing.data.session.call.attempts === 1, "one call rings, attempt 1", JSON.stringify(ringing.data.session?.call));

  // STOP pauses everything, the ring included.
  const stopped = await turn(a, message("STOP"));
  check(Boolean(stopped.data.session?.consent?.stoppedAt), "STOP is saved");
  check(!["ringing", "active", "scheduled"].includes(stopped.data.session?.call?.status), "STOP ends the ring", stopped.data.session?.call?.status);
  const resumed = await turn(a, message("start"));
  check(!resumed.data.session?.consent?.stoppedAt, "START resumes");

  // Gmail link states: a fresh link retires the one before it, and a state finishes sign-in once.
  const asked = await turn(a, message("send me the gmail link"));
  const [older] = links(asked.data);
  if (!check(Boolean(older), "the agent sends a gmail link")) return;
  const fresh = await turn(a, message("that link didn't work, send me a fresh one"));
  const latest = links(fresh.data).at(-1);
  if (!check(Boolean(latest) && latest !== older, "a fresh link has a new state")) return;
  const start = (who, state) => send(who, "GET", `/api/oauth/google/start?state=${encodeURIComponent(state)}`);
  const replaced = landed(await start(a, older));
  check(replaced === "expired", "the replaced link is refused at the start page, before Google", replaced);
  const onward = landed(await start(a, latest));
  check(onward === "google" || onward === "mock", "the fresh link leads on to sign-in", onward);
  check(landed(await start(b, latest)) === "expired", "the link is refused in another browser");

  // Only the mock consent page takes a made-up code; with Google keys the exchange fails, which still spends the state.
  const code = modes.gmail === "mock" ? "mock.inbox" : "smoke-invalid-code";
  const callback = (state) =>
    send(a, "GET", `/api/oauth/google/callback?${new URLSearchParams({ state, code, scope: `openid email ${GMAIL_MODIFY}` })}`);
  const finished = landed(await callback(latest));
  check(finished === (modes.gmail === "mock" ? "connected" : "error"), `the callback takes the fresh state once (gmail ${modes.gmail})`, finished);
  check(landed(await callback(latest)) === "expired", "the same state is refused the second time");
  check(landed(await start(a, latest)) === "expired", "a used link is refused at the start page");
  const after = await send(a, "GET", "/api/session");
  check(after.data.session?.id === id, "the session is still the same one at the end");
  if (modes.gmail === "mock") check(after.data.session?.gmail?.status === "connected", "gmail is connected once, by the finished sign-in");
}

await main().catch((err) => {
  check(false, "the smoke run finished", err instanceof Error ? err.message : String(err));
});
process.stdout.write(`${failed ? `${failed} failed` : "all passed"} against ${BASE_URL}\n`);
if (failed) process.exitCode = 1;
