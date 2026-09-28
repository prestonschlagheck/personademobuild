import { describe, expect, it } from "vitest";
import { MAX_BATCH, MAX_TEXT, turnRequest } from "@/lib/api/contract";
import { clampText, nextBatch, requeue, retryDelay, threadView, unanswered, type Pending } from "@/lib/client/onboarding";
import { newSession, type SessionEvent, type Snapshot } from "@/lib/session/schema";

const T0 = "2026-09-27T01:00:00.000Z";

let seq = 0;
function event(role: SessionEvent["role"], content: string, clientMsgId?: string): SessionEvent {
  seq += 1;
  return { seq, id: `e${seq}`, at: T0, channel: "text", role, content, meta: { kind: "chat" }, ...(clientMsgId && { clientMsgId }) };
}

const pending = (clientMsgId: string, status: Pending["status"]): Pending => ({ clientMsgId, text: clientMsgId, at: T0, status });

function snapshotOf(events: SessionEvent[]): Snapshot {
  return {
    session: newSession("s1", T0),
    events,
    lastSeq: events.at(-1)?.seq ?? 0,
    modes: { text: "mock", voice: "mock", gmail: "mock", store: "memory" },
  };
}

describe("unanswered", () => {
  it("keeps a text the server stored but never answered, and drops it once an answer lands", () => {
    const stored = [event("agent", "what should i call you?"), event("user", "preston", "m1")];
    const queue = [pending("m1", "failed")];
    expect(unanswered(queue, stored)).toEqual(queue);
    expect(unanswered(queue, [...stored, event("agent", "nice to meet you, preston.")])).toEqual([]);
  });

  it("keeps a text the server has not seen yet", () => {
    const queue = [pending("m2", "sending")];
    expect(unanswered(queue, [event("user", "earlier", "m1"), event("agent", "got it")])).toBe(queue);
  });
});

describe("threadView", () => {
  it("shows a failed turn's stored message once, as the failed bubble with its retry", () => {
    const events = [event("agent", "what should i call you?"), event("user", "preston", "m1")];
    const view = threadView(snapshotOf(events), [pending("m1", "failed")]);
    expect(view.pending.map((m) => m.status)).toEqual(["failed"]);
    expect(view.snapshot?.events.map((e) => e.content)).toEqual(["what should i call you?"]);
  });

  it("shows a stored message that is still being answered as the stored message only", () => {
    const events = [event("user", "preston", "m1")];
    const snapshot = snapshotOf(events);
    for (const status of ["sending", "queued"] as const) {
      const view = threadView(snapshot, [pending("m1", status)]);
      expect(view.pending).toEqual([]);
      expect(view.snapshot).toBe(snapshot);
    }
  });

  it("leaves a message the server has not stored as its pending bubble", () => {
    const snapshot = snapshotOf([event("agent", "hi")]);
    const queue = [pending("m1", "failed"), pending("m2", "queued")];
    expect(threadView(snapshot, queue)).toEqual({ snapshot, pending: queue });
  });
});

describe("clampText", () => {
  it("cuts a long paste to what one message may carry, and the server takes it", () => {
    const pasted = "a".repeat(5000);
    const text = clampText(pasted);
    expect(text).toHaveLength(MAX_TEXT);
    const body = { messages: [{ clientMsgId: crypto.randomUUID(), text }] };
    expect(turnRequest.safeParse(body).success).toBe(true);
    expect(turnRequest.safeParse({ messages: [{ ...body.messages[0], text: pasted }] }).success).toBe(false);
  });

  it("trims, and leaves a short text as it was", () => {
    expect(clampText("  hi there \n")).toBe("hi there");
    expect(clampText("   ")).toBe("");
  });

  it("never splits an emoji at the cut", () => {
    const text = clampText(`${"a".repeat(MAX_TEXT - 1)}😀 and more`);
    expect(text).toBe("a".repeat(MAX_TEXT - 1));
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT);
  });
});

describe("nextBatch", () => {
  const queued = (n: number, text = "hi") => Array.from({ length: n }, (_, i) => ({ ...pending(`q${i}`, "queued"), text }));

  it("takes the oldest queued texts, at most a request's worth, so a long burst goes out over several turns", () => {
    const queue = [pending("f", "failed"), pending("s", "sending"), ...queued(MAX_BATCH + 3)];
    const batch = nextBatch(queue);
    expect(batch.map((m) => m.clientMsgId)).toEqual(queued(MAX_BATCH).map((m) => m.clientMsgId));
    const rest = nextBatch(queue.filter((m) => !batch.includes(m)));
    expect(rest.map((m) => m.clientMsgId)).toEqual(["q10", "q11", "q12"]);
  });

  it("keeps every batch the server would take", () => {
    const batch = nextBatch(queued(MAX_BATCH + 1, "x".repeat(MAX_TEXT)).map((m) => ({ ...m, clientMsgId: crypto.randomUUID() })));
    expect(batch).toHaveLength(MAX_BATCH);
    expect(turnRequest.safeParse({ messages: batch.map(({ clientMsgId, text }) => ({ clientMsgId, text })) }).success).toBe(true);
  });

  it("stays under the body cap even for texts that grow when encoded, and always sends at least one", () => {
    const heavy = "\u0001".repeat(MAX_TEXT);
    const batch = nextBatch(queued(MAX_BATCH, heavy));
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(MAX_BATCH);
    const body = JSON.stringify({ messages: batch.map(({ clientMsgId, text }) => ({ clientMsgId, text })) });
    expect(new TextEncoder().encode(body).length).toBeLessThan(64 * 1024);
  });

  it("is empty with nothing queued", () => {
    expect(nextBatch([pending("f", "failed"), pending("s", "sending")])).toEqual([]);
  });
});

describe("retryDelay", () => {
  it("starts at the busy wait and doubles, up to a cap", () => {
    expect([0, 1, 2, 3, 4, 10].map(retryDelay)).toEqual([800, 1600, 3200, 6400, 8000, 8000]);
  });
});

describe("requeue", () => {
  it("sends a failed text again from the back of the queue, stamped where the thread is now", () => {
    const queue = [{ ...pending("a", "failed"), afterSeq: 3 }, { ...pending("b", "failed"), afterSeq: 5 }];
    expect(requeue(queue, "a", 9)).toEqual([
      { ...pending("b", "failed"), afterSeq: 5 },
      { ...pending("a", "queued"), afterSeq: 9 },
    ]);
  });

  it("leaves the queue alone for a text it does not hold", () => {
    const queue = [pending("a", "failed")];
    expect(requeue(queue, "gone", 9)).toBe(queue);
  });
});
