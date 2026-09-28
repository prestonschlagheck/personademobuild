import "server-only";
import type { NewEvent, Session, SessionEvent } from "@/lib/session/schema";
import type { SaveResult, Store } from "@/lib/server/store/types";
import { devLogBackfill, devLogEvent, devLogState } from "@/lib/server/dev-log";

// Local development store with the same semantics as the Durable Object one: compare-and-set saves that
// carry their rows and link, idempotent appends, an event sequence per session. Kept on globalThis so hot
// reloads keep sessions.

type Row = { session: Session; events: SessionEvent[]; lease: { token: string; until: number } | null; callLastSeen: string | null; grant?: string };
type OAuthRow = { sessionId: string; createdAt: string; usedAt?: string };
type Memory = { sessions: Map<string, Row>; oauth: Map<string, OAuthRow> };

export function createMemoryStore(memory: Memory = { sessions: new Map(), oauth: new Map() }): Store {
  const row = (id: string) => memory.sessions.get(id);

  function insert(found: Row, events: NewEvent[]): SessionEvent[] {
    const inserted: SessionEvent[] = [];
    for (const event of events) {
      const duplicate = found.events.some(
        (e) => (event.clientMsgId && e.clientMsgId === event.clientMsgId) || (event.toolCallId && e.toolCallId === event.toolCallId),
      );
      if (duplicate) continue;
      const { at, ...rest } = event;
      // Numbered per session from 1, as each session's Durable Object numbers its own.
      const seq = (found.events.at(-1)?.seq ?? 0) + 1;
      const stored: SessionEvent = { ...structuredClone(rest), seq, id: crypto.randomUUID(), at: at ?? new Date().toISOString() };
      found.events.push(stored);
      inserted.push(structuredClone(stored));
      devLogEvent(found.session.id, stored);
    }
    return inserted;
  }

  return {
    async create(session) {
      memory.sessions.set(session.id, { session: structuredClone(session), events: [], lease: null, callLastSeen: null });
    },

    async load(id) {
      const found = row(id);
      return found ? structuredClone(found.session) : null;
    },

    async save(next, expected, { events = [], oauthState, releaseLease, recent } = {}): Promise<SaveResult> {
      const found = row(next.id);
      if (!found || found.session.version !== expected) return { ok: false, conflict: true };
      // Nothing below awaits, so the session, its link and its rows land together, as one Durable Object write does.
      found.session = structuredClone({ ...next, version: expected + 1 });
      if (oauthState) {
        // A fresh link replaces the one before it, so no earlier link can still finish sign-in.
        for (const entry of memory.oauth.values()) if (entry.sessionId === next.id) entry.usedAt ??= next.updatedAt;
        memory.oauth.set(oauthState, { sessionId: next.id, createdAt: next.updatedAt });
      }
      devLogState(found.session);
      const inserted = insert(found, events);
      if (releaseLease && found.lease?.token === releaseLease) found.lease = null;
      return {
        ok: true,
        session: structuredClone(found.session),
        events: inserted,
        ...(recent && { recent: structuredClone(found.events.slice(-recent)) }),
      };
    },

    async read(id, limit) {
      const found = row(id);
      if (!found) return null;
      const events = structuredClone(found.events.slice(-limit));
      return { session: structuredClone(found.session), events, lastSeq: found.events.at(-1)?.seq ?? 0, callLastSeen: found.callLastSeen };
    },

    async beginTurn(id, leaseMs, events, historyLimit) {
      const found = row(id);
      const now = Date.now();
      if (!found || (found.lease && found.lease.until > now)) return { lease: null };
      found.lease = { token: crypto.randomUUID(), until: now + leaseMs };
      const inserted = insert(found, events);
      return { lease: found.lease.token, session: structuredClone(found.session), inserted, history: structuredClone(found.events.slice(-historyLimit)) };
    },

    async delete(id) {
      memory.sessions.delete(id);
      for (const [state, entry] of memory.oauth) if (entry.sessionId === id) memory.oauth.delete(state);
    },

    async appendEvents(sessionId, events) {
      const found = row(sessionId);
      if (!found) throw new Error(`session ${sessionId} not found`);
      return insert(found, events);
    },

    async listEvents(sessionId, limit) {
      return structuredClone(row(sessionId)?.events.slice(-limit) ?? []);
    },

    async lastSeq(sessionId) {
      return row(sessionId)?.events.at(-1)?.seq ?? 0;
    },

    async acquireTurnLease(sessionId, ms) {
      const found = row(sessionId);
      const now = Date.now();
      if (!found || (found.lease && found.lease.until > now)) return null;
      found.lease = { token: crypto.randomUUID(), until: now + ms };
      return found.lease.token;
    },

    async releaseTurnLease(sessionId, token) {
      const found = row(sessionId);
      if (found?.lease?.token === token) found.lease = null;
    },

    async setGoogleGrant(sessionId, sealed) {
      const found = row(sessionId);
      if (!found) return;
      if (sealed === null) delete found.grant;
      else found.grant = sealed;
    },

    async googleGrant(sessionId) {
      return row(sessionId)?.grant ?? null;
    },

    async touchCall(sessionId, at) {
      const found = row(sessionId);
      if (found) found.callLastSeen = at;
    },

    async callLastSeen(sessionId) {
      return row(sessionId)?.callLastSeen ?? null;
    },

    async createOAuthState(state, sessionId, at) {
      memory.oauth.set(state, { sessionId, createdAt: at });
    },

    async oauthStateOwner(state) {
      return memory.oauth.get(state)?.sessionId ?? null;
    },

    async oauthStateStatus(state, at, maxAgeMs, sessionId) {
      const entry = memory.oauth.get(state);
      if (!entry || (sessionId && entry.sessionId !== sessionId) || !memory.sessions.has(entry.sessionId)) return "unknown";
      if (entry.usedAt) return "used";
      return Date.parse(at) - Date.parse(entry.createdAt) > maxAgeMs ? "expired" : "unused";
    },

    async consumeOAuthState(state, at, maxAgeMs) {
      const entry = memory.oauth.get(state);
      if (!entry || entry.usedAt || Date.parse(at) - Date.parse(entry.createdAt) > maxAgeMs) return null;
      entry.usedAt = at;
      return memory.sessions.has(entry.sessionId) ? entry.sessionId : null;
    },
  };
}

const holder = globalThis as typeof globalThis & { __personaMemory?: Memory };

export const memoryStore = createMemoryStore((holder.__personaMemory ??= { sessions: new Map(), oauth: new Map() }));
devLogBackfill(holder.__personaMemory.sessions.values());
