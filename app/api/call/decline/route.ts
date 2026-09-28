import { callDeclineRequest } from "@/lib/api/contract";
import { declineCall } from "@/lib/server/call-service";
import { errorResponse, json, parseBody } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session-service";

export async function POST(req: Request) {
  try {
    const id = await requireSession();
    return json(await declineCall(id, await parseBody(req, callDeclineRequest)));
  } catch (err) {
    return errorResponse(err);
  }
}
