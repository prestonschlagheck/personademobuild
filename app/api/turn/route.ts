import type { NextRequest } from "next/server";
import { turnRequest } from "@/lib/api/contract";
import { errorResponse, json, parseBody } from "@/lib/server/http";
import { requireSession, takeTurn } from "@/lib/server/session-service";

export async function POST(req: NextRequest) {
  try {
    const id = await requireSession();
    const { messages, timeZone } = await parseBody(req, turnRequest);
    return json(await takeTurn(id, messages, req.nextUrl.origin, timeZone));
  } catch (err) {
    return errorResponse(err);
  }
}
