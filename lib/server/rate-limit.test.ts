import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The address comes from request headers, which only exist inside a route.
let ip = "10.0.0.1";
vi.mock("@/lib/server/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/http")>()),
  clientIp: async () => ip,
}));

const { rateLimit, rateLimitRequest } = await import("@/lib/server/rate-limit");

const limited = expect.objectContaining({ status: 429, error: "rate_limited" });

describe("rateLimit", () => {
  it("allows 20 turns a minute per session, then answers 429", async () => {
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) await rateLimit("turn", "a", t + i);
    await expect(rateLimit("turn", "a", t + 20)).rejects.toThrow(limited);
    await expect(rateLimit("turn", "b", t + 20)).resolves.toBeUndefined();
  });

  it("slides the window", async () => {
    const t = 2_000_000;
    for (let i = 0; i < 30; i++) await rateLimit("callStart", "a", t);
    await expect(rateLimit("callStart", "a", t + 60_000)).rejects.toThrow();
    await expect(rateLimit("callStart", "a", t + 10 * 60_000)).resolves.toBeUndefined();
  });

  it("prunes each key by its own window, so a flood of turns never resets call starts", async () => {
    const t = 3_000_000;
    for (let i = 0; i < 30; i++) await rateLimit("callStart", "keep", t);
    for (let i = 0; i <= 10_000; i++) await rateLimit("turn", `flood${i}`, t + 120_000);
    await expect(rateLimit("callStart", "keep", t + 120_000)).rejects.toThrow();
  });
});

describe("rateLimitRequest", () => {
  it("caps a session, and an address across the sessions it starts", async () => {
    const t = 4_000_000;
    ip = "10.0.0.2";
    for (let i = 0; i < 120; i++) await rateLimitRequest("write", "s1", t);
    await expect(rateLimitRequest("write", "s1", t)).rejects.toThrow(limited);
    for (let i = 0; i < 240; i++) await rateLimitRequest("write", `s${2 + (i % 2)}`, t);
    await expect(rateLimitRequest("write", "s4", t)).rejects.toThrow(limited);
    ip = "10.0.0.3";
    await expect(rateLimitRequest("write", "s4", t)).resolves.toBeUndefined();
  });

  it("counts a refused request against neither key", async () => {
    const t = 5_000_000;
    ip = "10.0.0.4";
    for (let i = 0; i < 30; i++) await rateLimitRequest("callStart", "busy", t);
    // Refusals for the full session leave its address untouched, so another session there still gets its tries.
    for (let i = 0; i < 20; i++) await expect(rateLimitRequest("callStart", "busy", t)).rejects.toThrow(limited);
    for (let i = 0; i < 30; i++) await rateLimitRequest("callStart", "other", t);
    for (let i = 0; i < 30; i++) await rateLimitRequest("callStart", "third", t);
    await expect(rateLimitRequest("callStart", "fourth", t)).rejects.toThrow(limited);
  });
});

describe("buckets", () => {
  it("gives heartbeats their own bucket, so a flood of tapbacks and transcripts never starves a call", async () => {
    const t = 6_000_000;
    ip = "10.0.0.5";
    for (let i = 0; i < 120; i++) await rateLimitRequest("write", "spammy", t);
    await expect(rateLimitRequest("write", "spammy", t)).rejects.toThrow(limited);
    await expect(rateLimitRequest("heartbeat", "spammy", t)).resolves.toBeUndefined();
    // A ping every 5 s, retries included, stays far under its own limit, which still has one.
    for (let i = 1; i < 60; i++) await rateLimitRequest("heartbeat", "spammy", t);
    await expect(rateLimitRequest("heartbeat", "spammy", t)).rejects.toThrow(limited);
    await expect(rateLimitRequest("heartbeat", "spammy", t + 60_000)).resolves.toBeUndefined();
  });

  it("limits accepts apart from starts, per session and per address", async () => {
    const t = 7_000_000;
    ip = "10.0.0.6";
    for (let i = 0; i < 30; i++) await rateLimitRequest("callStart", "caller", t);
    await expect(rateLimitRequest("callStart", "caller", t)).rejects.toThrow(limited);
    // Rings the agent or a booked callback started never pass through callStart, so accepts count on their own.
    for (let i = 0; i < 40; i++) await rateLimitRequest("callAccept", "caller", t);
    await expect(rateLimitRequest("callAccept", "caller", t)).rejects.toThrow(limited);
    for (let i = 0; i < 80; i++) await rateLimitRequest("callAccept", `other${i % 2}`, t);
    await expect(rateLimitRequest("callAccept", "fresh", t)).rejects.toThrow(limited);
    await expect(rateLimitRequest("callAccept", "caller", t + 10 * 60_000)).resolves.toBeUndefined();
  });
});
