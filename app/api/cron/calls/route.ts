import { cronAuthorized } from "@/lib/server/config";
import { errorResponse, json } from "@/lib/server/http";
import { settleForAlarm } from "@/lib/server/session-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Settles one session's due timers and says when the next one falls due, or null when none is pending. Its Durable
// Object's alarm calls this and wakes again at that time, so a hangup gets its text with no tab open and an idle
// session never wakes at all. Without CRON_SECRET set and presented, the route does not exist.
export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"))) return new Response(null, { status: 404 });
  const id = new URL(req.url).searchParams.get("session");
  if (!id || !UUID.test(id)) return new Response(null, { status: 400 });
  try {
    const { session, wake } = await settleForAlarm(id);
    return json({ status: session.call.status, wake });
  } catch (err) {
    return errorResponse(err);
  }
}
