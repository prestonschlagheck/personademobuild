import type { NextRequest } from "next/server";
import { doneUrl, handleGoogleCallback, type OAuthResult } from "@/lib/gmail/oauth";
import { logError } from "@/lib/server/http";
import { ownsOAuthState } from "@/lib/server/session-service";

// A state this browser's session was not issued is refused before the callback consumes it, so a link
// opened in another browser never burns the owner's.
async function finish(params: URLSearchParams, url: string): Promise<OAuthResult> {
  const state = params.get("state");
  if (state && !(await ownsOAuthState(state))) return "expired";
  return handleGoogleCallback(params, url);
}

// Google (or the mock consent page) lands here. Whatever happens, the user ends on /connect/done,
// which reports back to the thread's tab and closes itself.
export async function GET(req: NextRequest) {
  const result = await finish(req.nextUrl.searchParams, req.url).catch((err: unknown) => {
    logError("oauth callback", err);
    return "error" as const;
  });
  return Response.redirect(doneUrl(result, req.url), 303);
}
