"use client";

import { contactIdentity } from "@/lib/client/contact";
import { useOnboarding } from "@/lib/client/onboarding";

/** How iOS labels the caller: the saved contact's name, or the bare number with a "maybe" guess. */
export function useCaller() {
  const { snapshot } = useOnboarding();
  const session = snapshot?.session;
  const { saved, name } = contactIdentity(session, "call");
  return { name, saved, maybe: saved ? null : (session?.agentName?.value ?? null) };
}
