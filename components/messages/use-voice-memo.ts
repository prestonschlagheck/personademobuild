import { useCallback, useEffect, useRef, useState } from "react";
import { useClientValue } from "@/lib/client/browser-store";
import { recognitionCtor, type Recognition } from "@/lib/client/speech";

// An audio message, as the composer's waveform button records one: held down, or started from the plus menu and
// stopped with the send button. The agent reads text, so what is sent is the recognizer's transcript of it.

export type VoiceMemo = {
  supported: boolean;
  /** "hold" ends when the button is let go; "tap" when the send button is pressed. */
  recording: { mode: "hold" | "tap"; startedAt: number; transcript: string } | null;
  start: (mode: "hold" | "tap") => void;
  /** Stops and sends what was heard, once the recognizer has finished writing it down. */
  finish: () => void;
  cancel: () => void;
};

export function useVoiceMemo(onSend: (text: string) => void): VoiceMemo {
  const supported = useClientValue(() => Boolean(recognitionCtor()), false);
  const [recording, setRecording] = useState<VoiceMemo["recording"]>(null);
  const active = useRef<Recognition | null>(null);
  const heard = useRef("");
  const send = useRef(onSend);
  useEffect(() => {
    send.current = onSend;
  }, [onSend]);

  const cancel = useCallback(() => {
    const recognition = active.current;
    active.current = null;
    setRecording(null);
    if (!recognition) return;
    recognition.onresult = recognition.onend = recognition.onerror = null;
    recognition.abort();
  }, []);

  const start = useCallback(
    (mode: "hold" | "tap") => {
      const Ctor = recognitionCtor();
      if (!Ctor || active.current) return;
      const recognition = new Ctor();
      heard.current = "";
      recognition.lang = navigator.language || "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = ({ results }) => {
        heard.current = Array.from(results, (result) => result?.[0]?.transcript ?? "")
          .join("")
          .trim();
        setRecording((r) => r && { ...r, transcript: heard.current });
      };
      // Blocked or failed: nothing was recorded, so nothing is sent.
      recognition.onerror = cancel;
      recognition.onend = () => {
        active.current = null;
        setRecording(null);
      };
      active.current = recognition;
      setRecording({ mode, startedAt: Date.now(), transcript: "" });
      try {
        recognition.start();
      } catch {
        cancel();
      }
    },
    [cancel],
  );

  const finish = useCallback(() => {
    const recognition = active.current;
    if (!recognition) return;
    // stop() still delivers the last words, then ends; the memo goes out with them.
    recognition.onend = () => {
      active.current = null;
      setRecording(null);
      if (heard.current) send.current(heard.current);
    };
    recognition.stop();
  }, []);

  useEffect(() => () => active.current?.abort(), []);

  return { supported, recording, start, finish, cancel };
}
