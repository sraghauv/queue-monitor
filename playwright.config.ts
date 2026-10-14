import { defineConfig } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * These tests load the real built extension into the installed Google Chrome
 * and drive the real popup. They are the only tests in this repo that exercise
 * `src/platform/chromeBrowser.ts`, so they are also the only ones that can tell
 * us the extension actually works rather than that our fakes agree with each
 * other.
 *
 * Extensions need a persistent context and a real browser channel, so these do
 * not run under vitest and are not part of `npm run check`.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // A polling round plus Chrome startup is slower than a unit test; still
  // bounded so a hang fails rather than blocks.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // One worker: each test owns a browser profile and the mock server port.
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? [["list"], ["github"]] : [["list"]],
  use: {
    // Must be Chromium, not branded Chrome: Google Chrome refuses
    // --load-extension and --disable-extensions-except outright
    // ("not allowed in Google Chrome, ignoring"), so the extension silently
    // never loads. Playwright's bundled build is Chrome for Testing, which
    // honours both. Install it with `npx playwright install chromium`.
    channel: "chromium",
    trace: "retain-on-failure",
  },
});
