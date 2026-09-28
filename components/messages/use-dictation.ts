import { useCallback, useEffect, useRef, useState } from "react";
import { useClientValue } from "@/lib/client/browser-store";
import { recognitionCtor, type Recognition } from "@/lib/client/speech";
import type { ComposerField } from "./use-composer-field";

// Dictation into the composer, like the mic in the iOS text field. Hidden where the browser has no recognizer.
export function useDictation({ ref, setValue }: Pick<ComposerField, "ref" | "setValue">) {
  const supported = useClientValue(() => Boolean(recognitionCtor()), false);
  const [listening, setListening] = useState(false);
  const active = useRef<Recognition | null>(null);

  const stop = useCallback(() => active.current?.stop(), []);

  // Sending ends dictation for good: stop() would still deliver a final result and refill the sent text.
  const cancel = useCallback(() => {
    const recognition = active.current;
    if (!recognition) return;
    recognition.onresult = recognition.onend = recognition.onerror = null;
    recognition.abort();
    active.current = null;
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (active.current) return stop();
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    const typed = ref.current?.value.trimEnd() ?? "";
    const prefix = typed ? `${typed} ` : "";
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = ({ results }) => {
      const spoken = Array.from(results, (result) => result?.[0]?.transcript ?? "").join("");
      setValue(prefix + spoken.trimStart());
    };
    recognition.onend = recognition.onerror = () => {
      active.current = null;
      setListening(false);
    };
    active.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      cancel();
    }
  }, [ref, setValue, stop, cancel]);

  useEffect(() => () => active.current?.abort(), []);

  return { supported, listening, toggle, cancel };
}
