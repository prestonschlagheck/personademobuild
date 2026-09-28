import { expect, test, type Page } from "@playwright/test";

// The happy path on the local stand-ins: name the agent over text, take the call, hang up, reload.

const phone = (page: Page) => page.getByRole("region", { name: "Phone" });

test("text, call, hang up and reload stay one conversation", async ({ page, isMobile }) => {
  await page.goto("/");
  const screen = phone(page);
  const composer = screen.getByRole("textbox", { name: "Message" });
  const thread = screen.getByRole("log");

  await expect(composer).toHaveValue("Hey, what's a persona?");
  await composer.press("Enter");
  await expect(thread.getByText("Hey! I'm your new personal assistant")).toBeVisible();
  await expect(thread.getByText("What do you want to call me?")).toBeVisible();

  await composer.fill("jarvis");
  await composer.press("Enter");
  await expect(thread.getByRole("button", { name: "Contact card for Jarvis" })).toBeVisible();

  await composer.fill("call me");
  await composer.press("Enter");
  await screen.getByRole("dialog", { name: "Incoming call" }).getByRole("button", { name: "Accept" }).click();

  const call = screen.getByRole("dialog", { name: "Call" });
  const talk = call.getByRole("textbox", { name: "Type to talk" });
  await talk.fill("i'm preston");
  await talk.press("Enter");
  // The words show beside the phone, on a stage a phone does not have.
  if (!isMobile) await expect(page.getByRole("log", { name: "Call transcript" }).getByText(/nice to meet you, Preston/i)).toBeVisible();

  // Each agent bubble opens with the agent's name for screen readers, so the count shows the text the hangup sends.
  const agentBubbles = thread.getByText("Jarvis:", { exact: true });
  const before = await agentBubbles.count();
  await call.getByRole("button", { name: "End call" }).click();
  await expect.poll(() => agentBubbles.count(), { timeout: 3_000 }).toBeGreaterThan(before);
  // The hangup can send more than one bubble, so the count is taken once the thread has settled.
  let after = await agentBubbles.count();
  for (let settled = 0; settled < 3; ) {
    await page.waitForTimeout(500);
    const now = await agentBubbles.count();
    settled = now === after ? settled + 1 : 0;
    after = now;
  }

  await page.reload();
  await expect(thread.getByRole("button", { name: "Contact card for Jarvis" })).toBeVisible();
  await expect(agentBubbles).toHaveCount(after);
  await expect(composer).toHaveValue("");
});

test("a phone gets only the device, as large as the window allows, with no sideways scroll", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone layout only");
  await page.goto("/");
  await expect(phone(page).getByRole("textbox", { name: "Message" })).toBeVisible();
  const box = await phone(page).boundingBox();
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  // The device keeps its own shape, so it fills the window along one side and sits inside it along the other.
  expect(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height).toBe(true);
  expect(box && (box.width >= width * 0.85 || box.height >= height * 0.85)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
});
