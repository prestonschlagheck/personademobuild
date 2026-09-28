import "server-only";
import { NextRequest } from "next/server";
import { z } from "zod";
import { GET as openLinkRoute } from "@/app/api/oauth/google/start/route";
import { gmailConnected } from "@/lib/agent/follow-ups";
import { CUT_OFF, graduatedRow, systemEvent } from "@/lib/agent/messages";
import { mockVoiceTurn, type VoiceInput } from "@/lib/agent/mock/voice";
import { canGraduate } from "@/lib/agent/policy";
import { LINK_TTL_MS, parseToolArgs, type ToolOutput } from "@/lib/agent/tools";
import { buildVoiceSession } from "@/lib/agent/voice-session";
import { mockAccount, type MockAccount } from "@/lib/gmail/fixtures";
import { applyMockGrant, BASE_SCOPES, consentScopes, handleGoogleCallback, type OAuthResult } from "@/lib/gmail/oauth";
import { grantedLine } from "@/lib/gmail/workspace-facts";
import { endCall, heartbeat, recordTranscript, relayVoiceTool, reserveCall, spokenLine, startCall } from "@/lib/server/call-service";
import { getModes, harnessEnabled } from "@/lib/server/config";
import { DomainError } from "@/lib/server/http";
import { createResponse, type OutputItem } from "@/lib/server/openai-text";
import { rateLimit } from "@/lib/server/rate-limit";
import { mutate, readSession, readSnapshot } from "@/lib/server/session-service";
import { getStore } from "@/lib/server/store";
import { callEndReasonSchema, type Session, type SessionEvent, type Snapshot } from "@/lib/session/schema";
import { asksToHangUp, callNote, isFarewell, linkUnsaid, needsAnswer, openingNote, silenceNote, silenceStep, threadNote, UNSPOKEN_END_CALL, valueNote } from "@/lib/voice/notes";
import { LOCAL_CALL, type CallNote } from "@/lib/voice/transport";

// The live eval harness (tests/live): the real agent end to end with no browser, mic or Realtime call. A call is
// taken through the same reserve step as /api/call/accept, and each voice turn runs the exact Realtime session config
// (buildVoiceSession: instructions and tools) and the call notes on the text model, relayed through the same tool,
// transcript and call-end paths the call screen uses. The caller plays the call screen, so it counts silences the way
// the live transport does, and a hangup with nothing said is refused as the call controller refuses it. Only exists
// under `next dev` with HARNESS=1 (harnessEnabled).

// Stands in for the Realtime model: the same instructions and tools, read and answered as text.
const VOICE_TEXT_MODEL = "gpt-6-luna";
// A tool result leads to another response, as it does on a live call. The last round allows no tools, so a turn that
// keeps calling them still ends with something said, as Realtime always answers a tool result.
const MAX_ROUNDS = 6;
const TURN_BUDGET_MS = 20_000;
const EVENT_WINDOW = 300;

// `cut` is how far the agent's reply got before the user talked over it or the line went, as a fraction of it.
const voiceBody = z.object({ text: z.string().trim().min(1).max(2_000).optional(), cut: z.number().gt(0).lt(1).optional() });
const silenceBody = z.object({ count: z.number().int().min(1).max(60).optional() });
const endBody = z.object({ reason: callEndReasonSchema.default("user_hangup"), cutOff: z.string().trim().min(1).max(2_000).optional() });
// `unreadable` is Google granting access while the inbox read fails. Any fixture id is taken, so a fixture inbox added
// to lib/gmail/fixtures.ts needs nothing here; an unknown one is refused below.
const gmailBody = z.object({
  account: z.string().trim().min(1).max(40).default("inbox"),
  result: z.enum(["connected", "denied", "partial", "error", "unreadable"]).default("connected"),
});

// Which Gmail link to open: the latest, or the one it replaced.
const linkBody = z.object({ which: z.enum(["latest", "older"]).default("older") });

type Turn = { kind: "open" } | { kind: "user"; text: string } | { kind: "silence"; count?: number } | { kind: "notes" };
type Reply = { say: string; tools: { name: string; ok: boolean; error?: string }[]; ended: boolean };
type VoiceResult = Reply & { latencyMs: number; snapshot: Snapshot };

type Item = Record<string, unknown>;
const system = (content: string): Item => ({ role: "system", content });

/** The events of the current call, after its call_started row. */
function callEvents(events: SessionEvent[], attempt: number): SessionEvent[] {
  const start = events.findLast((e) => e.meta?.kind === "call_started" && e.meta.callAttempt === attempt);
  return start ? events.filter((e) => e.seq > start.seq) : [];
}

