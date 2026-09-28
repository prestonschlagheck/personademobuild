import { mockVoiceTurn, type VoiceInput } from "@/lib/agent/mock/brain";
import { recognitionCtor, type Recognition, type RecognitionEvent } from "@/lib/client/speech";
import type { Session } from "@/lib/session/schema";
import { speechEnvelope } from "@/lib/voice/audio-level";
import { SILENCE_MS, silenceStep } from "@/lib/voice/notes";
import type { CallNote, ServerEvent, TransportHandlers, VoiceTransport } from "@/lib/voice/transport";

// A local stand-in for OpenAI Realtime. The deterministic brain decides each turn, speechSynthesis
// speaks it, SpeechRecognition listens, and every step is reported with the Realtime event names.

type ToolCall = { name: string; args: unknown };

const TOOL_TIMEOUT_MS = 8_000;
const START_TIMEOUT_MS = 2_500;
const ECHO_WINDOW_MS = 2_500;
const MS_PER_WORD = 340;
const RATE = 1.05;

const PREFERRED_VOICES = [/siri/i, /^samantha/i, /^ava\b/i, /^zoe\b/i, /google us english/i, /aria|jenny/i];
const SPANISH = /[¿¡ñ]|\b(hola|gracias|puedo|quieres|ayudarte|correo|llamada)\b/i;

const speechAvailable = () => typeof window !== "undefined" && "speechSynthesis" in window;

/** iOS only lets a page speak after a first utterance inside a user gesture. Call from a click. */
export function primeSpeech() {
  if (!speechAvailable()) return;
  speechSynthesis.getVoices();
  const silent = new SpeechSynthesisUtterance(" ");
  silent.volume = 0;
  speechSynthesis.speak(silent);
}

