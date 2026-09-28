import type { NextRequest } from "next/server";
import { toolRequest } from "@/lib/api/contract";
import { relayVoiceTool } from "@/lib/server/call-service";
import { errorResponse, json, parseBody } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session-service";

// Voice tool relay. The browser forwards the model's function calls; the server checks the call,
// allowlists the tool and validates it, so a tampered client can only do what the user could by text.
export async function POST(req: NextRequest) {
  try {
    const id = await requireSession();
    return json(await relayVoiceTool(id, await parseBody(req, toolRequest), req.nextUrl.origin));
  } catch (err) {
    return errorResponse(err);
  }
}
