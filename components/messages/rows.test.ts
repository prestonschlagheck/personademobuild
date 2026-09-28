import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@/lib/session/schema";
import { callSummary } from "./rows";
import type { RowItem } from "./thread-model";

const AT = "2026-09-27T16:00:00.000Z";
const ended = (content: string, callSeconds = 0): RowItem => {
  const event: SessionEvent = { seq: 1, id: "e1", at: AT, channel: "system", role: "system", content, meta: { kind: "call_ended", callSeconds } };
  return { type: "row", key: event.id, kind: "call_ended", at: AT, event, fresh: false };
};

describe("callSummary", () => {
  it("names which mic problem stopped a call, since each has its own fix", () => {
    expect(["mic_denied", "mic_missing", "mic_busy"].map((reason) => callSummary(ended(reason))?.detail)).toEqual([
      "Mic blocked",
      "No mic found",
      "Mic in use",
    ]);
  });

  it("gives any other call that never connected its time, and a connected one its length", () => {
    expect(callSummary(ended("error"))).toEqual({ title: "Call ended", detail: callSummary(ended("user_hangup"))?.detail });
    expect(callSummary(ended("error"))?.detail).not.toMatch(/mic/i);
    expect(callSummary(ended("mic_missing", 42))?.title).toBe("Audio call");
  });
});
