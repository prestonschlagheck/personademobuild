import type { Session } from "@/lib/session/schema";

/** Persona's real lines, from its contact card: texts come from the mobile number, calls from a calls-only one. */
export const PERSONA_NUMBERS = { text: "+1 (650) 444-8426", call: "+1 (234) 454-7297" } as const;

/** How iOS names the thread and the caller: the saved contact's name, or the bare number before that. */
export function contactIdentity(
  session: Session | null | undefined,
  line: keyof typeof PERSONA_NUMBERS = "text",
): { saved: boolean; name: string } {
  const agent = session?.agentName?.value;
  return session?.contact.savedAt && agent ? { saved: true, name: agent } : { saved: false, name: PERSONA_NUMBERS[line] };
}
