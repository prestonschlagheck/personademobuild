import "server-only";
import { z } from "zod";
import { graduatedRow, systemEvent } from "@/lib/agent/messages";
import { gmailConnected, inboxUnreadable, oauthDenied, oauthError, partialGrant, staleLink, stillConnected, type FollowUp } from "@/lib/agent/follow-ups";
import { canGraduate } from "@/lib/agent/policy";
import { LINK_TTL_MS } from "@/lib/agent/tools";
import { mockAccount, mockInbox } from "@/lib/gmail/fixtures";
import { inboxUnread, readInbox } from "@/lib/gmail/gmail-api";
import { revokeGrant, revokeToken, saveGrant, TOKEN_URL, type Grant as GoogleGrant } from "@/lib/gmail/grant";
import { businessInNeed, needQuery } from "@/lib/gmail/queries";
import { inboxFinding } from "@/lib/gmail/value-fact";
import { topFolders, upcomingEvents } from "@/lib/gmail/workspace-api";
import { calendarFact, driveFact, grantedLine, valueLine, type CalendarEvent, type Workspace } from "@/lib/gmail/workspace-facts";
import type { Transition } from "@/lib/server/call-timers";
import { getModes, gmailScopeMode, googleRedirectUri, harnessEnabled, secret } from "@/lib/server/config";
import { DomainError, logError } from "@/lib/server/http";
import { mutate, readSession, readSnapshot, requireSession, sendFollowUp } from "@/lib/server/session-service";
import { getStore } from "@/lib/server/store";
import type { GmailStatus, HelpCategory, Session } from "@/lib/session/schema";

// Google sign-in for Gmail, Calendar and Drive: a single-use state, an exact redirect URI, a granted-scope
// check, one verifying Gmail call, and the value line for the need plus one fact each for Calendar and Drive. The
// sign-in is then kept, sealed and server-side only (lib/gmail/grant.ts), so the agent can search, read, draft and,
// with their yes, send (lib/gmail/tools.ts). Only this module can mark Gmail connected.

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

const GMAIL_SCOPES = {
  // Everything but deleting mail for good past the Trash: read, labels, drafts, send, archive and trash.
  modify: "https://www.googleapis.com/auth/gmail.modify",
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  labels: "https://www.googleapis.com/auth/gmail.labels",
} as const;

export const BASE_SCOPES = "openid email";
export const gmailScope = () => GMAIL_SCOPES[gmailScopeMode()];
// Read-only and optional: Google lets the user untick either one, and Gmail still connects without them.
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
// gmail.labels is the non-sensitive fallback: inbox counts only, no message metadata, and no Calendar or Drive.
const labelsOnly = () => gmailScopeMode() === "labels";
export const extraScopes = () => (labelsOnly() ? [] : [CALENDAR_SCOPE, DRIVE_SCOPE]);
/**
 * The whole consent request: who you are, Gmail (read and write by default), and read-only Calendar events and Drive
 * file names. Never Contacts or file contents.
 */
export const consentScopes = () => [...BASE_SCOPES.split(" "), gmailScope(), ...extraScopes()];

/** `unreadable`: Google granted access, but Gmail would not answer the verifying read, so nothing connected. */
export type OAuthResult = "connected" | "denied" | "partial" | "expired" | "error" | "unreadable";

type Extras = { calendarFact?: string; driveFact?: string };
/** `anchors` are the names or count the inbox fact was built from (lib/gmail/value-fact.ts). */
type Grant =
  | ({ result: "connected"; email: string; scopes: string[]; fact: string | null; anchors: string[]; google: GoogleGrant } & Extras)
  | { result: "denied" | "partial" | "error" | "unreadable" };
// What the facts are tailored to: the help need picks the searches and the offer, the zone words the calendar's times.
type FactContext = { category: HelpCategory | null; need: string | null; timeZone: string | undefined };

// Calendar and Drive are read only when their scope was granted, and one that fails to read is left out rather than
// failing the connect.
async function readWorkspace(scopes: string[], events: () => Promise<CalendarEvent[]>, folders: () => Promise<string[]>): Promise<Workspace> {
  const [calendar, drive] = await Promise.all([
    scopes.includes(CALENDAR_SCOPE) ? events().catch((err: unknown) => (logError("calendar read", err), undefined)) : undefined,
    scopes.includes(DRIVE_SCOPE) ? folders().catch((err: unknown) => (logError("drive read", err), undefined)) : undefined,
  ]);
  return { ...(calendar && { events: calendar }), ...(drive && { folders: drive }) };
}