const connectedThisCall = ({ gmail, call }: Session) =>
  gmail.status === "connected" && Boolean(gmail.connectedAt && call.startedAt && gmail.connectedAt >= call.startedAt);

/**
 * A thread event the call screen passes into the call, as the note it sends (lib/voice/controller.ts). The screen
 * reads a rename by text off the session; here it is the text turn's own set_agent_name, which has no call id. The
 * screen also tells the call as soon as the session shows Gmail connected on it (valueNote); here that moment is the
 * thread's confirmation of the account.
 */
function noteOf(e: SessionEvent, session: Session): CallNote | null {
  const tool = e.meta?.tool;
  if (e.role === "tool") return !e.toolCallId && tool?.name === "set_agent_name" && tool.ok ? { note: "renamed", text: session.agentName?.value } : null;
  if (e.role === "agent" && e.meta?.kind === "confirm_account" && connectedThisCall(session)) return valueNote(session);
  return threadNote(e, session);
}

// Silences since the agent last heard anything, for a caller that does not count them itself.
function silencesSoFar(events: SessionEvent[], session: Session): number {
  const heard = events.findLastIndex((e) => (e.channel === "voice" && e.role === "user") || noteOf(e, session) !== null);
  return events.slice(heard + 1).filter((e) => e.channel === "voice" && e.role === "agent").length;
}

// The call so far as model input. Two agent lines with nothing heard or done between them were a check-in after
// a silence, so the silence note goes back in where it happened.
function callInput(session: Session, events: SessionEvent[]): Item[] {
  const items: Item[] = [system(openingNote(session))];
  let quiet = false;
  let valueNoted = false;
  let lastSaid: string | undefined;
  for (const e of events) {
    const tool = e.meta?.tool;
    if (e.channel === "voice") {
      if (e.role === "agent" && quiet) items.push(system(silenceNote("check_in", session)));
      items.push({ role: e.role === "user" ? "user" : "assistant", content: e.content });
      quiet = e.role === "agent";
      if (e.role === "agent") lastSaid = e.content;
    } else if (e.role === "tool" && tool && e.toolCallId) {
      items.push(
        { type: "function_call", call_id: e.toolCallId, name: tool.name, arguments: JSON.stringify(tool.args ?? {}) },
        { type: "function_call_output", call_id: e.toolCallId, output: JSON.stringify({ ok: tool.ok, ...(tool.error && { error: tool.error }) }) },
      );
      quiet = false;
    } else {
      const note = noteOf(e, session);
      if (!note || (note.note === "value_moment" && valueNoted)) continue;
      valueNoted ||= note.note === "value_moment";
      const { system: text, user } = callNote(note, lastSaid);
      items.push(system(text), ...(user === undefined ? [] : [{ role: "user", content: user }]));
      quiet = false;
    }
  }
  return items;
}

// A refused call answers the model the way the call screen does, so it can say so and move on.
async function relay(id: string, origin: string, attempt: number, toolCallId: string, name: string, args: unknown): Promise<ToolOutput> {
  try {
    return (await relayVoiceTool(id, { attempt, toolCallId, name, args }, origin)).output;
  } catch (err) {
    if (err instanceof DomainError) return { ok: false, error: err.error, hint: err.hint, state: "" };
    throw err;
  }
}

async function respond(input: Item[], config: ReturnType<typeof buildVoiceSession>, last: boolean, signal: AbortSignal): Promise<OutputItem[]> {
  try {
    return await createResponse(
      {
        model: VOICE_TEXT_MODEL,
        instructions: config.instructions,
        input,
        tools: config.tools.map((tool) => ({ ...tool, strict: false })),
        tool_choice: last ? "none" : config.tool_choice,
        reasoning: { effort: "none" },
        max_output_tokens: 400,
        store: false,
      },
      signal,
    );
  } catch (err) {
    throw new DomainError(502, "model_failed", err instanceof Error ? err.message : String(err));
  }
}

const spokenIn = (output: OutputItem[]) =>
  output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .flatMap((part) => (part.type === "output_text" && part.text ? [part.text] : []))
    .join(" ")
    .trim();

