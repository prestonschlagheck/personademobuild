import type { ApiError } from "@/lib/api/contract";

// The one fetch helper. Every route authenticates by the httpOnly session cookie, so no ids travel in bodies.

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(body?.error ?? `request failed with ${status}`);
  }
}

// A half-open mobile connection would otherwise hang a request forever. Every mutating route is idempotent
// (client message ids, call attempts, tool call ids), so giving up and retrying is always safe.
const DEFAULT_TIMEOUT_MS = 10_000;

type Options = { body?: unknown; method?: "GET" | "POST" | "DELETE"; timeoutMs?: number };

export async function api<T>(
  path: string,
  { body, method = body === undefined ? "GET" : "POST", timeoutMs = DEFAULT_TIMEOUT_MS }: Options = {},
) {
  const res = await fetch(path, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(res.status, (data as ApiError | null) ?? null);
  return data as T;
}

function sendBeacon(path: string, data: string) {
  try {
    return navigator.sendBeacon(path, new Blob([data], { type: "text/plain;charset=UTF-8" }));
  } catch {
    return false;
  }
}

// For page teardown, where an ordinary fetch is cancelled. sendBeacon always POSTs and carries cookies; its
// body is text/plain because some browsers refuse a JSON Blob, and the routes it targets read text. A keepalive
// fetch covers a browser that refuses the beacon.
export function beacon(path: string, body: unknown) {
  const data = JSON.stringify(body);
  if (sendBeacon(path, data)) return;
  void fetch(path, { method: "POST", body: data, keepalive: true, credentials: "same-origin" }).catch(() => undefined);
}
