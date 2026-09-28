"use client";

import { callVolume, gainOf } from "@/lib/client/volume";

// A short line in the agent's own voice, so setting the call volume sounds like the call. The clip is the
// Realtime voice, recorded once (scripts/voice-preview.mjs). The browser's own voice never stands in for it: without
// the clip, the preview is silent.

const CLIP = "/audio/voice-preview.wav";

let clip: HTMLAudioElement | null = null;

const level = () => gainOf(callVolume.read());

/** Plays the line at the call volume. A change while it plays applies at once; a second press lets it finish. */
export function previewVoice() {
  if (typeof window === "undefined" || callVolume.read() === 0) return;
  if (!clip) {
    clip = new Audio(CLIP);
    clip.preload = "auto";
    callVolume.subscribe(() => {
      if (clip) clip.volume = level();
    });
  }
  if (!clip.paused) return;
  clip.volume = level();
  clip.currentTime = 0;
  clip.play().catch(() => {});
}
