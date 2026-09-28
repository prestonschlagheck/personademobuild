import { describe, expect, it, vi } from "vitest";
import { buildThread } from "@/components/messages/thread-model";
import { newSession } from "@/lib/session/schema";

vi.mock("server-only", () => ({}));

const { diagEntries, heartbeatWithDiag, recordVoiceDiag } = await import("@/lib/server/voice-diag");
const { getStore } = await import("@/lib/server/store");

describe("a live call's record of how its replies went", () => {
  it("keeps codes and nothing else, at most 50 of them", () => {
    expect(diagEntries(["5.0:done:failed:rate_limit_exceeded:n0", "12.3:dead_air:ask", "20.1:lost:3"])).toEqual([
      "5.0:done:failed:rate_limit_exceeded:n0",
      "12.3:dead_air:ask",
      "20.1:lost:3",
    ]);
    // Words, a missing stamp, capitals, spaces and anything that is not a string never get through.
    expect(diagEntries(["5.0:i need help booking an appointment", "done:completed", "5.0:Done", "5.0:", 42, null, { code: "x" }])).toEqual([]);
    expect(diagEntries("5.0:dead_air:ask")).toEqual([]);
    expect(diagEntries(Array(80).fill("1.0:done:completed:n1"))).toHaveLength(50);
  });

  it("never lets a bad record cost the heartbeat its parse", () => {
    expect(heartbeatWithDiag.parse({ attempt: 2 })).toEqual({ attempt: 2 });
    expect(heartbeatWithDiag.parse({ attempt: 2, diag: "anything at all" })).toEqual({ attempt: 2, diag: "anything at all" });
  });

  it("saves one system row per batch, with no content, that the thread never draws", async () => {
    const now = new Date().toISOString();
    await getStore().create({ ...newSession("diag-row", now), call: { status: "active", attempts: 2, initiator: "agent", startedAt: now } });
    await recordVoiceDiag("diag-row", 2, ["5.0:dead_air:ask", "5.1:hello there", "6.2:done:completed:n1"]);
    await recordVoiceDiag("diag-row", 2, ["hello there"]);
    const events = await getStore().listEvents("diag-row", 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: "system",
      role: "system",
      content: "",
      meta: { kind: "voice_diag", callAttempt: 2, diag: ["5.0:dead_air:ask", "6.2:done:completed:n1"] },
    });
    expect(buildThread({ events, cursor: Infinity, baseline: Infinity, pending: [] })).toEqual([]);
  });
});
