/**
 * Drives polling rounds while a popup is actually watching.
 *
 * An MV3 service worker can be suspended at any time, so a `setInterval` held
 * in worker memory is not a scheduling mechanism — it is a thing that silently
 * stops. Instead the loop is tied to a live controlling context: the popup
 * reports in on every snapshot request, and the loop runs only while those
 * reports are recent. When the popup closes, the loop winds down on its own
 * and the session stays in storage; readings then age and are shown as stale
 * rather than quietly presented as current.
 */

import type { Clock, Timers } from "../platform/browser.js";

/** How long after the last popup contact the loop keeps running. */
export const POPUP_IDLE_MS = 5_000;
/** Gap between rounds. Rounds never overlap; the poller enforces that too. */
export const ROUND_GAP_MS = 500;

export type RoundLoop = {
  /** Called whenever the popup talks to us. Starts the loop if needed. */
  noteContact(): void;
  isRunning(): boolean;
  stop(): void;
};

export function createRoundLoop(deps: {
  tick: () => Promise<unknown>;
  shouldPoll: () => boolean;
  clock: Clock;
  timers: Timers;
  popupIdleMs?: number;
  roundGapMs?: number;
}): RoundLoop {
  const popupIdleMs = deps.popupIdleMs ?? POPUP_IDLE_MS;
  const roundGapMs = deps.roundGapMs ?? ROUND_GAP_MS;

  let lastContact = 0;
  let running = false;
  let stopped = false;

  async function loop(): Promise<void> {
    running = true;
    try {
      for (;;) {
        if (stopped || !deps.shouldPoll()) break;
        if (deps.clock.now() - lastContact >= popupIdleMs) break;
        await deps.tick();
        if (stopped) break;
        await deps.timers.delay(roundGapMs);
      }
    } finally {
      running = false;
    }
  }

  return {
    noteContact(): void {
      lastContact = deps.clock.now();
      if (running || stopped) return;
      // A rejected loop must not take the worker down with it; the tick
      // function is expected to absorb its own failures into state.
      void loop().catch(() => {
        running = false;
      });
    },

    isRunning(): boolean {
      return running;
    },

    stop(): void {
      stopped = true;
    },
  };
}
