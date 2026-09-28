import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getModes, harnessEnabled, voiceTurnDetection } = await import("@/lib/server/config");

const KEYS = ["OPENAI_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "STORE"] as const;

function withKeys(...names: (typeof KEYS)[number][]) {
  for (const name of KEYS) vi.stubEnv(name, names.includes(name) ? "set" : "");
}

afterEach(() => vi.unstubAllEnvs());

describe("getModes", () => {
  it("runs every stand-in off production", () => {
    withKeys();
    vi.stubEnv("APP_ENV", "preview");
    expect(getModes()).toEqual({ text: "mock", voice: "mock", gmail: "mock", store: "memory" });
  });

  it("never runs the mock Gmail or the memory store in production", () => {
    vi.stubEnv("APP_ENV", "production");
    withKeys("OPENAI_API_KEY");
    vi.stubEnv("STORE", "durable");
    expect(() => getModes()).toThrow(/google/i);
    withKeys("OPENAI_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
    expect(() => getModes()).toThrow(/durable object/i);
  });

  it("never runs the mock text or the browser voice in production, whatever flag is set", () => {
    vi.stubEnv("APP_ENV", "production");
    withKeys("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
    vi.stubEnv("STORE", "durable");
    vi.stubEnv("ALLOW_MOCK", "1");
    expect(() => getModes()).toThrow(/OPENAI_API_KEY/);
    withKeys("OPENAI_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "STORE");
    vi.stubEnv("STORE", "durable");
    expect(getModes()).toEqual({ text: "live", voice: "live", gmail: "live", store: "durable" });
  });
});

describe("harnessEnabled", () => {
  it("needs HARNESS=1 under next dev, off any production deploy", () => {
    vi.stubEnv("HARNESS", "1");
    vi.stubEnv("NODE_ENV", "development");
    expect(harnessEnabled()).toBe(true);
    vi.stubEnv("APP_ENV", "production");
    expect(harnessEnabled()).toBe(false);
    vi.stubEnv("APP_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(harnessEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("HARNESS", "");
    expect(harnessEnabled()).toBe(false);
  });
});

describe("voiceTurnDetection", () => {
  it("answers on the silence timer by default, and judges from the words only on request", () => {
    vi.stubEnv("VOICE_TURN_DETECTION", "");
    expect(voiceTurnDetection()).toBe("server");
    vi.stubEnv("VOICE_TURN_DETECTION", "semantic");
    expect(voiceTurnDetection()).toBe("semantic");
    vi.stubEnv("VOICE_TURN_DETECTION", "server");
    expect(voiceTurnDetection()).toBe("server");
    vi.stubEnv("VOICE_TURN_DETECTION", "nonsense");
    expect(voiceTurnDetection()).toBe("server");
  });
});
