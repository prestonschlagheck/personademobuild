// Records the call-volume sample with the agent itself: the same Realtime model, voice, speed and voice guidance a
// real call uses, read from lib/agent so the sample never drifts from the call. Writes
// public/audio/voice-preview.wav, which the Call slider replays at the volume it is set to.
// Run: node --env-file=.env.local scripts/voice-preview.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";

// The line the Call volume slider plays back from public/audio/voice-preview.wav.
const LINE = "hi, this is how i'll sound when we talk.";
const RATE = 24_000;
/** Any quiet stretch inside the line is cut to this, and the ends to less, in seconds. */
const MAX_GAP = 0.12;
const EDGE = 0.04;
/** Below this 16-bit peak a 10 ms frame counts as quiet. */
const QUIET = 500;

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const pick = (text, pattern, what) => {
  const match = text.match(pattern);
  if (!match) throw new Error(`could not find ${what}`);
  return match[1];
};

const session = await source("lib/agent/voice-session.ts");
const model = pick(session, /REALTIME_MODEL = "([^"]+)"/, "REALTIME_MODEL");
const voice = pick(session, /voice: "([^"]+)"/, "the voice");
const speed = Number(pick(session, /VOICE_SPEED = ([\d.]+)/, "VOICE_SPEED"));
const sound = pick(await source("lib/agent/prompt.ts"), /^(how you sound: .*)$/m, "the voice guidance");

const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
});
const send = (event) => socket.send(JSON.stringify(event));
const chunks = [];
let transcript = "";

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out after 30 s")), 30_000);
  socket.addEventListener("error", () => reject(new Error("socket error")));
  socket.addEventListener("open", () => {
    send({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions: `you are persona, a personal assistant, on a phone call. ${sound}`,
        audio: { output: { voice, speed, format: { type: "audio/pcm", rate: RATE } } },
      },
    });
    send({
      type: "response.create",
      response: {
        instructions: `say exactly this in one easy breath, with no pause after "hi", in your own natural voice, and nothing else: "${LINE}"`,
      },
    });
  });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "response.output_audio.delta") chunks.push(Buffer.from(event.delta, "base64"));
    else if (event.type === "response.output_audio_transcript.delta") transcript += event.delta;
    else if (event.type === "error") reject(new Error(event.error?.message ?? "realtime error"));
    else if (event.type === "response.done") {
      clearTimeout(timer);
      resolve();
    }
  });
});
socket.close();

const raw = Buffer.concat(chunks);
if (raw.length === 0) throw new Error("no audio came back");
const pcm = tighten(raw);
// A 16-bit mono PCM WAV header, then the tightened samples.
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);

await mkdir(new URL("../public/audio/", import.meta.url), { recursive: true });
await writeFile(new URL("../public/audio/voice-preview.wav", import.meta.url), Buffer.concat([header, pcm]));
console.log(`${model}, ${voice} at ${speed}x: "${transcript.trim()}" (${(raw.length / 2 / RATE).toFixed(2)} s, tightened to ${(pcm.length / 2 / RATE).toFixed(2)} s)`);

// Cuts every quiet stretch inside the line down to MAX_GAP and the lead-in and tail to EDGE. Cuts land in silence,
// so they need no crossfade.
function tighten(buffer) {
  const frame = RATE / 100;
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const frames = Math.ceil(samples.length / frame);
  const quiet = [];
  for (let f = 0; f < frames; f++) {
    let peak = 0;
    for (let i = f * frame; i < Math.min(samples.length, (f + 1) * frame); i++) peak = Math.max(peak, Math.abs(samples[i]));
    quiet.push(peak < QUIET);
  }
  const first = quiet.indexOf(false);
  const last = quiet.lastIndexOf(false);
  if (first === -1) return buffer;
  const keep = [];
  let run = 0;
  for (let f = first; f <= last; f++) {
    run = quiet[f] ? run + 1 : 0;
    if (run <= MAX_GAP * 100) keep.push(f);
  }
  const edge = Math.round(EDGE * 100);
  const range = (from, length) => Array.from({ length }, (_, i) => from + i).filter((f) => f >= 0 && f < frames);
  const kept = [...range(first - edge, edge), ...keep, ...range(last + 1, edge)];
  return Buffer.concat(kept.map((f) => buffer.subarray(f * frame * 2, Math.min(buffer.length, (f + 1) * frame * 2))));
}
