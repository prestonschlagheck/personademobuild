import { callStartRequest } from "@/lib/api/contract";
import { startCall } from "@/lib/server/call-service";
import { errorResponse, json, parseBody } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session-service";

export async function POST(req: Request) {
  try {
    const id = await requireSession();
    const { initiator } = await parseBody(req, callStartRequest);
    return json(await startCall(id, initiator));
  } catch (err) {
    return errorResponse(err);
  }
}
