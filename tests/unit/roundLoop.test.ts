/**
 * Round-loop tests.
 *
 * The loop's whole job is to stop on its own. An MV3 worker can be suspended
 * mid-loop, so the loop must never be the only thing keeping a session alive,
 * and it must wind down once the popup stops reporting in — otherwise it would
 * go on polling tabs with nobody watching the results.
 */

import { describe, expect, it } from "vitest";
import { createRoundLoop, POPUP_IDLE_MS } from "../../src/background/roundLoop.js";
import { FakeClock, FakeTimers } from "../support/fakePlatform.js";

function harness(options: { shouldPoll?: () => boolean; onTick?: () => void } = {}) {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  let ticks = 0;
  const loop = createRoundLoop({
    tick: async () => {
      ticks += 1;
      options.onTick?.();
      // Each round costs a little time, so the idle deadline can be reached.
      clock.advance(100);
    },
    shouldPoll: options.shouldPoll ?? (() => true),
    clock,
    timers,
    roundGapMs: 0,
  });
  return { loop, clock, count: () => ticks };
}

describe("round loop", () => {
  it("does not run until the popup reports in", async () => {
    const { loop, count } = harness();
    await Promise.resolve();
    expect(count()).toBe(0);
    expect(loop.isRunning()).toBe(false);
  });

  it("runs rounds after contact and stops once the popup goes quiet", async () => {
    const { loop, count } = harness();
    loop.noteContact();

    // The loop advances the clock 100ms per round, so it reaches the idle
    // deadline on its own without any real waiting.
    for (let i = 0; i < 200 && loop.isRunning(); i += 1) await Promise.resolve();

    expect(count()).toBeGreaterThan(0);
    expect(count()).toBeLessThanOrEqual(POPUP_IDLE_MS / 100 + 1);
    expect(loop.isRunning()).toBe(false);
  });

  it("keeps running while the popup keeps reporting in", async () => {
    let ticks = 0;
    const { loop, count } = harness({
      onTick: () => {
        ticks += 1;
        // The popup asking for a snapshot each round is the heartbeat.
        if (ticks < 120) loop.noteContact();
      },
    });
    loop.noteContact();
    // Each round needs several microtask turns, so pump generously and assert
    // the loop wound down on its own rather than capping the iterations.
    for (let i = 0; i < 5000 && loop.isRunning(); i += 1) await Promise.resolve();

    expect(count()).toBeGreaterThan(POPUP_IDLE_MS / 100);
    expect(loop.isRunning()).toBe(false);
  });

  it("does not start when the session is not monitoring", async () => {
    const { loop, count } = harness({ shouldPoll: () => false });
    loop.noteContact();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(count()).toBe(0);
    expect(loop.isRunning()).toBe(false);
  });

  it("never starts a second concurrent loop", async () => {
    let concurrent = 0;
    let peak = 0;
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const loop = createRoundLoop({
      tick: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await Promise.resolve();
        clock.advance(100);
        concurrent -= 1;
      },
      shouldPoll: () => true,
      clock,
      timers,
      roundGapMs: 0,
    });

    loop.noteContact();
    loop.noteContact();
    loop.noteContact();
    for (let i = 0; i < 200 && loop.isRunning(); i += 1) await Promise.resolve();

    expect(peak).toBe(1);
  });

  it("stops permanently once stopped", async () => {
    const { loop, count } = harness();
    loop.stop();
    loop.noteContact();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(count()).toBe(0);
    expect(loop.isRunning()).toBe(false);
  });
});
