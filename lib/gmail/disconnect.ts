import "server-only";
import { runTool, type ToolOutput } from "@/lib/agent/tools";
import { revokeGrant } from "@/lib/gmail/grant";
import { mutate } from "@/lib/server/session-service";
import { getStore } from "@/lib/server/store";
import type { NewEvent, Session } from "@/lib/session/schema";

// Disconnecting Google when they ask, on either runtime. The session is saved as disconnected first, so no Google tool
// can use the sign-in again, then the sign-in goes back to Google and is deleted. Its tool row records whether Google
// confirmed, and the agent says only that: disconnected, or that Google did not answer and where to remove it there.

/** The refusal a disconnect gets when the session forgot the sign-in but Google did not confirm the revoke. */
export const REVOKE_FAILED = "revoke_failed";

/** What the model hears once Google answered. The row the runtime writes for the tool takes its ok and error. */
export function revokeResult(revoked: boolean): ToolOutput {
  return revoked
    ? { ok: true, result: "disconnected: google access is handed back and the sign-in is deleted.", hint: "confirm it in a few words.", state: "" }
    : {
        ok: false,
        error: REVOKE_FAILED,
        hint:
          "gmail is disconnected here and the sign-in is deleted, but google didn't confirm the revoke. say so honestly, " +
          "never that google access is gone, and that they can remove persona themselves under third-party connections in their google account.",
        state: "",
      };
}

/**
 * The disconnect_google tool as the live runtimes run it: through the reducer, saved with no row of its own (the
 * runtime writes one with the result, as for any Google tool), then revoked at Google.
 */
export async function disconnectGoogle(sessionId: string): Promise<ToolOutput> {
  const googleGrant = (await getStore().googleGrant(sessionId)) !== null;
  let refused = null as ToolOutput | null;
  await mutate(sessionId, (s, now) => {
    const run = runTool(s, { runtime: "text", now, origin: "", googleGrant }, "disconnect_google", {});
    refused = run.output.ok ? null : run.output;
    return { session: run.session };
  });
  if (refused) return refused;
  return revokeResult(await revokeGrant(sessionId));
}

const DISCONNECTED_LINE = {
  en: "done, your google's disconnected. i can't see your inbox or calendar anymore.",
  es: "listo, tu google está desconectado. ya no puedo ver tu correo ni tu calendario.",
};
const UNCONFIRMED_LINE = {
  en: "i've deleted your google sign-in on my end, but google didn't answer when i handed it back. to be sure, remove persona under third-party connections in your google account.",
  es: "borré tu acceso de google por mi lado, pero google no respondió al devolverlo. para asegurarte, quita persona en las conexiones de terceros de tu cuenta de google.",
};

/**
 * A disconnect the mock brain made, which knows no more than the reducer did: its tool row, held back from the save,
 * goes in with the revoke's result, and the line after it says that result.
 */
export function disconnectRows(held: NewEvent[], revoked: boolean, lang: Session["lang"]): NewEvent[] {
  const { ok, error } = revokeResult(revoked);
  const rows = held.map((e) => (e.meta?.tool ? { ...e, meta: { ...e.meta, tool: { ...e.meta.tool, ok, ...(error && { error }) } } } : e));
  const text = (revoked ? DISCONNECTED_LINE : UNCONFIRMED_LINE)[lang ?? "en"];
  return [...rows, { channel: "text", role: "agent", content: text, meta: { kind: "chat" } }];
}

/** The reducer's row for a disconnect, which waits on Google's answer before it is written. */
export const isDisconnectRow = (e: NewEvent) => e.role === "tool" && e.meta?.tool?.name === "disconnect_google";