function workspaceFacts({ events, folders }: Workspace, now: Date, timeZone: string | undefined): Extras {
  return { ...(events && { calendarFact: calendarFact(events, now, timeZone) }), ...(folders && { driveFact: driveFact(folders) }) };
}

export const doneUrl = (result: OAuthResult, base: string) => new URL(`/connect/done?result=${result}`, base);

// No include_granted_scopes, so the token never carries access granted to this app before. Offline access with the
// consent screen every time, so Google always hands back a refresh token the session can keep.
export function googleAuthorizeUrl(state: string, origin: string) {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: secret("GOOGLE_CLIENT_ID"),
    redirect_uri: googleRedirectUri(origin),
    scope: consentScopes().join(" "),
    state,
    access_type: "offline",
    prompt: "consent select_account",
  }).toString();
  return url;
}

// Only a missing access token fails the parse, so any token Google hands back always reaches the revoke.
const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional().catch(undefined),
  expires_in: z.number().catch(3_600),
  scope: z.string().catch(""),
  id_token: z.string().optional().catch(undefined),
});
const claimsSchema = z.object({ email: z.email() });

// Read without a signature check: it came straight from Google's token endpoint over TLS.
function emailFromIdToken(idToken: string | undefined) {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = claimsSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return claims.success ? claims.data.email : null;
  } catch {
    return null;
  }
}

async function exchangeCode(code: string, origin: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: googleRedirectUri(origin),
      client_id: secret("GOOGLE_CLIENT_ID"),
      client_secret: secret("GOOGLE_CLIENT_SECRET"),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`google token exchange failed with ${res.status}`);
  const token = tokenSchema.parse(await res.json());
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1_000,
    scopes: token.scope.split(" ").filter(Boolean),
    email: emailFromIdToken(token.id_token),
  };
}

async function liveGrant(code: string, origin: string, { category, need, timeZone }: FactContext): Promise<Grant> {
  const { accessToken, refreshToken, expiresAt, scopes, email } = await exchangeCode(code, origin);
  let kept = false;
  try {
    if (!scopes.includes(gmailScope())) return { result: "partial" };
    if (!email) return { result: "error" };
    // The label read is the verification; the need's searches and the extras ride alongside it and may fail on their own.
    const now = new Date();
    const [unread, inbox, workspace] = await Promise.all([
      inboxUnread(accessToken).catch((err: unknown) => (logError("gmail verify", err), null)),
      labelsOnly()
        ? { messages: [] }
        : readInbox(accessToken, needQuery(category), businessInNeed(need ?? "")).catch((err: unknown) => (logError("gmail search", err), null)),
      readWorkspace(scopes, () => upcomingEvents(accessToken, now), () => topFolders(accessToken)),
    ]);
    if (unread === null) return { result: "unreadable" };
    const finding = inbox && inboxFinding({ unread, ...inbox, labelsOnly: labelsOnly() }, category, now);
    const fact = finding && valueLine(finding, workspace, now, timeZone);
    kept = true;
    const google: GoogleGrant = { accessToken, ...(refreshToken && { refreshToken }), expiresAt, email, scopes };
    return { result: "connected", email, scopes, fact, anchors: finding?.anchors ?? [], google, ...workspaceFacts(workspace, now, timeZone) };
  } finally {
    // A sign-in that did not connect is handed back at once.
    if (!kept) await revokeToken(refreshToken ?? accessToken);
  }
}

// The mock consent page answers like Google does: a code naming the fixture, and the granted scopes.
async function mockGrant(code: string, scopes: string[], { category, need, timeZone }: FactContext): Promise<Grant> {
  const account = mockAccount(code.replace(/^mock\./, ""));
  if (!account) return { result: "error" };
  if (!scopes.includes(gmailScope())) return { result: "partial" };
  const now = new Date();
  const inbox = labelsOnly() ? { unread: account.unread, messages: [], labelsOnly: true } : mockInbox(account, now, businessInNeed(need ?? ""));
  const workspace = await readWorkspace(scopes, async () => account.events(now), async () => account.folders);
  const finding = inboxFinding(inbox, category, now);
  const fact = valueLine(finding, workspace, now, timeZone);
  // A fixture sign-in the tools read from lib/gmail/fixtures.ts, never Google.
  const google: GoogleGrant = { accessToken: `mock:${code.replace(/^mock\./, "")}`, expiresAt: Number.MAX_SAFE_INTEGER, email: account.email, scopes };
  return { result: "connected", email: account.email, scopes, fact, anchors: finding.anchors, google, ...workspaceFacts(workspace, now, timeZone) };
}

