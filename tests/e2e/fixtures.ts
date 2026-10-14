/**
 * Harness for driving the real extension in a real Chrome.
 *
 * Loading an unpacked MV3 extension needs a persistent context with a real
 * profile directory, and the extension's id is only knowable at runtime — it is
 * read off the service-worker target rather than hardcoded.
 */

import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "../../dist");
const FIXTURE_DIR = resolve(import.meta.dirname, "../../mock-queue");

export type Harness = {
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
  popup: Page;
  fixtureUrl: (query?: string) => string;
  close: () => Promise<void>;
};

/** Serves the fixture on a fixed loopback port the allowlist accepts. */
async function startFixtureServer(port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const name = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    try {
      const body = await readFile(join(FIXTURE_DIR, name));
      res.writeHead(200, {
        "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  return server;
}

/**
 * Our background worker, as opposed to the ones Chrome's own component
 * extensions register — those appear first, so matching by index picks the
 * wrong extension.
 */
function isOurs(candidate: Worker): boolean {
  return candidate.url().endsWith("/background.js");
}

export async function launch(options: { port?: number } = {}): Promise<Harness> {
  const port = options.port ?? 8787;
  const server = await startFixtureServer(port);
  const profile = await mkdtemp(join(tmpdir(), "queue-monitor-e2e-"));

  const context = await chromium.launchPersistentContext(profile, {
    // Chromium (Chrome for Testing), never branded Chrome — see
    // playwright.config.ts for why.
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  // The background worker is the extension's identity; wait for it rather than
  // guessing an id. Match on background.js specifically: Chrome's own component
  // extensions register service workers too, and they register first.
  const worker =
    context.serviceWorkers().find(isOurs) ??
    (await context.waitForEvent("serviceworker", { predicate: isOurs }));
  const extensionId = new URL(worker.url()).host;

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  return {
    context,
    extensionId,
    worker,
    popup,
    fixtureUrl: (query = "") => `http://127.0.0.1:${port}/${query}`,
    close: async () => {
      await context.close();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(profile, { recursive: true, force: true });
    },
  };
}

/** Rows currently rendered in the leaderboard, as plain text per cell. */
export async function readRows(popup: Page): Promise<string[][]> {
  return popup.$$eval("#rows tr", (rows) =>
    rows.map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim() ?? ""),
    ),
  );
}
