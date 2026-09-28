import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";

// A real call with real audio, against the dev server on live keys: macOS `say` speaks a name and a need into
// Chromium's fake microphone, the Realtime agent hears them over WebRTC, and the shared session saves both. LIVE=1
// only (playwright.config.ts), since it spends OpenAI credits and needs `say`: `npm run test:live-voice`.

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
// A pause first, so the hello is said before the caller speaks. Chromium loops the file, so the line comes again.
const CALLER = "[[slnc 6000]] hi, my name is sam. i want help paying my bills.";
// The model gets up to 3 s to write the text itself (lib/server/follow-up.ts), then one save.
const HANGUP_TEXT_MS = 4_000;

type Event = { seq: number; at: string; channel: string; role: string; content: string; meta?: { kind?: string } };
type Snapshot = {
  session: { agentName: { value: string } | null; userName: { value: string } | null; helpNeed: { category: string } | null; call: { status: string } };
  events: Event[];
};

test.skip(process.env.LIVE !== "1", "a real call on live keys: LIVE=1 only");

const phone = (page: Page) => page.getByRole("region", { name: "Phone" });

test("a spoken name and need are heard on a real call, and a hangup gets its text within 4 s", async () => {
  test.setTimeout(180_000);
  const wav = join(mkdtempSync(join(tmpdir(), "live-voice-")), "caller.wav");
  execFileSync("say", ["-o", wav, "--data-format=LEI16@48000", CALLER]);
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
  });
  try {
    const context = await browser.newContext({ baseURL: BASE_URL, permissions: ["microphone"], viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    // The page's own cookie, so this reads the session the page is on.
    const snapshot = async () => (await (await page.request.get("/api/session")).json()) as Snapshot;

    await page.goto("/");
    const screen = phone(page);
    const composer = screen.getByRole("textbox", { name: "Message" });
    await expect(composer).toHaveValue("Hey, what's a persona?");
    await composer.press("Enter");
    await expect.poll(async () => (await snapshot()).events.some((e) => e.role === "agent" && e.channel === "text"), { timeout: 20_000 }).toBe(true);

    await composer.fill("call yourself jarvis");
    await composer.press("Enter");
    await expect.poll(async () => (await snapshot()).session.agentName?.value, { timeout: 20_000 }).toBe("Jarvis");

    await composer.fill("call me");
    await composer.press("Enter");
    await screen.getByRole("dialog", { name: "Incoming call" }).getByRole("button", { name: "Accept" }).click({ timeout: 30_000 });
    await expect.poll(async () => (await snapshot()).session.call.status, { timeout: 20_000 }).toBe("active");

    await expect.poll(async () => (await snapshot()).session.userName?.value.toLowerCase(), { timeout: 90_000, intervals: [1_000] }).toBe("sam");
    await expect.poll(async () => (await snapshot()).session.helpNeed?.category ?? null, { timeout: 90_000, intervals: [1_000] }).not.toBeNull();

    // The caller's line loops over the agent the whole call, yet the hello is said once and never again.
    const spoken = (await snapshot()).events.filter((e) => e.channel === "voice" && e.role === "agent").map((e) => e.content);
    await test.info().attach("agent lines", { body: spoken.join("\n") });
    expect(spoken.filter((line) => /^hey, it's /i.test(line))).toHaveLength(1);

    await screen.getByRole("dialog", { name: "Call" }).getByRole("button", { name: "End call" }).click();
    const followUp = async () => {
      const { events } = await snapshot();
      const ended = events.findLast((e) => e.meta?.kind === "call_ended");
      return ended ? events.find((e) => e.seq > ended.seq && e.role === "agent" && e.channel === "text" && ["recovery", "recap"].includes(e.meta?.kind ?? "")) : undefined;
    };
    await expect.poll(async () => Boolean(await followUp()), { timeout: HANGUP_TEXT_MS, intervals: [250] }).toBe(true);
    // Timed between the server's own timestamps too, so a slow poll can't hide a slow text.
    const { events } = await snapshot();
    const ended = events.findLast((e) => e.meta?.kind === "call_ended");
    const text = await followUp();
    expect(Date.parse(text?.at ?? "") - Date.parse(ended?.at ?? "")).toBeLessThanOrEqual(HANGUP_TEXT_MS);
  } finally {
    await browser.close();
  }
});
