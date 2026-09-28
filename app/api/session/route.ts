import type { NextRequest } from "next/server";
import { errorResponse, json, noContent } from "@/lib/server/http";
import { ensureSession, pollSnapshot, readSnapshot, resetSession } from "@/lib/server/session-service";

// GET creates the session on first visit. `?resume=1` marks a page load; `?v=&e=` is the poll,
// answered with 204 while nothing changed.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    // The existence check already read the session, so the poll or snapshot below reuses it instead of reading again.
    const { id, created, reading } = await ensureSession();
    const version = Number(searchParams.get("v"));
    const seq = Number(searchParams.get("e"));
    if (!created && searchParams.has("v") && Number.isInteger(version) && Number.isInteger(seq)) {
      const snapshot = await pollSnapshot(id, version, seq, reading);
      return snapshot ? json(snapshot) : noContent();
    }
    return json(await readSnapshot(id, { resume: searchParams.get("resume") === "1", reading }));
  } catch (err) {
    return errorResponse(err);
  }
}

// DELETE starts over and answers with the fresh session, so the page never waits on a second request.
export async function DELETE() {
  try {
    return json(await resetSession());
  } catch (err) {
    return errorResponse(err);
  }
}
