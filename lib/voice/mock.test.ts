import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession } from "@/lib/session/schema";
import { createMockTransport, isEcho } from "@/lib/voice/mock";
import type { ServerEvent } from "@/lib/voice/transport";

describe("isEcho", () => {
  const said = "hey, it's buddy. calling to get you set up. what should i call you?";

  it("recognizes the agent's own words coming back through the mic", () => {
    expect(isEcho("calling to get you set up", said)).toBe(true);
    expect(isEcho("", said)).toBe(true);
  });

  it("lets real answers through", () => {
    expect(isEcho("call me preston", said)).toBe(false);
    expect(isEcho("i need help with my inbox", said)).toBe(false);
  });
});

type ToolCall = Extract<ServerEvent, { type: "response.function_call_arguments.done" }>;
const isToolCall = (e: ServerEvent): e is ToolCall => e.type === "response.function_call_arguments.done";

// Node has no speechSynthesis, so the transport runs its timed fallback: the same events, no audio.
describe("createMockTransport", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] }));
  afterEach(() => vi.useRealTimers());

  function connect() {
    const events: ServerEvent[] = [];
    const session = { ...newSession("s1", "2026-09-27T01:00:00.000Z"), call: { status: "active" as const, attempts: 1 } };
    const transport = createMockTransport({ onEvent: (e) => events.push(e), onConnectionState: () => undefined }, () => session);
    return { events, transport, types: () => events.map((e) => e.type) };
  }

  it("opens with a hello by name, spoken with Realtime's event timeline", async () => {
    const { transport, events, types } = connect();
    await transport.start({ mode: "mock", callId: "mock_1" }, newSession("s1", "2026-09-27T01:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(types().slice(0, 2)).toEqual(["response.created", "output_audio_buffer.started"]);
    expect(types()).toContain("response.output_audio_transcript.delta");
    const done = events.find((e) => e.type === "response.output_audio_transcript.done");
    expect(done && "transcript" in done ? done.transcript : "").toMatch(/^hey, it's Persona\. calling to get your name, what you need, and your gmail hooked up, so i can start helping\./);
    expect(types().indexOf("output_audio_buffer.stopped")).toBeLessThan(types().indexOf("response.done"));
    transport.close();
  });

  it("waits for each tool output before the next call and before speaking", async () => {
    const { transport, events, types } = connect();
    await transport.start({ mode: "mock", callId: "mock_1" }, newSession("s1", "2026-09-27T01:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(10_000);
    events.length = 0;

    transport.sendUserText("i'm preston");
    await vi.advanceTimersByTimeAsync(0);
    expect(types().slice(0, 3)).toEqual([
      "input_audio_buffer.speech_started",
      "input_audio_buffer.speech_stopped",
      "conversation.item.input_audio_transcription.completed",
    ]);

    const answered = new Set<string>();
    const pending = () => events.filter(isToolCall).find((e) => !answered.has(e.call_id));
    expect(pending()).toBeDefined();
    for (let call = pending(); call; call = pending()) {
      expect(events.filter(isToolCall)).toHaveLength(answered.size + 1);
      expect(types()).not.toContain("output_audio_buffer.started");
      answered.add(call.call_id);
      transport.sendToolOutput(call.call_id, { ok: true, state: "" });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(types()).toContain("output_audio_buffer.started");
    transport.close();
  });

  it("waits through silence, checks in once, and says its goodbye before end_call at about 45 s", async () => {
    const { transport, events, types } = connect();
    await transport.start({ mode: "mock", callId: "mock_1" }, newSession("s1", "2026-09-27T01:00:00.000Z"));
    const answered = new Set<string>();
    let openedAt = -1;
    let goodbyeAt = -1;
    for (let second = 0; second < 200; second++) {
      for (const call of events.filter(isToolCall).filter((e) => !answered.has(e.call_id))) {
        answered.add(call.call_id);
        transport.sendToolOutput(call.call_id, { ok: true, state: "" });
      }
      await vi.advanceTimersByTimeAsync(1_000);
      if (openedAt < 0 && events.some((e) => e.type === "response.done")) openedAt = second;
      if (goodbyeAt < 0 && events.some(isToolCall)) goodbyeAt = second;
    }
    // About 45 s of silence after the opening: the check-in at about 21 s, then three more quiet stretches.
    expect(goodbyeAt - openedAt).toBeGreaterThanOrEqual(42);
    expect(goodbyeAt - openedAt).toBeLessThanOrEqual(48);

    const spoken = events.flatMap((e) => (e.type === "response.output_audio_transcript.done" ? [e.transcript] : []));
    expect(spoken.slice(1)).toEqual(["take your time, i'm here.", "i'll text you the rest."]);
    const end = events.findIndex((e) => isToolCall(e) && e.name === "end_call");
    const goodbye = events.findIndex((e) => e.type === "response.output_audio_transcript.done" && e.transcript === "i'll text you the rest.");
    expect(goodbye).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(goodbye);
    expect(types().indexOf("response.done", end)).toBeGreaterThan(end);
    transport.close();
  });
});