async function resolveGrant(params: URLSearchParams, origin: string, context: FactContext): Promise<Grant> {
  const error = params.get("error");
  if (error) return { result: error === "access_denied" ? "denied" : "error" };
  const code = params.get("code");
  if (!code) return { result: "error" };
  if (getModes().gmail === "live") return liveGrant(code, origin, context);
  return mockGrant(code, params.getAll("scope").join(" ").split(" ").filter(Boolean), context);
}

const factContext = (session: Session): FactContext => ({
  category: session.helpNeed?.category ?? null,
  need: session.helpNeed?.value ?? null,
  timeZone: session.timeZone,
});

function withGmail(session: Session, status: GmailStatus, followUp: FollowUp, skip = false): Transition {
  const skipped = session.steering.skipped.filter((s) => s !== "gmail");
  return {
    session: {
      ...session,
      gmail: { ...session.gmail, status },
      steering: { ...session.steering, skipped: skip ? [...skipped, "gmail"] : skipped },
    },
    events: [],
    followUp,
  };
}

// Off a call the fact lands in the thread when it answers their need, and Gmail settling the last slot graduates here.
// On a live call the voice client has the agent speak the rest and the thread only confirms the account; a call that
// ends before the agent says a fact that answers their need gets it by text afterwards (lib/agent/follow-ups.ts), and
// the agent or the hangup graduates. The model may only reword the fact; the follow-up checks hold it to it.
function connect(session: Session, grant: Extract<Grant, { result: "connected" }>, now: string): Transition {
  const { email, scopes, fact, anchors, calendarFact, driveFact } = grant;
  // A grant over a connection they already had is them adding access on purpose, so it is not questioned again.
  const again = session.gmail.status === "connected";
  // The thread names the Calendar and Drive access they allowed, never what it saw there; the facts stay on the session
  // for a later question about either.
  const followUp = gmailConnected(email, fact, session.call.status === "active", { granted: grantedLine({ scopes }), anchors }, again, session);
  const base = withGmail(session, "connected", followUp);
  const gmail: Session["gmail"] = { ...base.session.gmail, email, scopes, connectedAt: now };
  // A link sent while connected has landed, and a reconnect replaces every fact, so one the new grant did not allow
  // never lingers from the last.
  delete gmail.pendingLinkAt;
  if (fact) gmail.valueFact = fact;
  else delete gmail.valueFact;
  if (calendarFact) gmail.calendarFact = calendarFact;
  else delete gmail.calendarFact;
  if (driveFact) gmail.driveFact = driveFact;
  else delete gmail.driveFact;
  const next: Session = { ...base.session, gmail };
  if (next.call.status === "active" || next.graduated || !canGraduate(next, "all_slots").ok) return { ...base, session: next };
  const graduated: Session = { ...next, graduated: true, graduatedAt: now, graduationReason: "all_slots" };
  return { session: graduated, events: [], followUp: { ...followUp, after: [systemEvent("graduated", graduatedRow(graduated))] } };
}

function applyGrant(session: Session, grant: Grant, now: string): Transition {
  if (grant.result === "connected") return connect(session, grant, now);
  // A connection that worked stays until a new grant lands: a link sent while connected that is cancelled or fails is
  // spent and changes nothing else, and the thread says so rather than going quiet.
  if (session.gmail.status === "connected") {
    const gmail = { ...session.gmail };
    delete gmail.pendingLinkAt;
    const followUp = gmail.email ? stillConnected(gmail.email) : undefined;
    return { session: session.gmail.pendingLinkAt ? { ...session, gmail } : session, events: [], ...(followUp && { followUp }) };
  }
  switch (grant.result) {
    case "denied":
      return withGmail(session, "denied", oauthDenied(), true);
    case "partial":
      return withGmail(session, "denied", partialGrant());
    case "error":
      return withGmail(session, "error", oauthError());
    case "unreadable":
      return withGmail(session, "error", inboxUnreadable());
    default: {
      const unknown: never = grant;
      return unknown;
    }
  }
}

