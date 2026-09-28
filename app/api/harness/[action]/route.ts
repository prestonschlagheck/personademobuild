import type { NextRequest } from "next/server";
import { harnessEnabled } from "@/lib/server/config";
import { runHarness } from "@/lib/server/harness";
import { errorResponse, json } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session-service";

// The live eval harness (tests/live). Outside `next dev` with HARNESS=1 the route does not exist.
export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  if (!harnessEnabled()) return new Response(null, { status: 404 });
  try {
    const id = await requireSession();
    const body: unknown = await req.json().catch(() => ({}));
    return json(await runHarness(id, (await params).action, body, req.nextUrl.origin));
  } catch (err) {
    return errorResponse(err);
  }
}