export function pickVoice(spanish: boolean) {
  const voices = speechSynthesis.getVoices();
  if (spanish) return voices.find((v) => v.lang.startsWith("es"));
  const us = voices.filter((v) => v.lang.replace("_", "-") === "en-US");
  for (const pattern of PREFERRED_VOICES) {
    const match = us.find((v) => pattern.test(v.name));
    if (match) return match;
  }
  return us.find((v) => v.localService) ?? us[0];
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** Speakers leak the agent's voice into the mic. Treat what we hear as echo when most of it was just said. */
export function isEcho(heard: string, spoken: string) {
  const said = new Set(words(spoken));
  const got = words(heard);
  if (got.length === 0) return true;
  return got.filter((w) => said.has(w)).length / got.length >= 0.6;
}

// Reveal captions a word at a time, never cutting one in half.
function wordEnd(text: string, index: number) {
  if (index >= text.length) return text.length;
  const next = text.indexOf(" ", index);
  return next === -1 ? text.length : next;
}

export function createMockTransport(handlers: TransportHandlers, latestSession: () => Session): VoiceTransport {
  const envelope = speechEnvelope();
  const outputs = new Map<string, () => void>();
  let closed = false;
  let muted = false;
  let volume = 1;
  let counter = 0;
  let queue = Promise.resolve();
  let speaking: { text: string; interrupt: () => void } | null = null;
  let lastSpoken = { text: "", at: 0 };
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let silences = 0;
  let recognition: Recognition | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let hearing: { itemId: string; shown: string } | null = null;

  // Item and tool call ids are idempotency keys on the server, so they must never repeat across calls.
  const tag = crypto.randomUUID().slice(0, 8);
  const id = (prefix: string) => `mock_${tag}_${prefix}${++counter}`;
  const emit = (event: ServerEvent) => {
    if (!closed) handlers.onEvent(event);
  };

  function enqueue(input: VoiceInput) {
    // One failed turn must not stall every turn queued behind it.
    queue = queue.then(() => turn(input)).catch((err: unknown) => console.error("mock voice turn", err));
  }

  // News from the thread waits for them to finish a sentence rather than talking over it.
  const untilHeard = () =>
    new Promise<void>((resolve) => {
      const check = () => (hearing && !closed ? setTimeout(check, 250) : resolve());
      check();
    });

  async function turn(input: VoiceInput) {
    if (input.type === "system") await untilHeard();
    if (closed) return;
    clearTimeout(silenceTimer);
    emit({ type: "response.created" });
    const { say, tools, end } = mockVoiceTurn(latestSession(), input);
    const hangup: ToolCall | undefined =
      tools.find((t) => t.name === "end_call") ?? (end ? { name: "end_call", args: { reason: input.type === "silence" ? "silence" : "done" } } : undefined);
    // One at a time and in order, the way the model emits them, each waiting for its output. The goodbye is said
    // before end_call, since a hangup with nothing said in its response is refused.
    for (const call of tools) if (!closed && call !== hangup) await runTool(call);
    if (say && !closed) await speak(say);
    if (hangup && !closed) await runTool(hangup);
    emit({ type: "response.done" });
    if (!end) armSilence();
  }

  function runTool(call: ToolCall) {
    const callId = id("call");
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        outputs.delete(callId);
        resolve();
      };
      const timer = setTimeout(done, TOOL_TIMEOUT_MS);
      outputs.set(callId, done);
      emit({ type: "response.function_call_arguments.done", call_id: callId, name: call.name, arguments: JSON.stringify(call.args ?? {}) });
    });
  }

  function armSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (closed || speaking || hearing) return;
      silences += 1;
      emit({ type: "input_audio_buffer.timeout_triggered" });
      // Most silences pass without a word, as they do on a live call.
      if (silenceStep(latestSession(), silences) === "wait") return armSilence();
      enqueue({ type: "silence", count: silences });
    }, SILENCE_MS);
  }

  function speak(text: string) {
    return new Promise<void>((resolve) => {
      const itemId = id("item");
      const estimate = Math.max(900, words(text).length * MS_PER_WORD);
      let shown = 0;
      let startedAt = 0;
      let simulated = false;
      let finished = false;
      const timers: { ticker?: ReturnType<typeof setInterval>; watchdog?: ReturnType<typeof setTimeout> } = {};

      const reveal = (upTo: number) => {
        const end = wordEnd(text, upTo);
        if (end <= shown) return;
        emit({ type: "response.output_audio_transcript.delta", item_id: itemId, delta: text.slice(shown, end) });
        shown = end;
      };

      const finish = (interrupted: boolean) => {
        if (finished) return;
        finished = true;
        clearInterval(timers.ticker);
        clearTimeout(timers.watchdog);
        envelope.setSpeaking(false);
        if (!interrupted) reveal(text.length);
        if (startedAt) emit({ type: interrupted ? "output_audio_buffer.cleared" : "output_audio_buffer.stopped" });
        emit({ type: "response.output_audio_transcript.done", item_id: itemId, transcript: interrupted ? text.slice(0, shown) : text });
        lastSpoken = { text, at: performance.now() };
        speaking = null;
        resolve();
      };

      const begin = () => {
        if (startedAt || finished) return;
        startedAt = performance.now();
        envelope.setSpeaking(true);
        emit({ type: "output_audio_buffer.started" });
        timers.ticker = setInterval(() => {
          const progress = (performance.now() - startedAt) / estimate;
          reveal(Math.floor(text.length * Math.min(0.97, progress)));
          if (simulated && progress >= 1) finish(false);
        }, 90);
      };

      // Without a working voice (no voices, autoplay blocked, headless browsers), keep the exact same
      // event timeline on a clock so the call still flows and the captions carry the words.
      const simulate = () => {
        simulated = true;
        begin();
      };

      speaking = {
        text,
        interrupt: () => {
          if (speechAvailable()) speechSynthesis.cancel();
          finish(true);
        },
      };

      if (!speechAvailable()) {
        simulate();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      const spanish = SPANISH.test(text);
      const voice = pickVoice(spanish);
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? (spanish ? "es-ES" : "en-US");
      utterance.rate = RATE;
      utterance.volume = volume;
      utterance.onstart = begin;
      utterance.onboundary = (event) => {
        if (event.name !== "word") return;
        envelope.accent();
        reveal(event.charIndex + 1);
      };
      utterance.onend = () => finish(false);
      utterance.onerror = (event) => {
        if (!startedAt) simulate();
        else finish(event.error === "interrupted" || event.error === "canceled");
      };

      timers.watchdog = setTimeout(() => {
        if (startedAt || finished) return;
        utterance.onstart = utterance.onend = utterance.onerror = utterance.onboundary = null;
        speechSynthesis.cancel();
        simulate();
      }, START_TIMEOUT_MS);

      // Chrome can drop an utterance queued right after cancel(), so only clear what is really there.
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    });
  }

  function userStarted() {
    clearTimeout(silenceTimer);
    silences = 0;
    const itemId = id("item");
    emit({ type: "input_audio_buffer.speech_started" });
    speaking?.interrupt();
    return itemId;
  }

  function userFinished(itemId: string, text: string) {
    emit({ type: "input_audio_buffer.speech_stopped" });
    emit({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: text });
    enqueue({ type: "user", text });
  }

  function echo(text: string) {
    if (speaking) return isEcho(text, speaking.text);
    return performance.now() - lastSpoken.at < ECHO_WINDOW_MS && isEcho(text, lastSpoken.text);
  }

  function onResult(event: RecognitionEvent) {
    if (muted || closed) return;
    failures = 0;
    let text = "";
    let final = true;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      text += result?.[0]?.transcript ?? "";
      if (!result?.isFinal) final = false;
    }
    text = text.trim();
    if (!text || (!hearing && echo(text))) return;

    hearing ??= { itemId: userStarted(), shown: "" };
    const current = hearing;
    if (final) {
      hearing = null;
      userFinished(current.itemId, text);
      return;
    }
    // Realtime deltas only ever append, so forward an interim result only when it extends what is shown.
    if (text.startsWith(current.shown) && text.length > current.shown.length) {
      emit({ type: "conversation.item.input_audio_transcription.delta", item_id: current.itemId, delta: text.slice(current.shown.length) });
      current.shown = text;
    }
  }

  function listen() {
    const Ctor = recognitionCtor();
    if (!Ctor || closed || muted || recognition) return;
    const rec = new Ctor();
    let failed = false;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = onResult;
    rec.onerror = (event) => {
      // Blocked or unsupported leaves "Type to talk". Silence just restarts; real failures back off.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") rec.onend = null;
      failed = event.error !== "no-speech" && event.error !== "aborted";
    };
    rec.onend = () => {
      recognition = null;
      restartTimer = setTimeout(listen, failed ? Math.min(8_000, 500 * 2 ** failures++) : 150);
    };
    recognition = rec;
    try {
      rec.start();
    } catch {
      recognition = null;
    }
  }

  function stopListening() {
    clearTimeout(restartTimer);
    if (!recognition) return;
    recognition.onend = null;
    recognition.abort();
    recognition = null;
    hearing = null;
  }

  return {
    async offer() {
      return undefined;
    },
    async start(connection) {
      if (connection.mode !== "mock") throw new Error("expected a mock connection");
      listen();
      enqueue({ type: "start" });
    },
    sendToolOutput(callId) {
      outputs.get(callId)?.();
    },
    sendNote(note: CallNote) {
      // News from the thread (the Gmail fact, a text) restarts the patience for silence.
      silences = 0;
      enqueue({ type: "system", ...note });
    },
    sendUserText(text) {
      const trimmed = text.trim();
      if (trimmed) userFinished(userStarted(), trimmed);
    },
    setMuted(next) {
      muted = next;
      if (muted) stopListening();
      else listen();
    },
    setVolume(next) {
      volume = next;
    },
    // The mock listens through the browser's recognizer, not the call's mic.
    replaceMic: async () => undefined,
    resume: () => undefined,
    agentLevel() {
      return envelope.read();
    },
    close() {
      closed = true;
      clearTimeout(silenceTimer);
      stopListening();
      speaking?.interrupt();
      for (const release of outputs.values()) release();
    },
  };
}
