import type { NextRequest } from "next/server";
import { devLog } from "@/lib/server/dev-log";
import { requireSession } from "@/lib/server/session-service";

// The browser's half of the local session log (lib/client/dev-trace.ts). Outside `next dev` the route does not exist.
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "development") return new Response(null, { status: 404 });
  const id = await requireSession().catch(() => null);
  const text = await req.text();
  if (!id || text.length > 20_000) return new Response(null, { status: 204 });
  const entry = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  })();
  if (typeof entry === "object" && entry !== null) devLog(id, { client: entry });
  return new Response(null, { status: 204 });
}
