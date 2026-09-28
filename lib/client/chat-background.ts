"use client";

import { useSyncExternalStore } from "react";
import { createStoredValue } from "@/lib/client/browser-store";

// The conversation backgrounds from the contact card's Backgrounds tab. Each but None is a faint tint with
// Persona's mark, tone on tone, filling the lower right, like the stage around the phone. Per browser only.

export type ChatBackground = { id: string; name: string; color: string; mark: string | null };

const NONE: ChatBackground = { id: "none", name: "None", color: "var(--color-surface)", mark: null };

export const CHAT_BACKGROUNDS: ChatBackground[] = [
  NONE,
  { id: "persona", name: "Persona", color: "var(--color-page)", mark: "rgb(0 0 0 / 0.035)" },
  { id: "mist", name: "Mist", color: "#edf0f4", mark: "rgb(40 70 110 / 0.04)" },
  { id: "sand", name: "Sand", color: "#f4f0ea", mark: "rgb(110 80 40 / 0.04)" },
  { id: "sage", name: "Sage", color: "#eef1ec", mark: "rgb(50 90 50 / 0.04)" },
  { id: "blush", name: "Blush", color: "#f5eeef", mark: "rgb(120 50 60 / 0.04)" },
];

const byId = (id: string | null) => CHAT_BACKGROUNDS.find((b) => b.id === id) ?? NONE;

const stored = createStoredValue("chat-background", byId, (b) => b.id);

export function useChatBackground(): [ChatBackground, (id: string) => void] {
  const background = useSyncExternalStore(stored.subscribe, stored.read, () => NONE);
  return [background, (id) => stored.write(byId(id))];
}
