import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecognitionEvent } from "@/lib/client/speech";
import { createLiveCaptions } from "@/lib/voice/live-captions";

class FakeRecognition {
  static last: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: RecognitionEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start() {
    FakeRecognition.last = this;
  }
  stop() {}
  abort() {}
  /** Each phrase is [text, isFinal], in the order the recognizer holds them. */
  hear(...phrases: [string, boolean][]) {
    const results = phrases.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
    this.onresult?.({ resultIndex: 0, results });
  }
}

describe("live captions", () => {
  const onCaption = vi.fn<(itemId: string, text: string) => void>();

  beforeEach(() => {
    onCaption.mockReset();
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("navigator", { language: "en-US" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("writes nothing until the server's VAD opens a line, so the agent's own voice never shows as the caller", () => {
    const captions = createLiveCaptions(onCaption)!;
    FakeRecognition.last!.hear(["hi there i'm persona", true]);
    expect(onCaption).not.toHaveBeenCalled();

    captions.speechStarted("item_1");
    FakeRecognition.last!.hear(["hi there i'm persona", true], ["i'm", false]);
    FakeRecognition.last!.hear(["hi there i'm persona", true], ["i'm sam", false]);
    expect(onCaption).toHaveBeenLastCalledWith("item_1", "i'm sam");
    expect(captions.owns("item_1")).toBe(true);
  });

  it("stops writing a line once the server's transcript for it lands", () => {
    const captions = createLiveCaptions(onCaption)!;
    captions.speechStarted("item_1");
    FakeRecognition.last!.hear(["call me sam", false]);
    captions.settled("item_1");
    FakeRecognition.last!.hear(["call me sam please", false]);
    expect(onCaption).toHaveBeenCalledTimes(1);
  });

  it("stays off where the stage transcript is hidden", () => {
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition, matchMedia: () => ({ matches: false }) });
    expect(createLiveCaptions(onCaption)).toBeNull();
  });
});
