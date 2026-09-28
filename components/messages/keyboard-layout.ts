export type KeyAction =
  | { kind: "char"; char: string }
  | { kind: "word"; word: string }
  | { kind: "space" | "delete" | "return" | "shift" | "switch" | "emoji" | "mic" };

export type KeyDef = { id: string; x: number; y: number; w: number; h: number; action: KeyAction };

// Key rectangles measured from public/ios/keyboard.svg (viewBox "20 192 402 342"), in points from its top left.
const row = (letters: string, x: number, step: number, y: number, w: number): KeyDef[] =>
  Array.from(letters, (char, i) => ({ id: char, x: x + i * step, y, w, h: 45, action: { kind: "char", char } }));

const key = (id: string, x: number, y: number, w: number, h: number, action: KeyAction): KeyDef => ({ id, x, y, w, h, action });

export const KEYS: KeyDef[] = [
  key("s0", 0, 4, 133.33, 41, { kind: "word", word: "The" }),
  key("s1", 133.33, 4, 134.34, 41, { kind: "word", word: "the" }),
  key("s2", 267.67, 4, 134.33, 41, { kind: "word", word: "to" }),
  ...row("qwertyuiop", 8.5, 39.1, 49, 33.1),
  ...row("asdfghjkl", 28.5, 39, 105, 33),
  key("shift", 8.5, 161, 44.67, 45, { kind: "shift" }),
  ...row("zxcvbnm", 67.42, 38.975, 161, 32.97),
  key("delete", 348.5, 161, 45, 45, { kind: "delete" }),
  key("switch", 8.5, 217, 91.67, 45, { kind: "switch" }),
  key("space", 106.17, 217, 189.33, 45, { kind: "space" }),
  key("return", 301.5, 217, 92, 45, { kind: "return" }),
  key("emoji", 27.5, 280.5, 44, 44, { kind: "emoji" }),
  key("mic", 331.5, 281, 44, 44, { kind: "mic" }),
];

const PHYSICAL: Record<string, string> = { " ": "space", Backspace: "delete", Enter: "return", Shift: "shift" };

// The on-screen twin of a physical key, so real typing lights the drawn keyboard.
export function keyIdFor(e: KeyboardEvent) {
  return /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : (PHYSICAL[e.key] ?? null);
}
