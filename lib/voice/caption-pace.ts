// The agent's captions keep pace with its voice. Realtime sends the transcript well ahead of the audio and no word
// timings, so words are let out at the speaking rate, counted only while the voice is actually sounding, and each word
// shows as the voice starts it rather than once it is over. A reply can come as more than one line; they play one after
// another, so they share one clock and each waits for the one before it. When the voice falls quiet mid-line it has
// just finished a clause, so the caption lines up on the nearest comma, period or line end and any drift starts over
// there. Without a way to hear the voice (the mock), the rate simply runs from the moment playback starts.
//
// Only what was heard counts as said: a line reports itself once its audio is over, in full, or cut off where the voice
// stopped. A line whose audio never played is never shown or reported.

/** Characters a second while the voice sounds at its own pace, pauses left out: about 180 words a minute. */
const BASE_CPS = 18;
const STEP_MS = 40;
/** Quiet this long is a pause between clauses, not the gap inside a word. */
const PAUSE_MS = 160;
/** How far from the estimate a clause end can be and still be the one just said. */
const SNAP_CHARS = 24;
/** Never heard a sound this long into playback: the meter is not hearing it, so the rate runs on the clock. */
const DEAF_MS = 1_200;
/** Audio that stops with lines still to come and starts again within this is the step between two lines of one reply. */
const GAP_MS = 350;

/** Where each clause ends: just past a comma, period or other stop that is followed by a space or the end. */
function clauseEnds(text: string) {
  const ends: number[] = [];
  for (const match of text.matchAll(/[,.!?;:—](?=\s|$)/g)) ends.push(match.index + 1);
  return ends;
}

/** How much of a line to show once `due` characters of it are said: through the end of the word being said. */
export function revealTo(text: string, due: number): number {
  if (due <= 0) return 0;
  if (due >= text.length) return text.length;
  const end = text.indexOf(" ", due);
  return end < 0 ? text.length : end;
}

type Line = { id: string; text: string; final: boolean; shown: number };

/** A line's audio is over: `text` is what was heard of it, all of it unless `cut`. */
export type Heard = (id: string, text: string, cut: boolean) => void;

