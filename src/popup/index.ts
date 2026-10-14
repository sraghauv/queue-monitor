/**
 * Thin popup entry point. This is the least testable code in the repo
 * (AGENTS.md "Architecture") — it only wires `chrome.runtime` messaging to
 * the pure `render.ts`/`format.ts` modules. No ranking, staleness, or
 * formatting logic lives here.
 */

import { describeError } from "../domain/errors.js";
import type { CommandResponse, PopupCommand } from "../domain/messages.js";
import type { Snapshot } from "../domain/types.js";
import { bindHandlers, render, resolveElements } from "./render.js";

const POLL_INTERVAL_MS = 1000;

function emptySnapshot(now: number): Snapshot {
  return {
    session: null,
    readings: [],
    ranked: [],
    ready: [],
    metrics: {
      readsPerSecond: null,
      meanLatencyMs: null,
      p95LatencyMs: null,
      staleFraction: null,
      roundDurationMs: null,
      lastRoundAt: null,
      roundsCompleted: 0,
    },
    takenAt: now,
    lastError: null,
  };
}

function sendCommand(command: PopupCommand): Promise<CommandResponse> {
  return chrome.runtime.sendMessage(command) as Promise<CommandResponse>;
}

function main(): void {
  const elements = resolveElements(document);
  let latest: Snapshot = emptySnapshot(Date.now());

  function applyResponse(response: CommandResponse): void {
    latest = response.ok
      ? response.snapshot
      : { ...response.snapshot, lastError: describeError(response.error) };
    render(elements, latest, Date.now());
  }

  async function refresh(): Promise<void> {
    const response = await sendCommand({ type: "GET_SNAPSHOT" });
    applyResponse(response);
  }

  bindHandlers(elements, {
    onStart(url, count) {
      // Client-side validation is a fast-feedback convenience only: the
      // background is the actual security boundary and revalidates `url`
      // and `count` against the allowlist before acting on them.
      if (url.trim().length === 0 || !Number.isFinite(count)) {
        render(elements, { ...latest, lastError: "Enter a URL and a tab count." }, Date.now());
        return;
      }
      void sendCommand({ type: "START", url, count }).then(applyResponse);
    },
    onPause() {
      void sendCommand({ type: "PAUSE" }).then(applyResponse);
    },
    onResume() {
      void sendCommand({ type: "RESUME" }).then(applyResponse);
    },
    onStop() {
      // Stop never closes tabs (AGENTS.md) — it only halts polling.
      void sendCommand({ type: "STOP" }).then(applyResponse);
    },
    onFocusTab(tabId) {
      // Per the operating guide: focusing a tab pauses monitoring first,
      // then activates the tab, so the user lands on a tab whose contents
      // won't shift under them mid-read.
      void sendCommand({ type: "PAUSE" })
        .then(applyResponse)
        .then(() => sendCommand({ type: "FOCUS_TAB", tabId }))
        .then(applyResponse);
    },
  });

  // Polling keeps the background round loop alive for as long as this
  // popup document stays open; the interval itself is also what drives a
  // reasonably fresh view, hence the comment, not just the poll.
  const intervalId = setInterval(() => {
    void refresh();
  }, POLL_INTERVAL_MS);

  const stopPolling = () => clearInterval(intervalId);
  window.addEventListener("unload", stopPolling);
  window.addEventListener("pagehide", stopPolling);

  render(elements, latest, Date.now());
  void refresh();
}

main();
