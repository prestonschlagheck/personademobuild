import "server-only";
import { z } from "zod";
import { systemEvent } from "@/lib/agent/messages";
import { heartbeatRequest } from "@/lib/api/contract";
import { appendEvents } from "@/lib/server/session-service";

// A live call's own record of how its replies went (lib/client/dev-trace.ts voiceDiag), which the browser sends with
// its heartbeat. Realtime runs between the browser and OpenAI, so without it the archive cannot say why a call went
// quiet: a reply that failed, an error, the watchdog asking again.

/** The most entries one row keeps, as the browser caps a batch (DIAG_CAP). */
const DIAG_CAP = 50;
// "12.3:done:failed:rate_limit_exceeded": seconds into the call, then a code. Nothing else gets through, so no words can.
const ENTRY = /^\d{1,5}\.\d:[a-z0-9_.:]{1,64}$/;

/** The heartbeat with the record riding along. Its shape is checked apart, so a bad record never costs a heartbeat. */
export const heartbeatWithDiag = heartbeatRequest.extend({ diag: z.unknown().optional() });

/** The entries of a batch that are codes and nothing else, at most DIAG_CAP of them. */
export function diagEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && ENTRY.test(entry)).slice(0, DIAG_CAP);
}

/**
 * One system row per batch, kind voice_diag, with the call's attempt and its codes in meta and no content. The thread
 * never draws it. Called once the heartbeat has found the call live, so a batch lands inside the call it describes.
 */
export async function recordVoiceDiag(id: string, attempt: number, raw: unknown): Promise<void> {
  const diag = diagEntries(raw);
  if (diag.length === 0) return;
  await appendEvents(id, [systemEvent("voice_diag", "", { callAttempt: attempt, diag })]);
}
