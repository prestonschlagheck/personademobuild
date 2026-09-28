import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Store } from "@/lib/server/store/types";

// Cloudflare Durable Objects: one object per session holds its state, thread, lease and Gmail link states
// (worker/session-object.ts). Each call is one RPC to the object that owns
// the data, so there is no shared database on the hot path and no lock to wait on. Every call crosses the network in
// production, so the hot paths use the batched ones (read, beginTurn, a save that returns the thread).

function env() {
  return getCloudflareContext().env;
}

const session = (id: string) => env().SESSIONS.getByName(id);

export function createDurableStore(): Store {
  return {
    create: (s) => session(s.id).create(s),
    load: (id) => session(id).load(),

    save: (next, expected, { events = [], oauthState, releaseLease, recent } = {}) =>
      session(next.id).save(next, expected, events, oauthState, { releaseLease, recent }),

    read: (id, limit) => session(id).read(limit),
    beginTurn: (id, leaseMs, events, historyLimit) => session(id).beginTurn(leaseMs, events, historyLimit),

    delete: (id) => session(id).destroy(),
    appendEvents: (id, events) => session(id).appendEvents(events),
    listEvents: (id, limit) => session(id).listEvents(limit),
    lastSeq: (id) => session(id).lastSeq(),
    acquireTurnLease: (id, ms) => session(id).acquireTurnLease(ms),
    releaseTurnLease: (id, token) => session(id).releaseTurnLease(token),

    setGoogleGrant: (id, sealed) => session(id).setGoogleGrant(sealed),
    googleGrant: (id) => session(id).googleGrant(),

    touchCall: (id, at) => session(id).touchCall(at),
    callLastSeen: (id) => session(id).callLastSeen(),

    createOAuthState: (state, sessionId, at) => session(sessionId).createOAuthState(state, at),

    // A Gmail link's state lives in its session's own object, so it is looked up in the browser's session, the only
    // one allowed to finish that sign-in. No shared directory, and no new object to create when a link goes out.
    async oauthStateOwner(state, sessionId) {
      return sessionId && (await session(sessionId).hasOAuthState(state)) ? sessionId : null;
    },

    async oauthStateStatus(state, at, maxAgeMs, sessionId) {
      return sessionId ? session(sessionId).oauthStateStatus(state, at, maxAgeMs) : "unknown";
    },

    async consumeOAuthState(state, at, maxAgeMs, sessionId) {
      return sessionId && (await session(sessionId).consumeOAuthState(state, at, maxAgeMs)) ? sessionId : null;
    },
  };
}
