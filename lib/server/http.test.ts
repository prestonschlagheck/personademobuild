import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

const { addressKey, parseBody, MAX_BODY_BYTES } = await import("@/lib/server/http");

describe("addressKey", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("counts every IPv6 address in one /64 as the same key", () => {
    const a = addressKey("2001:db8:85a3:12::1");
    expect(a).toBe("2001:db8:85a3:12::/64");
    expect(addressKey("2001:0db8:85a3:0012:ffff:1:2:3")).toBe(a);
    expect(addressKey("2001:db8:85a3:13::1")).not.toBe(a);
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
  });
});

describe("parseBody", () => {
  const schema = z.object({ text: z.string() });
  const post = (body: string, headers?: Record<string, string>) => new Request("http://x.test", { method: "POST", body, headers });

  it("parses a small valid body", async () => {
    await expect(parseBody(post(JSON.stringify({ text: "hi" })), schema)).resolves.toEqual({ text: "hi" });
  });

  it("refuses invalid json", async () => {
    await expect(parseBody(post("{oops"), schema)).rejects.toMatchObject({ status: 400, error: "invalid_json" });
  });

  it("refuses a body that fails the schema", async () => {
    await expect(parseBody(post(JSON.stringify({ text: 5 })), schema)).rejects.toMatchObject({ status: 400, error: "invalid_body" });
  });

  it("refuses a declared content-length over the cap before reading the body", async () => {
    const req = post(JSON.stringify({ text: "hi" }), { "content-length": String(MAX_BODY_BYTES + 1) });
    await expect(parseBody(req, schema)).rejects.toMatchObject({ status: 413, error: "body_too_large" });
  });

  it("refuses an oversized body even when content-length is missing or understates it", async () => {
    const big = JSON.stringify({ text: "a".repeat(MAX_BODY_BYTES) });
    await expect(parseBody(post(big), schema)).rejects.toMatchObject({ status: 413, error: "body_too_large" });
  });
});
