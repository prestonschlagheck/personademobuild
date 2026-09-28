import { expect, test, type Page } from "@playwright/test";

// The thread under the inputs a stress test throws at it: a huge paste, a refused send, no chips after the call
// offer, the phone's own Logs and Start over, and the desktop keyboard staying out of the way.

const phone = (page: Page) => page.getByRole("region", { name: "Phone" });

// Sends the prefilled first text and waits for the opening, so the thread has something to answer from.
async function open(page: Page) {
  await page.goto("/");
  const screen = phone(page);
  const composer = screen.getByRole("textbox", { name: "Message" });
  const thread = screen.getByRole("log");
  await expect(composer).toHaveValue("Hey, what's a persona?");
  await composer.press("Enter");
  await expect(thread.getByText("What do you want to call me?")).toBeVisible();
  return { screen, composer, thread };
}

// Each bubble opens with its sender for screen readers: "You: " for the person's own, blue ones.
const userBubbles = (page: Page) => phone(page).getByRole("log").locator("[data-gradient]");
const agentBubbles = (page: Page) => phone(page).getByRole("log").locator("[data-bubble-key]:not([data-gradient])");

test("a 5,000 character paste goes out cut to the limit, and gets an answer", async ({ page }) => {
  const { composer, thread } = await open(page);
  const before = await agentBubbles(page).count();

  await expect(composer).toHaveAttribute("maxlength", "2000");
  await composer.focus();
  await page.keyboard.insertText("hello persona. ".repeat(334));
  await composer.press("Enter");

  const sent = userBubbles(page).last();
  await expect(sent).toContainText("hello persona.");
  expect((await sent.textContent())?.replace(/^You: /, "").length).toBe(2000);
  await expect.poll(() => agentBubbles(page).count()).toBeGreaterThan(before);
  await expect(thread.getByText("Not Delivered")).toHaveCount(0);
});

test("a rate-limited send waits and goes through on its own", async ({ page }) => {
  let refused = 0;
  await page.route("**/api/turn", async (route) => {
    if (refused++ > 0) return route.continue();
    await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "rate_limited" }) });
  });
  const { thread } = await open(page);
  expect(refused).toBeGreaterThan(1);
  await expect(thread.getByText("Not Delivered")).toHaveCount(0);
  await expect(userBubbles(page)).toHaveCount(1);
});

test("a refused send stays where it was typed, and later replies land below it in view", async ({ page }) => {
  const { composer, thread } = await open(page);
  let calls = 0;
  await page.route("**/api/turn", async (route) => {
    calls++;
    if (calls > 1) return route.continue();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_body" }) });
  });

  await composer.fill("jarvis");
  await composer.press("Enter");
  const retry = thread.getByRole("button", { name: "Not delivered. Try again" });
  await expect(retry).toBeVisible();
  await expect(thread.getByText("Not Delivered")).toBeVisible();
  // A 400 is final: no retry on its own.
  await page.waitForTimeout(2_000);
  expect(calls).toBe(1);

  await composer.fill("friday");
  await composer.press("Enter");
  const card = thread.getByRole("button", { name: "Contact card for Friday" });
  await expect(card).toBeVisible();
  await expect(retry).toBeVisible();

  // A tapback badge can follow the words, so each bubble is found by how it starts.
  const texts = await userBubbles(page).allTextContents();
  const failedAt = texts.findIndex((text) => text.startsWith("You: jarvis"));
  expect(failedAt).toBeGreaterThanOrEqual(0);
  expect(failedAt).toBeLessThan(texts.findIndex((text) => text.startsWith("You: friday")));
  const [failedBox, cardBox] = await Promise.all([retry.boundingBox(), card.boundingBox()]);
  expect(failedBox && cardBox && failedBox.y < cardBox.y).toBe(true);
  // The newest bubble is the agent's, at the bottom and on screen, not hidden under the failed one.
  const newest = thread.locator("[data-bubble-key]").last();
  await expect(newest).toBeInViewport();
  expect(await newest.getAttribute("data-gradient")).toBeNull();
});

test("the call offer shows no quick-reply chips", async ({ page }) => {
  const { composer, thread } = await open(page);
  await composer.fill("jarvis");
  await composer.press("Enter");
  await expect(thread.getByRole("button", { name: "Contact card for Jarvis" })).toBeVisible();
  for (const label of ["call me", "not now", "later"]) {
    await expect(thread.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  }
});

test("on a phone, the contact sheet holds Logs and a two-tap Start over", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone layout only");
  const { screen, thread } = await open(page);
  const details = () => screen.getByRole("button", { name: /contact details/ });

  await details().click();
  let sheet = screen.getByRole("dialog", { name: /details$/ });
  await expect(sheet.getByRole("button", { name: "Logs" })).toBeVisible();
  const startOver = sheet.getByRole("button", { name: "Start over" });
  await startOver.click();
  const confirm = sheet.getByRole("button", { name: "Confirm: erase session" });
  await expect(confirm).toBeVisible();
  // One tap only arms it: nothing is erased yet.
  await expect(thread.getByText("What do you want to call me?")).toBeVisible();
  await confirm.click();

  await expect(sheet).toHaveCount(0);
  await expect(thread.getByText("What do you want to call me?")).toHaveCount(0);
  await expect(thread.getByText("Hey! I'm your new personal assistant")).toHaveCount(0);

  await details().click();
  sheet = screen.getByRole("dialog", { name: /details$/ });
  await sheet.getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("dialog", { name: "Logs" })).toBeVisible();
});

test("the desktop keyboard rests on load and after a send, and comes up when typing", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop keyboard only");
  await page.goto("/");
  const screen = phone(page);
  const composer = screen.getByRole("textbox", { name: "Message" });
  const keyboard = screen.locator("[data-ph-block]");

  await expect(composer).toHaveValue("Hey, what's a persona?");
  await expect(composer).toBeFocused();
  await expect(keyboard).toBeHidden();

  await page.keyboard.type("!");
  await expect(keyboard).toBeVisible();
  await composer.press("Enter");
  await expect(keyboard).toBeHidden();
  await expect(composer).toBeFocused();

  // The opening lands in view, not under the keyboard.
  await expect(screen.getByRole("log").getByText("What do you want to call me?")).toBeInViewport();
  await page.keyboard.type("j");
  await expect(keyboard).toBeVisible();
});
