import { z } from "zod";
import { systemEvent } from "@/lib/agent/messages";
import { errorResponse, noContent, parseBody } from "@/lib/server/http";
import { appendEvents, requireSession } from "@/lib/server/session-service";

// A browser error (a crash, a rejected promise) on this session's page, kept in the archive next to the conversation
// it broke, as its name and message only. The thread never draws it and no model reads it.
const body = z.object({ error: z.string().min(1).max(200), where: z.string().max(40).optional() }).strict();

export async function POST(req: Request) {
  try {
    const id = await requireSession();
    const { error, where } = await parseBody(req, body);
    await appendEvents(id, [systemEvent("client_error", "", { error: where ? `${where}: ${error}`.slice(0, 200) : error })]);
    return noContent();
  } catch (err) {
    return errorResponse(err);
  }
}
