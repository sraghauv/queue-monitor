/**
 * Does it actually work?
 *
 * This is the first test in the repo that can answer that. It loads the real
 * built extension into a real Chrome, points it at the real fixture served over
 * loopback, and drives the real popup.
 */

import { expect, test } from "@playwright/test";
import { launch, readRows, type Harness } from "./fixtures.js";

let harness: Harness;

test.beforeEach(async () => {
  harness = await launch();
});

test.afterEach(async () => {
  await harness?.close();
});

test("the background service worker starts", async () => {
  expect(harness.extensionId).toMatch(/^[a-p]{32}$/);
  expect(harness.worker.url()).toContain("background.js");
});

test("the popup renders its controls and its disclaimer", async () => {
  const { popup } = harness;
  await expect(popup.locator("#url")).toBeVisible();
  await expect(popup.locator("#count")).toBeVisible();
  await expect(popup.locator("#start")).toBeEnabled();

  // The honesty claims are permanent markup, not injected at render time.
  const body = (await popup.locator("body").textContent()) ?? "";
  expect(body.toLowerCase()).toContain("does not guarantee");
});

test("opens tabs, reads real progress from the page, and ranks it", async () => {
  const { popup, context } = harness;

  await popup.fill("#url", harness.fixtureUrl("?seed=3"));
  await popup.fill("#count", "3");
  await popup.click("#start");

  // Three real tabs, plus the popup page itself.
  await expect.poll(() => context.pages().length, { timeout: 20_000 }).toBeGreaterThanOrEqual(4);

  await expect.poll(() => popup.locator("#rows tr").count(), { timeout: 20_000 }).toBe(3);

  // A real reading from the real page: a percentage, not a dash.
  await expect
    .poll(
      async () => {
        const rows = await readRows(popup);
        return rows.filter((cells) => cells.some((cell) => /\d+%/u.test(cell))).length;
      },
      { timeout: 25_000 },
    )
    .toBeGreaterThan(0);

  await expect(popup.locator("#state")).toContainText(/monitoring/iu);
});

test("pause and resume flip monitoring without closing tabs", async () => {
  const { popup, context } = harness;

  await popup.fill("#url", harness.fixtureUrl());
  await popup.fill("#count", "2");
  await popup.click("#start");
  await expect.poll(() => popup.locator("#rows tr").count(), { timeout: 20_000 }).toBe(2);

  const tabsWhileMonitoring = context.pages().length;

  await popup.click("#pause");
  await expect(popup.locator("#state")).toContainText(/paused/iu);
  expect(context.pages().length).toBe(tabsWhileMonitoring);

  await popup.click("#resume");
  await expect(popup.locator("#state")).toContainText(/monitoring/iu);
  expect(context.pages().length).toBe(tabsWhileMonitoring);
});

test("stop leaves every tab open", async () => {
  const { popup, context } = harness;

  await popup.fill("#url", harness.fixtureUrl());
  await popup.fill("#count", "3");
  await popup.click("#start");
  await expect.poll(() => popup.locator("#rows tr").count(), { timeout: 20_000 }).toBe(3);

  const before = context.pages().length;
  await popup.click("#stop");

  await expect(popup.locator("#state")).toContainText(/stopped/iu);
  // The whole point of Stop: the user keeps their place in the queue.
  expect(context.pages().length).toBe(before);
});

test("refuses a host that is not on the allowlist", async () => {
  const { popup, context } = harness;
  const before = context.pages().length;

  await popup.fill("#url", "https://tickets.evil.example/queue");
  await popup.fill("#count", "5");
  await popup.click("#start");

  await expect(popup.locator("#error")).not.toBeEmpty();
  expect(context.pages().length).toBe(before);
  await expect(popup.locator("#rows tr")).toHaveCount(0);
});

test("session survives the popup being closed and reopened", async () => {
  const { popup, context, extensionId } = harness;

  await popup.fill("#url", harness.fixtureUrl("?seed=5"));
  await popup.fill("#count", "3");
  await popup.click("#start");
  await expect.poll(() => popup.locator("#rows tr").count(), { timeout: 20_000 }).toBe(3);

  await popup.close();

  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/popup.html`);

  // Recovered from storage, with the same three tabs and no new ones.
  await expect.poll(() => reopened.locator("#rows tr").count(), { timeout: 20_000 }).toBe(3);
  await expect(reopened.locator("#state")).toContainText(/monitoring|paused/iu);
});
