import { useSyncExternalStore } from "react";

// Small client-only stores. Every localStorage key shares one prefix, and every read and write keeps
// an in-memory copy, so a blocked storage (private mode, previews) still works for the page's life.

const PREFIX = "persona.";
const noSubscribe = () => () => {};

/** A value only the browser can know, fixed for the page's life. `server` renders until hydration. */
export function useClientValue<T>(get: () => T, server: T): T {
  return useSyncExternalStore(noSubscribe, get, () => server);
}

export type StoredValue<T> = { read: () => T; write: (value: T) => void; subscribe: (onChange: () => void) => () => void };

/** One localStorage entry as an external store, kept in step across tabs by the storage event. */
export function createStoredValue<T>(key: string, parse: (raw: string | null) => T, serialize: (value: T) => string): StoredValue<T> {
  const name = PREFIX + key;
  const listeners = new Set<() => void>();
  let cached: { value: T } | null = null;

  const read = () => {
    if (!cached) {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(name);
      } catch {
        // Blocked storage reads as empty.
      }
      cached = { value: parse(raw) };
    }
    return cached.value;
  };

  const write = (value: T) => {
    cached = { value };
    try {
      localStorage.setItem(name, serialize(value));
    } catch {
      // Blocked storage: the in-memory copy still holds for this page.
    }
    for (const notify of listeners) notify();
  };

  const subscribe = (onChange: () => void) => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== name) return;
      cached = null;
      onChange();
    };
    listeners.add(onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  };

  return { read, write, subscribe };
}
