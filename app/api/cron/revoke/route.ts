import { revokeGrant } from "@/lib/gmail/grant";
import { cronAuthorized } from "@/lib/server/config";
import { errorResponse, json } from "@/lib/server/http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hands one session's Google sign-in back to Google and deletes it, and says whether Google confirmed. Its Durable
// Object calls this when the session's retention runs out, just before it deletes itself, since only the app holds the
// key the sign-in is sealed with. Without CRON_SECRET set and presented, the route does not exist.
export async function POST(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"))) return new Response(null, { status: 404 });
  const id = new URL(req.url).searchParams.get("session");
  if (!id || !UUID.test(id)) return new Response(null, { status: 400 });
  try {
    return json({ revoked: await revokeGrant(id) });
  } catch (err) {
    return errorResponse(err);
  }
}
