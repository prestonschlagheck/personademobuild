import { callEndRequest } from "@/lib/api/contract";
import { endCall } from "@/lib/server/call-service";
import { errorResponse, json, parseBody } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session-service";

// Also the sendBeacon target on pagehide, which may arrive as text/plain; parseBody reads the body as text too.
export async function POST(req: Request) {
  try {
    const id = await requireSession();
    return json(await endCall(id, await parseBody(req, callEndRequest)));
  } catch (err) {
    return errorResponse(err);
  }
}
