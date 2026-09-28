import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { Modes } from "@/lib/session/schema";

// Every integration switches from its local stand-in to the real service as soon as its keys exist,
// independently of the others. Secrets are read here and nowhere in client code.

type Secret = "OPENAI_API_KEY" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET";

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

// wrangler.jsonc sets APP_ENV="production" for the deployed worker.
const isProduction = () => process.env.APP_ENV === "production";

// A production deploy with a missing key must fail loudly, never serve a stand-in: the mock consent page would mark
// Gmail connected with a fixture account, and the memory store lives in one isolate, so sessions and
// OAuth state would vanish between requests. Nor does production ever run without OPENAI_API_KEY: the mock voice is the
// browser's own speech, which must never stand in for the real agent. No flag relaxes any of it.
export function getModes(): Modes {
  const modes: Modes = {
    text: env("OPENAI_API_KEY") ? "live" : "mock",
    voice: env("OPENAI_API_KEY") ? "live" : "mock",
    gmail: env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET") ? "live" : "mock",
    store: env("STORE") === "durable" ? "durable" : "memory",
  };
  if (!isProduction()) return modes;
  if (modes.gmail === "mock" || modes.store === "memory") throw new Error("production needs the Google OAuth keys and the Durable Object store");
  if (modes.voice === "mock" || modes.text === "mock") throw new Error("production needs OPENAI_API_KEY");
  return modes;
}

/**
 * The eval harness stands in for Google and the call screen, so it runs only under `next dev` with HARNESS=1. A build
 * or a deploy never serves it, whatever its env says.
 */
export function harnessEnabled(): boolean {
  return env("HARNESS") === "1" && process.env.NODE_ENV === "development" && !isProduction();
}

export function secret(name: Secret): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Scheduled routes answer only a request carrying CRON_SECRET, sent by the session's own Durable Object alarm. */
export function cronAuthorized(authorization: string | null): boolean {
  const expected = env("CRON_SECRET");
  if (!expected || !authorization) return false;
  const given = Buffer.from(authorization);
  const wanted = Buffer.from(`Bearer ${expected}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * How a call decides the caller has finished. "server" (the default) answers after 400 ms of silence, which keeps the
 * call snappy; "semantic" judges from the words and can wait seconds after they stop. Set VOICE_TURN_DETECTION=semantic
 * to compare them on real calls.
 */
export function voiceTurnDetection(): "server" | "semantic" {
  return env("VOICE_TURN_DETECTION") === "semantic" ? "semantic" : "server";
}

/** "modify" (the default) is read and write across Gmail; "readonly" and "labels" are narrower, for comparison. */
export function gmailScopeMode(): "modify" | "readonly" | "labels" {
  const mode = env("GMAIL_SCOPE_MODE");
  return mode === "labels" || mode === "readonly" ? mode : "modify";
}

/** The exact redirect registered with Google. Falls back to this origin for local development. */
export function googleRedirectUri(origin: string): string {
  return env("GOOGLE_REDIRECT_URI") ?? `${origin}/api/oauth/google/callback`;
}
