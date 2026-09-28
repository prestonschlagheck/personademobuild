import { recognitionCtor, type Recognition, type RecognitionEvent } from "@/lib/client/speech";

// Realtime writes the caller's words down only after they stop talking. Where the browser has a recognizer, this
// captions them while they talk, keyed to the item the server's VAD opened, and the server's transcript replaces
// the line when it lands. Only the server's VAD opens a line, so the agent's voice leaking into the recognizer
// never shows up as the caller. Desktop only: on a phone the stage transcript is hidden, and a second capture can
// take the audio session from the call.

export type LiveCaptions = {
  /** The server heard the caller start: results from here on belong to this item. */
  speechStarted(itemId: string): void;
  /** The server's transcript for this item arrived, so the recognizer stops writing it. */
  settled(itemId: string): void;
  /** Whether this item's line is ours, in which case the server's deltas would only append to it. */
  owns(itemId: string): boolean;
  setMuted(muted: boolean): void;
  close(): void;
};

export function createLiveCaptions(onCaption: (itemId: string, text: string) => void): LiveCaptions | null {
  const Ctor = recognitionCtor();
  if (!Ctor || !window.matchMedia("(pointer: fine)").matches) return null;
  const Recognizer = Ctor;

  let recognition: Recognition | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let closed = false;
  let muted = false;
  // The utterance the server is hearing, and the first recognizer result that belongs to it.
  let item: string | null = null;
  let from = 0;
  let results: RecognitionEvent["results"] | null = null;
  const shown = new Set<string>();
  const settled = new Set<string>();

  const finals = () => {
    let count = 0;
    while (results && count < results.length && results[count]?.isFinal) count++;
    return count;
  };

  function render() {
    if (!item || !results || settled.has(item)) return;
    let text = "";
    for (let i = from; i < results.length; i++) text += results[i]?.[0]?.transcript ?? "";
    text = text.trim();
    if (!text) return;
    shown.add(item);
    onCaption(item, text);
  }

  function listen() {
    if (closed || muted || recognition) return;
    const rec = new Recognizer();
    let failed = false;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (event) => {
      failures = 0;
      results = event.results;
      render();
    };
    rec.onerror = (event) => {
      // Blocked or unsupported: the server's transcript still arrives, just after they finish.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") rec.onend = null;
      failed = event.error !== "no-speech" && event.error !== "aborted";
    };
    rec.onend = () => {
      recognition = null;
      results = null;
      from = 0;
      restartTimer = setTimeout(listen, failed ? Math.min(8_000, 500 * 2 ** failures++) : 100);
    };
    recognition = rec;
    try {
      rec.start();
    } catch {
      recognition = null;
    }
  }

  function stop() {
    clearTimeout(restartTimer);
    if (!recognition) return;
    recognition.onend = null;
    recognition.abort();
    recognition = null;
    results = null;
    from = 0;
  }

  listen();

  return {
    speechStarted(itemId) {
      item = itemId;
      // Finished phrases are what came before; one still in progress is most likely this utterance's start.
      from = finals();
      render();
    },
    settled(itemId) {
      settled.add(itemId);
      if (item === itemId) item = null;
    },
    owns: (itemId) => shown.has(itemId),
    setMuted(next) {
      muted = next;
      if (muted) {
        item = null;
        stop();
      } else listen();
    },
    close() {
      closed = true;
      item = null;
      stop();
    },
  };
}
