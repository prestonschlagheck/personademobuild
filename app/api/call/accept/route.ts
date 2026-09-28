import { callAcceptRequest } from "@/lib/api/contract";
import { acceptCall } from "@/lib/server/call-service";
import { errorResponse, json, parseBody } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session-service";

export async function POST(req: Request) {
  try {
    const id = await requireSession();
    return json(await acceptCall(id, await parseBody(req, callAcceptRequest)));
  } catch (err) {
    return errorResponse(err);
  }
}
