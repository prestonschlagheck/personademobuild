"use client";

import { useSyncExternalStore } from "react";
import { createStoredValue, type StoredValue } from "@/lib/client/browser-store";

// Two volumes, as on an iPhone: the ringer (the ringtone and the message cues) and the call (the agent's
// voice). Each has its own slider over the stage; the phone's volume buttons move both together.

/** iOS moves the volume in sixteen steps. */
const STEPS = 16;

export type Volume = StoredValue<number> & { initial: number };

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function createVolume(key: string, initial: number): Volume {
  const parse = (raw: string | null) => {
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? clamp(value) : initial;
  };
  const stored = createStoredValue(key, parse, (value) => value.toFixed(3));
  return { ...stored, write: (value) => stored.write(clamp(value)), initial };
}

// A quarter by default: a message cue at full volume on every reply wears thin. The call is the product, so it is full.
export const ringerVolume = createVolume("ringer-volume", 0.25);
export const callVolume = createVolume("call-volume", 1);

/**
 * Slider position to gain. Heard loudness grows about as amplitude to the 0.6 (Stevens), so the inverse power makes
 * each step of the slider sound like the same step louder.
 */
export const gainOf = (volume: number) => volume ** (5 / 3);

/** One step of the volume keys, snapped to the sixteen iOS steps. */
const stepVolume = (value: number, direction: 1 | -1) => clamp(Math.round(value * STEPS + direction) / STEPS);

const nudgeListeners = new Set<() => void>();

/** The volume buttons: both volumes one step, and the on-screen volume shows. */
export function nudgeVolumes(direction: 1 | -1) {
  for (const volume of [ringerVolume, callVolume]) volume.write(stepVolume(volume.read(), direction));
  for (const listener of nudgeListeners) listener();
}

export function onNudge(listener: () => void) {
  nudgeListeners.add(listener);
  return () => void nudgeListeners.delete(listener);
}

export function useVolume(volume: Volume) {
  return useSyncExternalStore(volume.subscribe, volume.read, () => volume.initial);
}
