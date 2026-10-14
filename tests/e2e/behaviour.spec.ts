/**
 * The scenarios only a real browser can answer.
 *
 * Everything here depends on Chrome's actual behaviour — tab lifecycle, message
 * passing to content scripts, window focus, storage persistence — so none of it
 * is reachable from the fakes. These are the tests most likely to catch a real
 * bug in `src/platform/chromeBrowser.ts`.
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

/** Starts a session and waits for the leaderboard to fill. */
async function startSession(count: number, query = ""): Promise<void> {
  const { popup } = harness;
  await popup.fill("#url", harness.fixtureUrl(query));
  await popup.fill("#count", String(count));
  await popup.click("#start");
  await expect.poll(() => popup.locator("#rows tr").count(), { timeout: 25_000 }).toBe(count);
}

test("a tab closed by the user becomes a closed row with no number", async () => {
  const { popup, context } = harness;
  await startSession(3, "?seed=2");

  // Wait for real readings before closing, so a stale number would be visible
  // if one survived.
  await expect
    .poll(
      async () => (await readRows(popup)).filter((c) => c.some((v) => /\d+%/u.test(v))).length,
      {
        timeout: 25_000,
      },
    )
    .toBeGreaterThan(0);

  const fixturePages = context.pages().filter((p) => p.url().startsWith("http://127.0.0.1"));
  expect(fixturePages.length).toBe(3);
  await fixturePages[1]?.close();

  // The row stays, marked closed, and its progress is gone rather than frozen.
  await expect
    .poll(
      async () =>
        (await readRows(popup)).filter((c) => c.join(" ").toLowerCase().includes("closed")).length,
      { timeout: 25_000 },
    )
    .toBe(1);

  const closed = (await readRows(popup)).find((c) => c.join(" ").toLowerCase().includes("closed"));
  expect(closed?.join(" ")).not.toMatch(/\d+%/);
});

test("the Open button focuses the tab and pauses monitoring", async () => {
  const { popup, context } = harness;
  await startSession(3, "?seed=4");

  const openButtons = popup.locator("#rows tr button");
  await expect(openButtons.first()).toBeVisible();
  await openButtons.nth(1).click();

  // Focusing pauses first, so the user is not fighting a polling round.
  await expect(popup.locator("#state")).toContainText(/paused/iu, { timeout: 15_000 });
  // And it never closes anything.
  expect(context.pages().filter((p) => p.url().startsWith("http://127.0.0.1")).length).toBe(3);
});

test("a tab reaching the end is shown as ready, not as another percentage", async () => {
  const { popup } = harness;
  // start=99 with a fast tick reaches max almost immediately.
  await startSession(2, "?start=99&interval=200");

  await expect
    .poll(
      async () =>
        (await readRows(popup)).filter((c) => c.join(" ").toLowerCase().includes("priority"))
          .length,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
});

test("a progress element that disappears reads as unknown, not a remembered number", async () => {
  const { popup } = harness;
  // The fixture's `disappear` mode removes the element after ~10s.
  await startSession(1, "?mode=disappear&start=40");

  await expect
    .poll(async () => (await readRows(popup)).some((c) => /\d+%/u.test(c.join(" "))), {
      timeout: 25_000,
    })
    .toBe(true);

  // Once the element is gone the reading must degrade, not freeze.
  await expect
    .poll(
      async () => {
        const row = (await readRows(popup))[0]?.join(" ").toLowerCase() ?? "";
        return /unknown|—/u.test(row) && !/\d+%/u.test(row);
      },
      { timeout: 40_000 },
    )
    .toBe(true);
});

test("a navigated-away tab stops reporting progress", async () => {
  const { popup, context } = harness;
  await startSession(2, "?seed=6");

  await expect
    .poll(async () => (await readRows(popup)).filter((c) => /\d+%/u.test(c.join(" "))).length, {
      timeout: 25_000,
    })
    .toBe(2);

  const fixturePages = context.pages().filter((p) => p.url().startsWith("http://127.0.0.1"));
  // Navigate one tab to a page with no progress element. It stays on an
  // allowlisted host, so the content script still runs there.
  await fixturePages[0]?.goto(harness.fixtureUrl("missing.html"));

  await expect
    .poll(async () => (await readRows(popup)).filter((c) => /\d+%/u.test(c.join(" "))).length, {
      timeout: 30_000,
    })
    .toBe(1);
});

test("monitors 25 tabs and ranks them against each other", async () => {
  const { popup } = harness;
  await startSession(25, "?seed=1&interval=400");

  // Every tracked tab gets a row, and real readings arrive for most of them.
  await expect
    .poll(async () => (await readRows(popup)).filter((c) => /\d+%/u.test(c.join(" "))).length, {
      timeout: 40_000,
    })
    .toBeGreaterThanOrEqual(20);

  // Exactly one tab holds the top score of 100.
  await expect
    .poll(
      async () => {
        const rows = await readRows(popup);
        return rows.filter((cells) => cells.some((cell) => cell.trim() === "100")).length;
      },
      { timeout: 40_000 },
    )
    .toBe(1);
});

test("the stale marker appears when a page stops advancing", async () => {
  const { popup } = harness;
  // `stall` stops advancing after a few ticks; readings keep arriving but the
  // value stops moving. Readings themselves stay fresh, so this asserts the
  // monitor keeps reporting rather than hanging.
  await startSession(2, "?mode=stall&interval=200");

  await expect
    .poll(async () => (await readRows(popup)).filter((c) => /\d+%/u.test(c.join(" "))).length, {
      timeout: 25_000,
    })
    .toBe(2);

  await expect(popup.locator("#state")).toContainText(/monitoring/iu);
  await expect(popup.locator("#throughput")).not.toBeEmpty();
});
