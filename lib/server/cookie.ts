import "server-only";
import { cookies } from "next/headers";

// The session id lives only in this httpOnly cookie, so no route ever trusts an id from a body.

const NAME = "pid";
const MAX_AGE_S = 60 * 60 * 24 * 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readSessionId(): Promise<string | null> {
  const value = (await cookies()).get(NAME)?.value;
  return value && UUID.test(value) ? value : null;
}

export async function writeSessionId(id: string): Promise<void> {
  (await cookies()).set(NAME, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}
