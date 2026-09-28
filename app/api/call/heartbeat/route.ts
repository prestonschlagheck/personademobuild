import { heartbeat } from "@/lib/server/call-service";
import { errorResponse, logError, noContent, parseBody } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session-service";
import { heartbeatWithDiag, recordVoiceDiag } from "@/lib/server/voice-diag";

export async function POST(req: Request) {
  try {
    const id = await requireSession();
    const { attempt, diag } = await parseBody(req, heartbeatWithDiag);
    await heartbeat(id, attempt);
    // The call's record of how its replies went, kept only for a call still live. Failing to keep it never fails the ping.
    if (diag !== undefined) await recordVoiceDiag(id, attempt, diag).catch((err: unknown) => logError("voice diag", err));
    return noContent();
  } catch (err) {
    return errorResponse(err);
  }
}
