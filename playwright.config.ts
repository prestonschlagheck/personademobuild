import { defineConfig } from "@playwright/test";

// Browser smoke tests on the local stand-ins, so a run costs nothing and needs no keys. They build and serve
// their own copy on a spare port, apart from the dev server. A blank value beats .env.local, since Next never
// overrides a variable that is already set; a blank HARNESS keeps the harness routes a 404.
const PORT = 3100;
const BLANKED = ["OPENAI_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "NEXT_PUBLIC_POSTHOG_KEY", "HARNESS"];
// LIVE=1 runs only the real-audio call (live-voice.spec.ts) against the dev server already running on live keys
// (BASE_URL), and builds nothing. It spends OpenAI credits, so without LIVE=1 no project ever picks it up.
const LIVE = process.env.LIVE === "1";
const LIVE_SPEC = /live-voice\.spec\.ts$/;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    trace: "retain-on-failure",
    // The call asks for the mic: grant it without a prompt and feed it a fake device.
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  },
  projects: LIVE
    ? [{ name: "live-voice", testMatch: LIVE_SPEC, use: { baseURL: process.env.BASE_URL ?? "http://localhost:3000", viewport: { width: 1440, height: 900 } } }]
    : [
        { name: "desktop", testIgnore: LIVE_SPEC, use: { viewport: { width: 1440, height: 900 } } },
        { name: "mobile", testIgnore: LIVE_SPEC, use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
      ],
  webServer: LIVE
    ? undefined
    : {
        command: `npx next build && npx next start -p ${PORT}`,
        url: `http://localhost:${PORT}`,
        timeout: 300_000,
        // Never reuse whatever holds the port: it could be running on live keys.
        reuseExistingServer: false,
        env: { ...Object.fromEntries(BLANKED.map((name) => [name, ""])) },
      },
});