/** `before` is the thread up to this call's start, which a live call's instructions are built from as it connects. */
async function liveReply(id: string, origin: string, session: Session, events: SessionEvent[], before: SessionEvent[], turn: Turn): Promise<Reply> {
  const attempt = session.call.attempts;
  const input = callInput(session, events);
  const step = turn.kind === "silence" ? silenceStep(session, turn.count ?? silencesSoFar(events, session) + 1) : null;
  // Most silences pass without a word, as the transport lets them.
  if (step === "wait") return { say: "", tools: [], ended: false };
  if (step) input.push(system(silenceNote(step, session)));

  const config = buildVoiceSession(session, before);
  const signal = AbortSignal.timeout(TURN_BUDGET_MS);
  const said: string[] = [];
  const tools: Reply["tools"] = [];
  let ended = false;
  // Their latest words, and whether a hangup with nothing said was already sent back, as the call controller keeps them.
  const heard = turn.kind === "user" ? turn.text : (events.findLast((e) => e.channel === "voice" && e.role === "user")?.content ?? "");
  let refused = false;
  for (let round = 0; round < MAX_ROUNDS && !ended; round++) {
    const output = await respond(input, config, round === MAX_ROUNDS - 1, signal);
    const text = spokenIn(output);
    if (text) {
      said.push(text);
      input.push({ role: "assistant", content: text });
    }
    const calls = output.filter((item) => item.type === "function_call" && item.call_id && item.name);
    let answer = !text;
    for (const { call_id: callId = "", name = "", arguments: raw = "{}" } of calls) {
      // The call controller answers a hangup with nothing said in its response itself, once, and the model tries again,
      // unless they asked it to hang up.
      const bounced: boolean = name === "end_call" && !text && !refused && !asksToHangUp(heard);
      refused ||= bounced;
      const out = bounced ? UNSPOKEN_END_CALL : await relay(id, origin, attempt, callId, name, parseToolArgs(raw));
      tools.push({ name, ok: out.ok, ...(out.error && { error: out.error }) });
      input.push({ type: "function_call", call_id: callId, name, arguments: raw }, { type: "function_call_output", call_id: callId, output: JSON.stringify(out) });
      // The live transport asks for nothing more once an end_call goes through: the goodbye was said with it.
      ended ||= name === "end_call" && out.ok;
      answer ||= needsAnswer(out) || linkUnsaid(out, text);
    }
    // As on a live call, a response that spoke over tools that went through is not asked for another.
    if (calls.length === 0 || !answer) break;
  }
  // The silence goodbye, and a goodbye said back to theirs, end the call even when the model only says them, as the
  // live transport makes sure of.
  const farewell = turn.kind === "user" && isFarewell(turn.text, said.join(" "));
  if ((step === "goodbye" || farewell) && !ended) {
    const reason = step === "goodbye" ? "silence" : "user_request";
    const out = await relay(id, origin, attempt, `${LOCAL_CALL}${crypto.randomUUID()}_${reason}`, "end_call", { reason });
    tools.push({ name: "end_call", ok: out.ok });
    ended = out.ok;
  }
  return { say: said.join(" "), tools, ended };
}

/** The mock voice brain's input for this turn, the latest note that asks for an answer when nothing was said. */
function mockInput(session: Session, events: SessionEvent[], turn: Turn): VoiceInput | null {
  switch (turn.kind) {
    case "open":
      return { type: "start" };
    case "user":
      return { type: "user", text: turn.text };
    case "silence":
      return { type: "silence", count: turn.count ?? silencesSoFar(events, session) + 1 };
    case "notes": {
      const lastSaid = events.findLastIndex((e) => e.channel === "voice" && e.role === "agent");
      const note = events
        .slice(lastSaid + 1)
        .map((e) => noteOf(e, session))
        .findLast((n) => n !== null && callNote(n).respond);
      return note ? { type: "system", ...note } : null;
    }
  }
}

async function mockReply(id: string, origin: string, session: Session, events: SessionEvent[], turn: Turn): Promise<Reply> {
  const input = mockInput(session, events, turn);
  if (!input) return { say: "", tools: [], ended: false };
  const reply = mockVoiceTurn(session, input);
  const tools: Reply["tools"] = [];
  let ended = false;
  for (const tool of reply.tools) {
    const silent = tool.name === "end_call" && !reply.say && !(turn.kind === "user" && asksToHangUp(turn.text));
    const out = silent ? UNSPOKEN_END_CALL : await relay(id, origin, session.call.attempts, `harness_${crypto.randomUUID()}`, tool.name, tool.args);
    tools.push({ name: tool.name, ok: out.ok, ...(out.error && { error: out.error }) });
    ended ||= tool.name === "end_call" && out.ok;
  }
  return { say: reply.say, tools, ended };
}

