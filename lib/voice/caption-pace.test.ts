import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptionPace, revealTo } from "@/lib/voice/caption-pace";
import { VOICE_SPEED } from "@/lib/voice/transport";

describe("CaptionPace", () => {
  let clock = 0;
  let shown: string[] = [];
  let lines: Record<string, string> = {};
  let heard: [string, string, boolean][] = [];
  const pace = (speed = 1) =>
    new CaptionPace(
      (id, text) => {
        shown.push(text);
        lines[id] = text;
      },
      speed,
      () => clock,
      (id, text, cut) => heard.push([id, text, cut]),
    );
  const advance = async (ms: number) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const step = async (ms: number) => {
    for (let t = 0; t < ms; t += 40) await advance(40);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    shown = [];
    lines = {};
    heard = [];
  });
  afterEach(() => vi.useRealTimers());

  it("shows nothing before the voice starts, then each word as the voice starts it", async () => {
    const p = pace();
    p.add("a1", "hey, it's buddy. what should i call you?");
    await advance(1_000);
    expect(shown).toEqual([]);
    p.started();
    await step(40);
    // The first sound already shows the first word.
    expect(shown.at(-1)).toBe("hey,");
    await step(960);
    // About 18 characters a second: the voice is partway into "what", which shows whole.
    expect(shown.at(-1)).toBe("hey, it's buddy. what");
    p.stopped();
    expect(shown.at(-1)).toBe("hey, it's buddy. what should i call you?");
  });

  it("is never behind the voice, and never more than the word it is saying ahead, at the call's speed", async () => {
    const text = "okay, so the fastest way to get your inbox sorted is the google link i just texted you.";
    const cps = 18 * VOICE_SPEED;
    const p = pace(VOICE_SPEED);
    p.add("a1", text);
    p.started();
    for (let ms = 40; ms <= 5_000; ms += 40) {
      await advance(40);
      const said = Math.min(text.length, Math.floor((ms / 1_000) * cps));
      const caption = lines.a1 ?? "";
      expect(caption.length).toBeGreaterThanOrEqual(said);
      expect(caption.length).toBeLessThanOrEqual(revealTo(text, said + 1));
    }
  });

  it("lets the full transcript replace the pieces without running ahead, and stops where an interruption did", async () => {
    const p = pace();
    p.add("a1", "hey");
    p.final("a1", "hey there, what should i call you?");
    p.started();
    await step(600);
    expect(shown.at(-1)).toBe("hey there, what");
    p.cleared();
    await step(2_000);
    expect(shown.at(-1)).toBe("hey there, what");
    // Only what was heard counts as said, marked as cut off.
    expect(heard).toEqual([["a1", "hey there, what", true]]);
  });

  it("reports a line heard to the end once, with its whole transcript", async () => {
    const p = pace();
    p.add("a1", "got it, preston.");
    p.started();
    await step(400);
    p.stopped();
    expect(heard).toEqual([]);
    // The transcript can land after the audio ends, as the mock sends it.
    p.final("a1", "got it, Preston.");
    expect(heard).toEqual([["a1", "got it, Preston.", false]]);
    expect(shown.at(-1)).toBe("got it, Preston.");
  });

  it("plays a reply's lines one after another, each waiting for the one before it", async () => {
    const p = pace();
    p.add("a1", "okay.");
    p.final("a1", "okay.");
    p.add("a2", "hey, it's buddy again. what should i call you?");
    p.started();
    await step(200);
    expect(lines).toEqual({ a1: "okay." });
    await step(400);
    expect(heard).toEqual([["a1", "okay.", false]]);
    expect(lines.a2).toBe("hey, it's");
  });

  it("never shows or reports a line whose audio never played", async () => {
    const p = pace();
    p.add("a1", "okay, picking up.");
    p.final("a1", "okay, picking up.");
    p.add("a2", "hey, it's buddy again.");
    p.final("a2", "hey, it's buddy again.");
    p.started();
    await step(300);
    p.cleared();
    expect(lines.a2).toBeUndefined();
    expect(heard).toEqual([["a1", "okay, picking", true]]);

    // A reply cancelled before any of it played is dropped too, and its late pieces bring nothing back.
    p.add("a3", "sure, what");
    p.cancelled();
    p.add("a3", " should i call you?");
    p.add("a4", "go ahead.");
    p.final("a4", "go ahead.");
    p.started();
    await step(1_000);
    p.stopped();
    expect(lines.a3).toBeUndefined();
    expect(heard.at(-1)).toEqual(["a4", "go ahead.", false]);
  });

  it("carries on with the next line when the audio stops between two lines of one reply", async () => {
    const p = pace();
    p.add("a1", "okay.");
    p.final("a1", "okay.");
    p.add("a2", "hey, it's buddy again.");
    p.final("a2", "hey, it's buddy again.");
    p.started();
    await step(160);
    // The first line is said sooner than the estimate: its audio stops, and the next line's starts.
    p.stopped();
    await advance(100);
    expect(lines.a2).toBeUndefined();
    p.started();
    await step(40);
    expect(heard[0]).toEqual(["a1", "okay.", false]);
    expect(lines.a2).toBe("hey,");

    // With no line after it, a stop that the audio never picks up again ends the reply.
    await step(200);
    p.stopped();
    await advance(400);
    expect(heard.at(-1)).toEqual(["a2", "hey, it's buddy again.", false]);
  });

  it("counts every line heard to the end as said when the call ends, and the goodbye as said in full", async () => {
    const p = pace();
    p.add("a1", "bye for now, preston.");
    p.final("a1", "bye for now, preston.");
    p.started();
    await step(200);
    p.hangUp(true);
    expect(heard).toEqual([["a1", "bye for now, preston.", false]]);
    expect(shown.at(-1)).toBe("bye for now, preston.");
  });

  it("tells which line is playing, and whether a line is still to be heard", async () => {
    const p = pace();
    p.add("a1", "hey, it's buddy.");
    expect(p.hearing()).toBeNull();
    p.started();
    await step(40);
    expect(p.hearing()).toBe("a1");
    expect(p.pending("a1")).toBe(true);
    p.cleared();
    expect(p.pending("a1")).toBe(false);
  });

  describe("while it can hear the voice", () => {
    let sounding = false;
    const listening = () => {
      const p = pace();
      p.listen(() => sounding);
      return p;
    };

    beforeEach(() => {
      sounding = false;
    });

    it("waits for the first sound, not the playback event", async () => {
      const p = listening();
      p.add("a1", "hey, it's buddy. what should i call you?");
      p.started();
      await step(400);
      expect(shown).toEqual([]);
      sounding = true;
      await step(1_000);
      expect(shown.at(-1)).toBe("hey, it's buddy. what");
    });

    it("lines up on the clause the voice just finished when it pauses, so the next word shows as it starts", async () => {
      const p = listening();
      p.add("a1", "hey there, it's buddy, your new assistant. what should i call you?");
      p.started();
      sounding = true;
      // A touch behind a voice that has already said "your new assistant."
      await step(2_000);
      expect(shown.at(-1)).toBe("hey there, it's buddy, your new assistant.");
      sounding = false;
      await step(600);
      expect(shown.at(-1)).toBe("hey there, it's buddy, your new assistant.");
      sounding = true;
      await step(80);
      expect(shown.at(-1)).toBe("hey there, it's buddy, your new assistant. what");
    });

    it("holds a caption that ran ahead until the voice gets there", async () => {
      const p = listening();
      p.add("a1", "hey there, it's buddy, your new assistant. what should i call you?");
      p.started();
      sounding = true;
      // A touch ahead of a voice that has only said "it's buddy," when it pauses.
      await step(1_400);
      expect(shown.at(-1)).toBe("hey there, it's buddy, your");
      sounding = false;
      await step(200);
      sounding = true;
      await step(200);
      expect(shown.at(-1)).toBe("hey there, it's buddy, your");
      await step(240);
      expect(shown.at(-1)).toBe("hey there, it's buddy, your new");
    });

    it("runs on the clock when the meter never hears anything", async () => {
      const p = listening();
      p.add("a1", "hey, it's buddy. what should i call you?");
      p.started();
      await step(1_600);
      expect(shown.at(-1)).toBe("hey, it's buddy. what should i");
    });
  });
});
