// Loudness, 0 to 1, for the island waveform. Reads are cheap and meant for rAF.

export type LevelSource = { read(): number; close(): void };
/** A metered stream also reports its raw loudness, unsmoothed, so a pause shows the moment it starts. */
export type StreamMeter = LevelSource & { db(): number };

const FLOOR_DB = -60;
const CEIL_DB = -12;

let context: AudioContext | null = null;

/**
 * The page's one AudioContext, for the meters and every sound cue alike. Made and resumed on the first gesture
 * (sounds.unlock), long before a call's audio plays: a context made or resumed later can reconfigure the output
 * device and glitch the agent's voice already playing.
 */
export function audioContext() {
  if (context?.state === "closed") context = null;
  context ??= new AudioContext();
  wake(context);
  return context;
}

// Safari reports "interrupted" rather than "suspended" when a call takes the audio session; either needs a resume,
// and a meter on a context that isn't running reads silence. Asked at most once a second, since meters read per frame.
let wokenAt = 0;
function wake(ctx: AudioContext) {
  if (ctx.state === "running" || performance.now() - wokenAt < 1_000) return;
  wokenAt = performance.now();
  void ctx.resume().catch(() => undefined);
}

// Fast attack, slow release, frame-rate independent, so the waveform swells with a syllable and settles gently.
function follower(attack: number, release: number) {
  let value = 0;
  let last = 0;
  return (target: number) => {
    const now = performance.now();
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    const rate = target > value ? attack : release;
    value += (target - value) * (1 - Math.exp(-dt * rate));
    return value;
  };
}

/** Meters a live stream (the mic, or the agent's remote track) through an AnalyserNode. */
export function meterStream(stream: MediaStream): StreamMeter {
  const ctx = audioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  const smooth = follower(24, 6);

  const db = () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    return 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8);
  };

  return {
    db,
    read() {
      wake(ctx);
      return smooth(Math.min(1, Math.max(0, (db() - FLOOR_DB) / (CEIL_DB - FLOOR_DB))));
    },
    close() {
      source.disconnect();
      analyser.disconnect();
    },
  };
}

/**
 * A synthetic voice envelope for speechSynthesis, which exposes no audio. Two slow beating sines give
 * a syllable rhythm, and word boundaries (when the voice reports them) add a small accent.
 */
export function speechEnvelope() {
  let speaking = false;
  let stress = 0;
  let last = 0;
  const smooth = follower(20, 7);

  return {
    setSpeaking(on: boolean) {
      speaking = on;
    },
    accent() {
      stress = 1;
    },
    read() {
      const now = performance.now();
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      stress *= Math.exp(-dt * 9);
      const t = now / 1000;
      const rhythm = 0.5 + 0.5 * Math.sin(t * 26.4) * Math.sin(t * 8.2 + 0.7);
      return smooth(speaking ? 0.26 + 0.36 * rhythm + 0.28 * stress : 0);
    },
  };
}
