/**
 * Service worker entry point. Wiring only.
 *
 * Everything this file does is connect the Chrome implementations to the
 * coordinator. It assumes nothing survived a previous worker instance: the
 * coordinator rehydrates from storage on first use, so a restart mid-session
 * recovers rather than starting over.
 */

import { createCoordinator } from "../app/coordinator.js";
import { createPoller } from "../app/poller.js";
import { createStore } from "../app/store.js";
import { parsePopupCommand, type CommandResponse } from "../domain/messages.js";
import { createChromePlatform } from "../platform/chromeBrowser.js";
import { createRoundLoop } from "./roundLoop.js";

const platform = createChromePlatform();

const coordinator = createCoordinator({
  store: createStore({ storage: platform.storage, tabs: platform.tabs, clock: platform.clock }),
  poller: createPoller({ tabs: platform.tabs, clock: platform.clock }),
  tabs: platform.tabs,
  clock: platform.clock,
  newSessionId: () => platform.ids.newSessionId(),
});

const loop = createRoundLoop({
  tick: () => coordinator.tick(),
  shouldPoll: () => coordinator.shouldPoll(),
  clock: platform.clock,
  timers: platform.timers,
});

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  // Every inbound message is parsed, never cast. This listener is reachable
  // from any extension context, so shape is not a credential.
  const parsed = parsePopupCommand(raw);
  if (!parsed.ok) {
    const response: CommandResponse = {
      ok: false,
      error: parsed.error,
      snapshot: coordinator.snapshot(),
    };
    sendResponse(response);
    return false;
  }

  // A snapshot request doubles as the popup's heartbeat: it is what keeps the
  // round loop alive, and what restarts it after a worker suspension.
  loop.noteContact();

  void coordinator
    .handle(parsed.value)
    .then((result) => {
      const response: CommandResponse = result.ok
        ? { ok: true, snapshot: result.value }
        : { ok: false, error: result.error, snapshot: coordinator.snapshot() };
      sendResponse(response);
    })
    .catch((cause: unknown) => {
      // A thrown value here is a bug, not an expected failure. Report it as
      // one rather than leaving the popup waiting on a dead channel.
      const detail = cause instanceof Error ? cause.message : "unknown failure";
      sendResponse({
        ok: false,
        error: { kind: "malformed-message", detail },
        snapshot: coordinator.snapshot(),
      } satisfies CommandResponse);
    });

  // Keeps the message channel open for the async reply above.
  return true;
});

// A tab the user closed is reconciled immediately; nothing here closes tabs.
platform.tabs.onRemoved((tabId) => {
  void coordinator.noteTabClosed(tabId).catch(() => {
    /* reconciliation retries on the next hydrate or command */
  });
});

chrome.runtime.onStartup.addListener(() => {
  void coordinator.hydrate().catch(() => {
    /* surfaced to the popup through the snapshot's lastError */
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void coordinator.hydrate().catch(() => {
    /* surfaced to the popup through the snapshot's lastError */
  });
});
