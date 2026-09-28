import type { NextRequest } from "next/server";
import { doneUrl, signInTarget } from "@/lib/gmail/oauth";
import { logError } from "@/lib/server/http";
import { ownsOAuthState } from "@/lib/server/session-service";

// A state issued to another browser's session stops here, before a Google sign-in the callback could only refuse.
async function target(state: string | null, url: string): Promise<URL> {
  if (state && !(await ownsOAuthState(state))) return doneUrl("expired", url);
  return signInTarget(state, url);
}

// The link texted to the user. It carries only the single-use state; the redirect decides the rest.
export async function GET(req: NextRequest) {
  const next = await target(req.nextUrl.searchParams.get("state"), req.url).catch((err: unknown) => {
    logError("oauth start", err);
    return doneUrl("error", req.url);
  });
  return Response.redirect(next, 303);
}
