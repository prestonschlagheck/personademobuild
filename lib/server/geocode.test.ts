import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { placeFrom, placeName } = await import("@/lib/server/geocode");

describe("placeFrom", () => {
  it("names a US town with its state code", () => {
    expect(placeFrom({ city: "Columbia", state: "South Carolina", "ISO3166-2-lvl4": "US-SC" })).toBe("Columbia, SC");
    expect(placeFrom({ town: "Culver City", "ISO3166-2-lvl4": "US-CA" })).toBe("Culver City, CA");
  });

  it("names the region in full outside the US, and nothing without a town", () => {
    expect(placeFrom({ city: "Toronto", state: "Ontario", "ISO3166-2-lvl4": "CA-ON" })).toBe("Toronto, Ontario");
    expect(placeFrom({ state: "Nevada" })).toBeNull();
    expect(placeFrom(undefined)).toBeNull();
  });
});

describe("placeName", () => {
  it("asks with only the rounded point and an identifying agent", async () => {
    const fetcher = vi.fn(async () => Response.json({ address: { city: "Los Angeles", "ISO3166-2-lvl4": "US-CA" } }));
    expect(await placeName(34.02, -118.29, fetcher)).toBe("Los Angeles, CA");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("lat=34.02&lon=-118.29");
    expect(new Headers(init.headers).get("User-Agent")).toContain("persona-demo");
  });

  it("keeps the share going without a name when the geocoder fails", async () => {
    expect(await placeName(1, 2, async () => new Response("", { status: 503 }))).toBeNull();
    expect(
      await placeName(1, 2, async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });
});
