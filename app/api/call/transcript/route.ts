import type { NextRequest } from "next/server";
import { transcriptRequest } from "@/lib/api/contract";
import { recordTranscript } from "@/lib/server/call-service";
import { errorResponse, noContent, parseBody } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session-service";

export async function POST(req: NextRequest) {
  try {
    const id = await requireSession();
    await recordTranscript(id, await parseBody(req, transcriptRequest), req.nextUrl.origin);
    return noContent();
  } catch (err) {
    return errorResponse(err);
  }
}
