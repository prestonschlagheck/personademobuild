import "server-only";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";
import type { ApiError } from "@/lib/api/contract";

// Shared plumbing for thin route handlers: typed errors, JSON responses, validated bodies.

export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly hint?: string,
  ) {
    super(error);
    this.name = "DomainError";
  }
}

export function json<T>(data: T, init?: ResponseInit): Response {
  const res = Response.json(data, init);
  res.headers.set("cache-control", "no-store");
  return res;
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export function errorResponse(err: unknown): Response {
  unstable_rethrow(err);
  if (err instanceof DomainError) {
    return json<ApiError>({ error: err.error, ...(err.hint && { hint: err.hint }) }, { status: err.status });
  }
  logError("route", err);
  return json<ApiError>({ error: "internal_error" }, { status: 500 });
}

/** No route's body needs to come close to this. It exists to refuse the rest before they are ever parsed. */
export const MAX_BODY_BYTES = 64 * 1024;

export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  // A declared length over the cap is refused without reading the body at all. A missing or understated
  // length (chunked, or a lying client) still gets caught below, once the raw text is in hand.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new DomainError(413, "body_too_large", `body must be under ${MAX_BODY_BYTES} bytes`);
  }
  const text = await req.text().catch(() => {
    throw new DomainError(400, "invalid_json");
  });
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new DomainError(413, "body_too_large", `body must be under ${MAX_BODY_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DomainError(400, "invalid_json");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new DomainError(400, "invalid_body", parsed.error.issues[0]?.message);
  return parsed.data;
}

/**
 * The key an address is limited by. One IPv6 subscriber usually holds a whole /64, so an IPv6 address counts by its
 * first four groups; otherwise rotating through it would reset every per-address limit.
 */
export function addressKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  // Cloudflare sets cf-connecting-ip itself, so a client cannot spoof it the way it can add to x-forwarded-for.
  const ip = h.get("cf-connecting-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  return addressKey(ip);
}

/** Server logs carry ids, kinds and messages only, never user text or tokens. */
/** An error as one short line for the archive: its name and message, capped, never a stack. */
export function briefError(err: unknown): string {
  return (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 200);
}

export function logError(scope: string, err: unknown): void {
  console.error(`[${scope}]`, err instanceof Error ? `${err.name}: ${err.message}` : err);
}