// Only a request that carried a state reaches here, and a repeat never stacks a second notice.
async function rejectLink(owner: string | null): Promise<OAuthResult> {
  if (!owner) return "expired";
  await sendFollowUp(owner, staleLink(), (history) => history.findLast((e) => e.channel === "text" && e.role === "agent")?.meta?.kind !== "stale_link");
  return "expired";
}

/**
 * A cheap early check so a used, replaced or expired link never reaches Google: the callback's own test of the state,
 * without consuming it, which the callback still does as the real gate. A live link that opens is stamped, since
 * Google sign-in can outlast a call's heartbeat (lib/server/call-timers.ts).
 */
async function openLink(owner: string, state: string): Promise<boolean> {
  const status = await getStore().oauthStateStatus(state, new Date().toISOString(), LINK_TTL_MS, owner);
  if (status !== "unused") return false;
  await mutate(owner, (session, now) => ({ session: { ...session, gmail: { ...session.gmail, openedAt: now } } })).catch((err: unknown) =>
    logError("oauth open", err),
  );
  return true;
}

/** Where the texted Gmail link sends the browser: Google, the mock consent page, or an expired notice. */
export async function signInTarget(state: string | null, base: string) {
  if (!state) return doneUrl("expired", base);
  const owner = await requireSession().catch(() => null);
  if (!owner || !(await openLink(owner, state))) return doneUrl(await rejectLink(owner), base);
  if (getModes().gmail === "live") return googleAuthorizeUrl(state, new URL(base).origin);
  return new URL(`/connect/mock?${new URLSearchParams({ state })}`, base);
}

/** The Gmail address connected to this browser's session, for the return page. Never taken from the URL. */
export async function connectedEmail(): Promise<string | null> {
  const owner = await requireSession().catch(() => null);
  const session = owner ? await readSession(owner).catch(() => null) : null;
  return session?.gmail.status === "connected" ? (session.gmail.email ?? null) : null;
}

/**
 * A fixture account's grant, applied exactly as the callback applies any grant. For the eval harness, which plays a
 * sign-in that Google would otherwise finish, once it has consumed the link's single-use state itself.
 */
export async function applyMockGrant(sessionId: string, code: string, scopes: string[]): Promise<OAuthResult> {
  // It connects a fixture inbox with no Google in the loop, so it never runs outside the harness.
  if (!harnessEnabled()) throw new DomainError(404, "not_found");
  const { session } = await readSnapshot(sessionId);
  const grant = await mockGrant(code, scopes, factContext(session));
  await keep(sessionId, grant);
  await mutate(sessionId, (current, now) => applyGrant(current, grant, now));
  return grant.result;
}

// Stored before the session says connected, so the agent's first look at the inbox always finds the sign-in. A new
// grant replaces the one a more-access link kept waiting, which is handed back to Google here; a wrong account's went
// back when the link that replaces it was sent (send_gmail_link in lib/agent/tools.ts).
async function keep(sessionId: string, grant: Grant) {
  if (grant.result !== "connected") return;
  await revokeGrant(sessionId);
  await saveGrant(sessionId, grant.google);
}

export async function handleGoogleCallback(params: URLSearchParams, base: string): Promise<OAuthResult> {
  const owner = await requireSession().catch(() => null);
  const state = params.get("state");
  if (!state) return "expired";
  const sessionId = owner && (await getStore().consumeOAuthState(state, new Date().toISOString(), LINK_TTL_MS, owner));
  // Sign-in must finish in the browser that owns the session, so a forwarded link can never
  // attach someone else's inbox to it.
  if (!sessionId || sessionId !== owner) return rejectLink(owner);

  const { session } = await readSnapshot(sessionId);
  const grant = await resolveGrant(params, new URL(base).origin, factContext(session)).catch((err: unknown): Grant => {
    logError("gmail connect", err);
    return { result: "error" };
  });
  await keep(sessionId, grant);
  await mutate(sessionId, (current, now) => applyGrant(current, grant, now));
  return grant.result;
}
