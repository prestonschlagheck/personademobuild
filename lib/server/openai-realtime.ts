import "server-only";
import { after } from "next/server";
import { secret } from "@/lib/server/config";
import { logError } from "@/lib/server/http";

// OpenAI Realtime, unified interface. The server creates the call with the browser's SDP offer, so the
// browser never holds a key, and the server can hang up any call.

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const CALL_PATH = /^\/v1\/realtime\/calls\/(rtc_[A-Za-z0-9_-]+)$/;

class RealtimeError extends Error {
  constructor(readonly status: number) {
    super(`openai realtime request failed with ${status}`);
  }
}

function callIdFrom(location: string | null) {
  if (!location) return null;
  const url = new URL(location, CALLS_URL);
  return url.origin === new URL(CALLS_URL).origin ? (CALL_PATH.exec(url.pathname)?.[1] ?? null) : null;
}

export async function createRealtimeCall(sdp: string, sessionConfig: unknown): Promise<{ sdp: string; callId: string }> {
  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(sessionConfig));

  const res = await fetch(CALLS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret("OPENAI_API_KEY")}` },
    body: form,
    // Workers has no redirect: "error"; a 3xx under "manual" is not ok, so it still fails closed below.
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new RealtimeError(res.status);

  const callId = callIdFrom(res.headers.get("location"));
  if (!callId) throw new RealtimeError(502);
  return { sdp: await res.text(), callId };
}

/** Idempotent: a call that already ended answers 404 or 409, which counts as done. */
async function hangupRealtimeCall(callId: string): Promise<void> {
  const res = await fetch(`${CALLS_URL}/${encodeURIComponent(callId)}/hangup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret("OPENAI_API_KEY")}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok && res.status !== 404 && res.status !== 409) throw new RealtimeError(res.status);
}

// The browser closes its side as well, so a hangup never needs to hold up the response.
export function hangupAfterResponse(callId: string): void {
  after(() => hangupRealtimeCall(callId).catch((err: unknown) => logError("realtime hangup", err)));
}
