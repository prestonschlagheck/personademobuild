import type { NewEvent, Session, SessionEvent } from "@/lib/session/schema";

// Persistence boundary. Memory backs local dev; Durable Objects back production (worker/session-object.ts).
// Both implement exactly this, so nothing above the store knows which one is running.

/**
 * What a saved change writes along with the session: its thread rows and, for a Gmail link, the link's state. A save
 * can also release a turn lease and hand back the latest `recent` events, so the write that ends a turn is the only
 * round trip it needs after the model.
 */
export type Writes = { events?: NewEvent[]; oauthState?: string; releaseLease?: string; recent?: number };

export type SaveResult =
  | { ok: true; session: Session; events: SessionEvent[]; recent?: SessionEvent[] }
  | { ok: false; conflict: true };

/** Where a Gmail link's state stands, read without using it up. `unknown` is a state this session never issued. */
export type OAuthStateStatus = "unused" | "used" | "expired" | "unknown";

/** Everything a read of the session needs, in one round trip. */
export type Reading = { session: Session; events: SessionEvent[]; lastSeq: number; callLastSeen: string | null };

/** The start of a text turn. With the lease held elsewhere, `lease` is null and nothing was written. */
export type TurnStart =
  | { lease: null }
  | { lease: string; session: Session; inserted: SessionEvent[]; history: SessionEvent[] };

export interface Store {
  create(session: Session): Promise<void>;
  load(id: string): Promise<Session | null>;
  /**
   * Compare-and-set on `version`. Writes `next` with version + 1 only if the stored version still equals `expected`,
   * and in the same transaction the change's events (appended as `appendEvents` would) and its OAuth state, so a saved
   * change never lacks its rows or its link. A conflict writes none of it.
   */
  save(next: Session, expected: number, writes?: Writes): Promise<SaveResult>;
  delete(id: string): Promise<void>;

  /** The session with its latest `limit` events, the last sequence number and the call heartbeat, or null if gone. */
  read(id: string, limit: number): Promise<Reading | null>;
  /**
   * Takes the turn lease, then appends the turn's messages (as `appendEvents` would) and returns the session with its
   * latest `historyLimit` events, all in one step. The lease is released by `releaseTurnLease` or by a save that
   * names it.
   */
  beginTurn(id: string, leaseMs: number, events: NewEvent[], historyLimit: number): Promise<TurnStart>;

  /** Append-only. Duplicate `clientMsgId` or `toolCallId` for the same session is skipped, not an error. */
  appendEvents(sessionId: string, events: NewEvent[]): Promise<SessionEvent[]>;
  listEvents(sessionId: string, limit: number): Promise<SessionEvent[]>;
  lastSeq(sessionId: string): Promise<number>;

  /**
   * A short lease so two turns for one session never interleave. Returns the holder's token, or null while
   * another holder has it. Release takes the token, so a turn that outlived its lease never frees a newer one.
   */
  acquireTurnLease(sessionId: string, ms: number): Promise<string | null>;
  releaseTurnLease(sessionId: string, token: string): Promise<void>;

  /**
   * The session's Google sign-in, sealed (lib/gmail/grant.ts), kept apart from the session so it never reaches the
   * browser, a snapshot or the archive. Null clears it.
   */
  setGoogleGrant(sessionId: string, sealed: string | null): Promise<void>;
  googleGrant(sessionId: string): Promise<string | null>;

  /** Call heartbeat, kept out of versioned state so pings never cause write conflicts. */
  touchCall(sessionId: string, at: string): Promise<void>;
  callLastSeen(sessionId: string): Promise<string | null>;

  /** Single-use OAuth `state` nonces. `consume` returns the owning session id once, then null forever. */
  createOAuthState(state: string, sessionId: string, at: string): Promise<void>;
  /**
   * The session a state was issued to, used or not, without consuming it. `sessionId` is the browser's own session:
   * sign-in only ever finishes in the browser that owns the link, and the Durable Object store keeps each state inside
   * its session's object, so it only looks there and answers null without it.
   */
  oauthStateOwner(state: string, sessionId?: string): Promise<string | null>;
  /**
   * What `consumeOAuthState` would find, without consuming: unused, used (or replaced by a newer link), older than
   * `maxAgeMs` at `at`, or unknown to `sessionId`. The link's opening checks it so a dead link never reaches Google.
   */
  oauthStateStatus(state: string, at: string, maxAgeMs: number, sessionId?: string): Promise<OAuthStateStatus>;
  consumeOAuthState(state: string, at: string, maxAgeMs: number, sessionId?: string): Promise<string | null>;
}