async function voiceTurn(id: string, origin: string, turn: Turn, cut?: number): Promise<VoiceResult> {
  await rateLimit("turn", id);
  const current = await readSession(id);
  if (current.call.status !== "active") throw new DomainError(409, "call_not_active", "connect a call first");
  const attempt = current.call.attempts;
  await heartbeat(id, attempt);
  if (turn.kind === "user") await recordTranscript(id, { attempt, itemId: `harness_${crypto.randomUUID()}`, role: "user", text: turn.text });

  const [session, all] = await Promise.all([readSession(id), getStore().listEvents(id, EVENT_WINDOW)]);
  const events = callEvents(all, attempt);
  const started = performance.now();
  const before = all.slice(0, all.length - events.length);
  const reply = getModes().voice === "live" ? await liveReply(id, origin, session, events, before, turn) : await mockReply(id, origin, session, events, turn);
  const latencyMs = Math.round(performance.now() - started);

  const full = reply.say.slice(0, 2_000);
  // Words the user talked over, or that the line dropped during, are saved as far as they got, the way the call
  // screen saves an unfinished caption.
  const say = cut && full ? `${full.slice(0, Math.max(1, Math.round(full.length * cut))).trimEnd()}... ${CUT_OFF}` : full;
  if (say) await recordTranscript(id, { attempt, itemId: `harness_${crypto.randomUUID()}`, role: "agent", text: say, latencyMs }, origin);
  // The call screen hangs up once the goodbye has played; here it has already been said.
  if (reply.ended) await endCall(id, { attempt, reason: "agent_end" });
  const snapshot = await readSnapshot(id);
  // What the call screen captions, as the thread stored it.
  return { ...reply, say: say && spokenLine(say, snapshot.session), latencyMs, snapshot };
}

/**
 * Rings if nothing is ringing yet, then takes the call through /api/call/accept's own reserve step, with a harness
 * call id that never reaches OpenAI's hangup (that route needs a WebRTC offer when voice is live). The agent then
 * opens the call.
 */
async function connect(id: string, origin: string): Promise<VoiceResult> {
  const current = await readSession(id);
  if (current.call.status === "active") throw new DomainError(409, "call_active", "a call is already in progress");
  const { attempts } = current.call.status === "ringing" ? current.call : (await startCall(id, "user")).session.call;
  await reserveCall(id, attempts, `harness_${attempts}`);
  return voiceTurn(id, origin, { kind: "open" });
}

/** Ends the call through the normal path. Words cut off by the hangup are saved first, as the call screen does. */
async function end(id: string, reason: z.infer<typeof endBody>["reason"], cutOff: string | undefined): Promise<{ snapshot: Snapshot }> {
  const session = await readSession(id);
  const attempt = session.call.attempts;
  if (cutOff && session.call.status === "active") {
    await recordTranscript(id, { attempt, itemId: `harness_${crypto.randomUUID()}`, role: "user", text: `${cutOff}... ${CUT_OFF}` });
  }
  return { snapshot: await endCall(id, { attempt, reason }) };
}

async function linkState(id: string): Promise<string | null> {
  const url = (await getStore().listEvents(id, EVENT_WINDOW)).findLast((e) => e.meta?.link)?.meta?.link?.url;
  return url ? new URL(url).searchParams.get("state") : null;
}

/**
 * Google granted access but the inbox read failed, which the live callback turns into a connection with no fact.
 * No fixture can fail a read, and the callback's own connect step is private to lib/gmail/oauth.ts, so this is
 * that step for a grant with no fact: connected, the unreadable-inbox follow-up, and graduation off a call.
 */
async function connectUnreadable(id: string, email: string): Promise<OAuthResult> {
  await mutate(id, (session, now) => {
    const gmail: Session["gmail"] = { ...session.gmail, status: "connected", email, scopes: consentScopes(), connectedAt: now };
    delete gmail.valueFact;
    delete gmail.calendarFact;
    delete gmail.driveFact;
    const next: Session = { ...session, gmail, steering: { ...session.steering, skipped: session.steering.skipped.filter((slot) => slot !== "gmail") } };
    const followUp = gmailConnected(email, null, next.call.status === "active", { granted: grantedLine(gmail) });
    if (next.call.status === "active" || next.graduated || !canGraduate(next, "all_slots").ok) return { session: next, followUp };
    const graduated: Session = { ...next, graduated: true, graduatedAt: now, graduationReason: "all_slots" };
    return { session: graduated, followUp: { ...followUp, after: [systemEvent("graduated", graduatedRow(graduated))] } };
  });
  return "connected";
}

