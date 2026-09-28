import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getModes } from "@/lib/server/config";
import { clientIp, DomainError } from "@/lib/server/http";

// Sliding windows. On Cloudflare a session's buckets live in its own Durable Object and an address's in one
// LimiterObject per address (worker/session-object.ts), so each limit is exact across every instance of the worker,
// for one round trip that runs the keys in parallel. Under next dev they are counted in this process's memory.

// Each session has its own limit, and its address gets three sessions' worth for testers behind one office network.
// Creating a session costs the address a hit, so starting over never resets what the address has used.
const RULES = {
  turn: { max: 20, windowMs: 60_000 },
  turnIp: { max: 60, windowMs: 60_000 },
  // There is no cap on calls in a session, only on how fast they start: a ring every 20 s at most, on average.
  callStart: { max: 30, windowMs: 10 * 60_000 },
  callStartIp: { max: 90, windowMs: 10 * 60_000 },
  // Every accept opens a paid Realtime call, whoever rang: the user, the agent, or a booked callback.
  callAccept: { max: 40, windowMs: 10 * 60_000 },
  callAcceptIp: { max: 120, windowMs: 10 * 60_000 },
  sessionCreate: { max: 60, windowMs: 10 * 60_000 },
  // Writes outside a turn: transcripts, voice tools, tapbacks and contact saves.
  write: { max: 120, windowMs: 60_000 },
  writeIp: { max: 360, windowMs: 60_000 },
  // A call pings every 5 s, with a quick retry after a miss. Its own bucket, so a flood of tapbacks can never starve
  // the pings and time the call out.
  heartbeat: { max: 60, windowMs: 60_000 },
  heartbeatIp: { max: 180, windowMs: 60_000 },
} as const;

export type RateBucket = keyof typeof RULES;

const holder = globalThis as typeof globalThis & { __personaRateLimits?: Map<string, number[]> };
const hits = (holder.__personaRateLimits ??= new Map<string, number[]>());

const isBucket = (name: string): name is RateBucket => Object.hasOwn(RULES, name);

// Each key expires by its own bucket's window, so a flood in a short bucket never resets a long one.
function prune(now: number) {
  for (const [key, times] of hits) {
    const bucket = key.slice(0, key.indexOf(":"));
    const windowMs = isBucket(bucket) ? RULES[bucket].windowMs : 0;
    if (times.every((t) => now - t >= windowMs)) hits.delete(key);
  }
}

// Records a hit on every key, or on none when any of them is already at its limit.
function take(keys: [RateBucket, string][], now: number): void {
  const windows = keys.map(([bucket, key]) => {
    const id = `${bucket}:${key}`;
    return { id, bucket, recent: (hits.get(id) ?? []).filter((t) => now - t < RULES[bucket].windowMs) };
  });
  const full = windows.some(({ bucket, recent }) => recent.length >= RULES[bucket].max);
  for (const { id, recent } of windows) hits.set(id, full ? recent : [...recent, now]);
  if (full) throw new DomainError(429, "rate_limited", "slow down a little and try again");
  if (hits.size > 10_000) prune(now);
}

// All keys are taken at once, in one round trip. Each takes its own hit, so a request one key refuses still counts
// against the others: a session flooding past its own limit also spends its address's, which only slows that address.
const PER_ADDRESS = new Set<RateBucket>(["turnIp", "callStartIp", "callAcceptIp", "writeIp", "heartbeatIp", "sessionCreate"]);

async function takeDurable(keys: [RateBucket, string][], now: number): Promise<void> {
  const { SESSIONS, LIMITS } = getCloudflareContext().env;
  const taken = await Promise.all(
    keys.map(([bucket, key]) => {
      const { max, windowMs } = RULES[bucket];
      const stub = PER_ADDRESS.has(bucket) ? LIMITS.getByName(`address:${key}`) : SESSIONS.getByName(key);
      return stub.take(bucket, max, windowMs, now);
    }),
  );
  if (taken.includes(false)) throw new DomainError(429, "rate_limited", "slow down a little and try again");
}

async function limit(keys: [RateBucket, string][], now: number): Promise<void> {
  if (getModes().store === "durable") return takeDurable(keys, now);
  take(keys, now);
}

/** Records a hit, or throws 429 when the key is over its limit for the window. */
export function rateLimit(bucket: RateBucket, key: string, now = Date.now()): Promise<void> {
  return limit([[bucket, key]], now);
}

/** One request against its session and its address together. In memory, a refusal from either counts against neither. */
export async function rateLimitRequest(
  bucket: "callStart" | "callAccept" | "write" | "heartbeat",
  sessionId: string,
  now = Date.now(),
): Promise<void> {
  return limit([[bucket, sessionId], [`${bucket}Ip`, await clientIp()]], now);
}
