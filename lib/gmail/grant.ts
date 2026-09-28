import "server-only";
import { z } from "zod";
import { getModes, secret } from "@/lib/server/config";
import { logError } from "@/lib/server/http";
import { getStore } from "@/lib/server/store";

// The Google sign-in a session keeps so the agent can work in the user's Gmail and Calendar: sealed with AES-GCM
// under a key derived from the OAuth client secret (anyone holding that secret could use the refresh token anyway),
// stored apart from the session (Store.setGoogleGrant) so it never reaches the browser, a snapshot or the archive,
// refreshed when the access token runs out, and revoked with Google when they disconnect it, when a sign-in for another
// account replaces it, and when the session is deleted or expires.

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
/** Refreshed this long before Google's expiry, so a token never dies in the middle of a tool call. */
const EARLY_MS = 60_000;

const grantSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number(),
  email: z.string(),
  scopes: z.array(z.string()),
  /** Drafts the agent saved, so only one it read back and they answered can be sent (lib/gmail/tools.ts). */
  drafts: z.array(z.object({ id: z.string(), at: z.string() })).optional(),
});
export type Grant = z.infer<typeof grantSchema>;

let keyPromise: Promise<CryptoKey> | null = null;
function key(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    // Mock mode holds only fixture sign-ins, which unlock nothing, so it needs no Google secret.
    const bound = getModes().gmail === "live" ? secret("GOOGLE_CLIENT_SECRET") : "mock";
    const material = new TextEncoder().encode(`persona google grant v1:${bound}`);
    const digest = await crypto.subtle.digest("SHA-256", material);
    return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  })();
  return keyPromise;
}

export async function seal(grant: Grant): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(JSON.stringify(grant)));
  return `${Buffer.from(iv).toString("base64url")}.${Buffer.from(data).toString("base64url")}`;
}

export async function unseal(sealed: string): Promise<Grant | null> {
  try {
    const [iv, data] = sealed.split(".");
    if (!iv || !data) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64url") }, await key(), Buffer.from(data, "base64url"));
    const parsed = grantSchema.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveGrant(sessionId: string, grant: Grant): Promise<void> {
  await getStore().setGoogleGrant(sessionId, await seal(grant));
}

export async function loadGrant(sessionId: string): Promise<Grant | null> {
  const sealed = await getStore().googleGrant(sessionId);
  return sealed ? unseal(sealed) : null;
}

const refreshSchema = z.object({ access_token: z.string(), expires_in: z.number().optional(), scope: z.string().optional() });

/** A live access token for the session's Google account, refreshed if it ran out, or null when there is none. */
export async function accessToken(sessionId: string): Promise<{ token: string; grant: Grant } | null> {
  const grant = await loadGrant(sessionId);
  if (!grant) return null;
  if (grant.expiresAt - EARLY_MS > Date.now() || grant.accessToken.startsWith("mock:")) return { token: grant.accessToken, grant };
  if (!grant.refreshToken) return null;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
      client_id: secret("GOOGLE_CLIENT_ID"),
      client_secret: secret("GOOGLE_CLIENT_SECRET"),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!res?.ok) {
    logError("google refresh", new Error(res ? `status ${res.status}` : "network"));
    return null;
  }
  const body = refreshSchema.parse(await res.json());
  const next: Grant = { ...grant, accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000 };
  await saveGrant(sessionId, next);
  return { token: next.accessToken, grant: next };
}

const revokeErrorSchema = z.object({ error: z.string() });

/**
 * Hands one token back to Google, and says whether Google confirmed it: a token it already calls invalid counts, since
 * that access is gone too. A failed revoke is logged (the status only, never the token) rather than retried.
 */
export async function revokeToken(token: string): Promise<boolean> {
  const res = await fetch(REVOKE_URL, { method: "POST", body: new URLSearchParams({ token }), cache: "no-store", signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (res?.ok) return true;
  const body = res?.status === 400 ? await res.json().catch(() => null) : null;
  if (revokeErrorSchema.safeParse(body).data?.error === "invalid_token") return true;
  logError("google revoke", new Error(res ? `status ${res.status}` : "network"));
  return false;
}

/**
 * Hands Google access back and forgets it, whatever Google answers, so nothing here can use it again. Revoking the
 * refresh token ends every access token issued from it. True once Google confirmed, or when there was nothing at
 * Google to revoke; false when Google could not be reached or refused.
 */
export async function revokeGrant(sessionId: string): Promise<boolean> {
  const grant = await loadGrant(sessionId).catch(() => null);
  await getStore().setGoogleGrant(sessionId, null);
  const token = grant?.refreshToken ?? grant?.accessToken;
  if (!token || token.startsWith("mock:")) return true;
  return revokeToken(token);
}
