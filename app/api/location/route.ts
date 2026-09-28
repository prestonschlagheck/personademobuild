import { locationRequest } from "@/lib/api/contract";
import { errorResponse, json, parseBody } from "@/lib/server/http";
import { requireSession, shareLocation } from "@/lib/server/session-service";

export async function POST(req: Request) {
  try {
    const id = await requireSession();
    return json(await shareLocation(id, await parseBody(req, locationRequest)));
  } catch (err) {
    return errorResponse(err);
  }
}