export class CaptionPace {
  /** Lines being said or waiting their turn, in the order they play. */
  private lines: Line[] = [];
  /** Lines heard to the end whose whole transcript has not arrived yet, with what was shown of them. */
  private readonly unfinished = new Map<string, string>();
  /** Lines already reported or dropped, whose late pieces change nothing. */
  private readonly over = new Set<string>();
  /** Milliseconds of the queue heard so far, from the start of its first line. */
  private spoken = 0;
  /** Milliseconds the voice actually sounded since playback started, and the characters heard in them. */
  private sounded = 0;
  private heardChars = 0;
  private quiet = 0;
  private paused = false;
  private heard = false;
  private sinceStart = 0;
  private last: number | null = null;
  private cps: number;
  private audible: (() => boolean) | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Stopped with lines still to come, until the audio starts again or the gap ends the reply. */
  private resting: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly show: (id: string, text: string) => void,
    speed = 1,
    private readonly now = () => performance.now(),
    private readonly heardLine: Heard = () => undefined,
  ) {
    this.cps = BASE_CPS * speed;
  }

  /** How to tell the voice is sounding right now, or null to run on the clock alone. */
  listen(audible: (() => boolean) | null) {
    this.audible = audible;
  }

  /** A piece of a line being said. A new line waits its turn behind the ones before it. */
  add(id: string, delta: string) {
    if (this.over.has(id)) return;
    const line = this.lines.find((l) => l.id === id);
    if (line) line.text += delta;
    else this.lines.push({ id, text: delta, final: false, shown: 0 });
  }

  /** The whole line, which replaces the pieces without showing any more of it early. */
  final(id: string, text: string) {
    const shown = this.unfinished.get(id);
    if (shown !== undefined) {
      this.unfinished.delete(id);
      if (text !== shown) this.show(id, text);
      this.report(id, text, false);
      return;
    }
    if (this.over.has(id)) return;
    const line = this.lines.find((l) => l.id === id);
    if (line) {
      line.text = text;
      line.final = true;
    } else this.lines.push({ id, text, final: true, shown: 0 });
  }

  started() {
    this.last = this.now();
    this.timer ??= setInterval(() => this.step(), STEP_MS);
    if (this.resting) {
      // The next line of the same reply: the one playing when the audio stopped was said to its end.
      this.rest();
      const at = this.lineAt(this.due());
      if (at) this.spoken = ((at.offset + at.line.text.length) / this.cps) * 1_000;
      this.reveal();
      return;
    }
    this.heard = false;
    this.sinceStart = 0;
    this.sounded = 0;
    this.heardChars = 0;
  }

  /** The audio ran out. Every line it reached was heard to the end; lines it never reached may be the next one of this reply. */
  stopped() {
    this.halt();
    const reached = this.lineAt(this.due());
    const through = reached ? this.lines.indexOf(reached.line) + 1 : this.lines.length;
    if (through >= this.lines.length) return this.finish(this.lines.length);
    this.rest();
    const lines = this.lines.length;
    this.resting = setTimeout(() => this.finish(lines), GAP_MS);
  }

  /** Cut off mid-line: the caption stops where the voice did, and a line it never reached is dropped unheard. */
  cleared() {
    this.halt();
    this.rest();
    const lines = this.lines;
    this.reset();
    for (const line of lines) {
      if (line.shown === 0) this.over.add(line.id);
      else this.report(line.id, line.text.slice(0, line.shown), !line.final || line.shown < line.text.length);
    }
  }

  /** The reply was cancelled. With no audio playing, the lines it had not started playing are never heard. */
  cancelled() {
    if (this.timer) return;
    for (const line of this.lines) if (line.shown === 0) this.over.add(line.id);
    this.lines = this.lines.filter((line) => line.shown > 0);
  }

  /**
   * The call is ending. Lines heard to the end are reported as they stand; `complete` also counts every line with words
   * as heard in full, as when the agent's own goodbye plays out.
   */
  hangUp(complete: boolean) {
    for (const [id, text] of this.unfinished) this.report(id, text, false);
    this.unfinished.clear();
    if (complete) this.finish(this.lines.length);
  }

  /** The line playing right now, if any. */
  hearing(): string | null {
    if (!this.timer) return null;
    return this.lineAt(this.due())?.line.id ?? this.lines[0]?.id ?? null;
  }

  /** Whether this line is still to be heard, so words said over it wait for it to be reported first. */
  pending(id: string): boolean {
    return this.lines.some((line) => line.id === id);
  }

  close() {
    this.halt();
    this.rest();
    this.reset();
    this.unfinished.clear();
    this.over.clear();
  }

  private report(id: string, text: string, cut: boolean) {
    this.over.add(id);
    this.heardLine(id, text, cut);
  }

  private halt() {
    this.last = null;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private rest() {
    clearTimeout(this.resting);
    this.resting = undefined;
  }

  private reset() {
    this.lines = [];
    this.spoken = 0;
    this.quiet = 0;
    this.paused = false;
  }

  private due() {
    return (this.spoken / 1_000) * this.cps;
  }

  /** The line the estimate is in, with where it starts in the queue. */
  private lineAt(due: number) {
    let offset = 0;
    for (const line of this.lines) {
      if (due < offset + line.text.length) return { line, offset };
      offset += line.text.length;
    }
    return null;
  }

  private step() {
    const now = this.now();
    const dt = this.last === null ? 0 : now - this.last;
    this.last = now;
    this.sinceStart += dt;
    if (!this.lines.length) return;

    const sounding = !this.audible || this.audible();
    if (sounding) this.heard = true;
    else if (!this.heard && this.sinceStart > DEAF_MS) {
      // The meter hears nothing at all (a suspended audio context): run on the clock, from when playback started.
      this.heard = true;
      this.audible = null;
      this.spoken += this.sinceStart - dt;
      this.sounded += this.sinceStart - dt;
    }
    if (!this.audible || sounding) {
      this.spoken += dt;
      this.sounded += dt;
      this.quiet = 0;
      this.paused = false;
    } else if (this.heard) {
      this.quiet += dt;
      if (this.quiet >= PAUSE_MS && !this.paused) {
        this.paused = true;
        this.alignToClause();
      }
    }
    this.reveal();
  }

  /** The voice paused: it most likely just finished the clause nearest to where the estimate is. */
  private alignToClause() {
    const due = this.due();
    let best: number | null = null;
    let offset = 0;
    for (const line of this.lines) {
      for (const end of [...clauseEnds(line.text), line.text.length]) {
        const at = offset + end;
        // The nearest one, and on a tie the later one, since a caption may run ahead of the voice but never behind it.
        if (Math.abs(at - due) <= SNAP_CHARS && (best === null || Math.abs(at - due) <= Math.abs(best - due))) best = at;
      }
      offset += line.text.length;
    }
    if (best === null) return;
    // Behind catches up; ahead holds until the voice gets there.
    this.spoken = (best / this.cps) * 1_000;
  }

  private reveal() {
    // Rounded up, so the first word shows with the first sound.
    const due = Math.ceil(this.due());
    let offset = 0;
    for (const line of this.lines) {
      const cut = revealTo(line.text, due - offset);
      if (cut > line.shown) {
        line.shown = cut;
        this.show(line.id, line.text.slice(0, cut));
      }
      offset += line.text.length;
      if (due < offset) break;
    }
    // A line the voice has said to its end is done, and the next one's clock starts where it ended.
    for (let head = this.lines[0]; head && head.final && this.due() >= head.text.length; head = this.lines[0]) {
      this.lines.shift();
      this.spoken -= (head.text.length / this.cps) * 1_000;
      this.heardChars += head.text.length;
      this.report(head.id, head.text, false);
    }
  }

  /** The first `count` lines were heard to the end: the rest of them shows, and the reply's pace tunes the rate. */
  private finish(count: number) {
    this.halt();
    this.rest();
    const done = this.lines.slice(0, count);
    this.lines = this.lines.slice(count);
    for (const line of done) {
      if (!line.text) continue;
      if (line.shown < line.text.length) this.show(line.id, line.text);
      this.heardChars += line.text.length;
      if (line.final) this.report(line.id, line.text, false);
      else this.unfinished.set(line.id, line.text);
    }
    if (this.heardChars >= 24 && this.sounded > 500) {
      this.cps = (this.cps + Math.min(30, Math.max(10, this.heardChars / (this.sounded / 1_000)))) / 2;
    }
    this.heardChars = 0;
    this.sounded = 0;
    this.spoken = 0;
    this.quiet = 0;
    this.paused = false;
  }
}
