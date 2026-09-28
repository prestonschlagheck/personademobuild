import { reactRequest } from "@/lib/api/contract";
import { errorResponse, json, parseBody } from "@/lib/server/http";
import { react, requireSession } from "@/lib/server/session-service";

export async function POST(req: Request) {
  try {
    const id = await requireSession();
    const { targetId, type } = await parseBody(req, reactRequest);
    return json(await react(id, targetId, type));
  } catch (err) {
    return errorResponse(err);
  }
}
