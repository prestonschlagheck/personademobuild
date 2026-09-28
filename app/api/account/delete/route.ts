import type { NextRequest } from "next/server";
import { deleteAccountRequest } from "@/lib/api/contract";
import { errorResponse, noContent, parseBody } from "@/lib/server/http";
import { deleteAccount, requireSession } from "@/lib/server/session-service";

// The dashboard's Delete account. The thread picks up the fresh session on its next poll.
export async function POST(req: NextRequest) {
  try {
    const id = await requireSession();
    await parseBody(req, deleteAccountRequest);
    await deleteAccount(id, req.nextUrl.origin);
    return noContent();
  } catch (err) {
    return errorResponse(err);
  }
}
