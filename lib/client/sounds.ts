"use client";

import { gainOf, ringerVolume } from "@/lib/client/volume";
import { audioContext } from "@/lib/voice/audio-level";

// Every sound is synthesized with Web Audio, so there are no files to load and nothing borrowed.
// Browsers keep audio locked until a user gesture; `unlock()` runs on the first one, and again as a call is answered
// or placed, so the context runs before the call's audio does. Every cue and the ring play at the ringer volume, and a
// change while the ring plays applies at once.

type Cue = "send" | "receive" | "connect" | "end";

const MASTER_GAIN = 0.55;

// An original ringtone in the iPhone manner: a soft marimba arpeggio in E major, played as a phrase and its
// answer, then a breath before it repeats. [seconds from the start of the cycle, MIDI note, velocity].
const PULSE = 0.135;
const RING_STEPS: [number, number, number][] = [
  [0, 76, 1], [1, 80, 0.7], [2, 83, 0.8], [3, 88, 1], [5, 87, 0.8], [6, 83, 0.7], [8, 85, 0.9], [9, 80, 0.7],
  [12, 76, 1], [13, 80, 0.7], [14, 83, 0.8], [15, 88, 1], [17, 90, 0.9], [18, 88, 0.8], [20, 83, 1],
];
const RING_FIGURE = RING_STEPS.map(([step, note, velocity]) => [step * PULSE, note, velocity] as const);
const RING_PERIOD_MS = 3_900;
// Like a phone on a table, the first ring starts quieter and swells to full over a few cycles.
const RING_START_GAIN = 0.4;
const RING_SWELL_S = 8;

let audio: { ctx: AudioContext; out: GainNode } | null = null;
let noise: AudioBuffer | null = null;
type Ring = { bus: GainNode; timer?: ReturnType<typeof setTimeout> };

let ring: Ring | null = null;

const ringerGain = () => MASTER_GAIN * gainOf(ringerVolume.read());

function output() {
  // Resumed on every use, since a phone can suspend it between calls.
  const ctx = audioContext();
  if (!audio) {
    const out = ctx.createGain();
    out.gain.value = ringerGain();
    out.connect(ctx.destination);
    audio = { ctx, out };
    ringerVolume.subscribe(() => out.gain.setTargetAtTime(ringerGain(), ctx.currentTime, 0.02));
  }
  return audio;
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function tone(ctx: AudioContext, dest: AudioNode, freq: number, at: number, length: number, gain: number) {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(gain, at + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(env).connect(dest);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

// A struck bar: the fundamental plus the bright, quickly damped fourth partial of a tuned marimba key.
function mallet(ctx: AudioContext, dest: AudioNode, freq: number, at: number, gain: number) {
  tone(ctx, dest, freq, at, 0.85, gain);
  tone(ctx, dest, freq * 4, at, 0.12, gain * 0.25);
}

// A tuned marimba bar: a warm fundamental, the bright fourth partial that fades fast, the tenth partial as
// the mallet's click, and a lower note that rings a little longer than a higher one.
function marimba(ctx: AudioContext, dest: AudioNode, freq: number, at: number, gain: number) {
  const ring = Math.min(1.1, 0.45 + 220 / freq);
  tone(ctx, dest, freq, at, ring, gain);
  tone(ctx, dest, freq * 4, at, 0.09, gain * 0.18);
  tone(ctx, dest, freq * 9.9, at, 0.025, gain * 0.06);
}

// A soft room around the ring: one damped echo that feeds back a little, so the bars don't sound dry.
function room(ctx: AudioContext, dest: AudioNode): AudioNode {
  const input = ctx.createGain();
  const delay = ctx.createDelay(0.5);
  const damp = ctx.createBiquadFilter();
  const feedback = ctx.createGain();
  const wet = ctx.createGain();
  delay.delayTime.value = 0.11;
  damp.type = "lowpass";
  damp.frequency.value = 2_400;
  feedback.gain.value = 0.28;
  wet.gain.value = 0.22;
  input.connect(dest);
  input.connect(delay).connect(damp).connect(feedback).connect(delay);
  damp.connect(wet).connect(dest);
  return input;
}

function swoosh(ctx: AudioContext, dest: AudioNode) {
  const length = 0.26;
  if (!noise) {
    noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.5), ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const at = ctx.currentTime;
  const src = ctx.createBufferSource();
  const band = ctx.createBiquadFilter();
  const env = ctx.createGain();
  src.buffer = noise;
  band.type = "bandpass";
  band.Q.value = 1.2;
  band.frequency.setValueAtTime(600, at);
  band.frequency.exponentialRampToValueAtTime(4200, at + length);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(0.32, at + 0.05);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  src.connect(band).connect(env).connect(dest);
  src.start(at);
  src.stop(at + length);
}

function play(cue: Cue) {
  if (typeof window === "undefined" || ringerVolume.read() === 0) return;
  const { ctx, out } = output();
  if (ctx.state !== "running") return;
  const at = ctx.currentTime + 0.01;
  switch (cue) {
    case "send":
      swoosh(ctx, out);
      break;
    case "receive":
      mallet(ctx, out, hz(84), at, 0.11);
      mallet(ctx, out, hz(91), at + 0.07, 0.09);
      break;
    case "connect":
      tone(ctx, out, hz(74), at, 0.16, 0.1);
      tone(ctx, out, hz(81), at + 0.09, 0.22, 0.1);
      break;
    case "end":
      tone(ctx, out, hz(79), at, 0.16, 0.1);
      tone(ctx, out, hz(72), at + 0.12, 0.26, 0.1);
      break;
  }
}

function startRing() {
  // It starts even when silent, so turning the ringer up mid-ring is heard.
  if (ring || typeof window === "undefined") return;
  const { ctx, out } = output();
  const bus = ctx.createGain();
  const soften = ctx.createBiquadFilter();
  soften.type = "lowpass";
  soften.frequency.value = 5_500;
  bus.gain.setValueAtTime(RING_START_GAIN, ctx.currentTime);
  bus.gain.linearRampToValueAtTime(1, ctx.currentTime + RING_SWELL_S);
  bus.connect(soften).connect(out);
  const voice = room(ctx, bus);
  const current: Ring = { bus };
  ring = current;
  const cycle = () => {
    // A suspended context would bank every cycle and play them all at once on unlock.
    if (ctx.state === "running") {
      const at = ctx.currentTime + 0.05;
      for (const [offset, note, velocity] of RING_FIGURE) marimba(ctx, voice, hz(note), at + offset, 0.17 * velocity);
    }
    current.timer = setTimeout(cycle, RING_PERIOD_MS);
  };
  cycle();
}

function stopRing() {
  if (!ring || !audio) return;
  const { bus, timer } = ring;
  ring = null;
  clearTimeout(timer);
  // Hold the swell where it is first, or its scheduled ramp would take over again after the fade.
  const now = audio.ctx.currentTime;
  bus.gain.cancelScheduledValues(now);
  bus.gain.setValueAtTime(bus.gain.value, now);
  bus.gain.setTargetAtTime(0, now, 0.04);
  setTimeout(() => bus.disconnect(), 300);
}

// iOS also needs a buffer started inside the gesture before it will play anything later.
function unlock() {
  const { ctx, out } = output();
  const src = ctx.createBufferSource();
  src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  src.connect(out);
  src.start();
}

export const sounds = { play, startRing, stopRing, unlock };