/**
 * Finishes the latest Gmail link as a fixture account would. Cancels and Google errors, and every readable result in
 * mock Gmail mode, go through the real callback. With Google keys set the callback would trade the code with Google,
 * so the link is consumed here and the fixture's grant applied by the callback's own code; a used or expired link
 * still goes to the callback for its notice.
 */
async function gmail(id: string, origin: string, account: MockAccount, result: z.infer<typeof gmailBody>["result"]) {
  const state = await linkState(id);
  if (!state) throw new DomainError(409, "no_link", "the agent has not sent a gmail link yet");
  const params = new URLSearchParams({ state });
  const code = `mock.${account.id}`;
  const scopes = result === "partial" ? BASE_SCOPES.split(" ") : consentScopes();
  let outcome: OAuthResult;
  if (result === "denied" || result === "error") {
    params.set("error", result === "denied" ? "access_denied" : "admin_policy_enforced");
    outcome = await handleGoogleCallback(params, origin);
  } else if (getModes().gmail === "mock" && result !== "unreadable") {
    params.set("code", code);
    params.set("scope", scopes.join(" "));
    outcome = await handleGoogleCallback(params, origin);
  } else if ((await getStore().consumeOAuthState(state, new Date().toISOString(), LINK_TTL_MS)) !== id) {
    outcome = await handleGoogleCallback(params, origin);
  } else {
    outcome = result === "unreadable" ? await connectUnreadable(id, account.email) : await applyMockGrant(id, code, scopes);
  }
  // The call screen tells a live call as soon as Gmail settles, and the agent speaks to it.
  const onCall = (await readSession(id)).call.status === "active";
  const voice = onCall ? await voiceTurn(id, origin, { kind: "notes" }) : null;
  return { result: outcome, say: voice?.say ?? "", ...(voice && { tools: voice.tools, ended: voice.ended }), snapshot: voice?.snapshot ?? (await readSnapshot(id)) };
}

/**
 * Opens one of the thread's Gmail links through the start route itself, as a tap on its card would, and says where it
 * led: Google, the mock consent page, or the result a dead link is sent to. The route reads the same session cookie as
 * this request. An older link must stop there, before any Google sign-in.
 */
async function openLink(id: string, origin: string, which: z.infer<typeof linkBody>["which"]) {
  const links = (await getStore().listEvents(id, EVENT_WINDOW)).flatMap((e) => {
    const url = e.meta?.link?.url;
    return url?.includes("/api/oauth/google/start") ? [url] : [];
  });
  const url = which === "latest" ? links.at(-1) : links.at(-2);
  if (!url) throw new DomainError(409, "no_link", which === "latest" ? "the agent has not sent a gmail link yet" : "only one gmail link was sent");
  const { pathname, search } = new URL(url);
  const res = await openLinkRoute(new NextRequest(`${origin}${pathname}${search}`));
  const location = res.headers.get("location") ?? "";
  const result = /accounts\.google\.com/.test(location)
    ? "google"
    : location.includes("/connect/mock")
      ? "mock"
      : (/result=(\w+)/.exec(location)?.[1] ?? `status ${res.status}`);
  return { result, snapshot: await readSnapshot(id) };
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw new DomainError(400, "invalid_body", parsed.error.issues[0]?.message);
  return parsed.data;
}

/** One harness action for the session behind the cookie. */
export async function runHarness(id: string, action: string, raw: unknown, origin: string): Promise<object> {
  // Checked here as well as in the route, since every action spends model calls or plays Google.
  if (!harnessEnabled()) throw new DomainError(404, "not_found");
  switch (action) {
    case "state":
      return { snapshot: await readSnapshot(id) };
    case "connect":
      return connect(id, origin);
    case "voice": {
      // No text means the agent answers whatever reached the call from outside it, like a text sent mid-call.
      const { text, cut } = parse(voiceBody, raw);
      return voiceTurn(id, origin, text ? { kind: "user", text } : { kind: "notes" }, cut);
    }
    case "silence":
      return voiceTurn(id, origin, { kind: "silence", count: parse(silenceBody, raw).count });
    case "end": {
      const { reason, cutOff } = parse(endBody, raw);
      return end(id, reason, cutOff);
    }
    case "gmail": {
      const { account, result } = parse(gmailBody, raw);
      const fixture = mockAccount(account);
      if (!fixture) throw new DomainError(400, "unknown_account");
      return gmail(id, origin, fixture, result);
    }
    case "link":
      return openLink(id, origin, parse(linkBody, raw).which);
    default:
      throw new DomainError(404, "unknown_action", "state, connect, voice, silence, end, gmail or link");
  }
}
