/**
 * Keeps the guide's 100-tab scaling claims honest in CI. Runs the real
 * poller against `FakeTabs`/`FakeClock` only -- no real timers, no real
 * sleeps -- so a 100-tab round costs microseconds, per AGENTS.md Testing.
 */

import { describe, expect, it } from "vitest";

import { createPoller } from "../../src/app/poller.js";
import { FakeClock, FakeTabs, reading } from "../support/fakePlatform.js";
import type { QueueReading } from "../../src/domain/types.js";

function openTabs(tabs: FakeTabs, count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    tabs.open.push(1000 + i);
    ids.push(1000 + i);
  }
  return ids;
}

describe("scaling - 100-tab round shape", () => {
  it("returns exactly one reading per tracked tab, with no duplicate tabId", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const tabIds = openTabs(tabs, 100);
    const result = await poller.runRound({ tabIds, prior: [], seq: 0 });

    expect(result.readings).toHaveLength(100);
    const seen = new Set(result.readings.map((r) => r.tabId));
    expect(seen.size).toBe(100);
    expect([...seen].toSorted((a, b) => a - b)).toEqual(tabIds.toSorted((a, b) => a - b));
  });
});

describe("scaling - bounded concurrency at 100 tabs", () => {
  it("never exceeds the configured concurrency bound", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const concurrency = 6;
    const poller = createPoller({ tabs, clock, concurrency });

    const tabIds = openTabs(tabs, 100);
    await poller.runRound({ tabIds, prior: [], seq: 0 });

    expect(tabs.peakConcurrency).toBeGreaterThan(0);
    expect(tabs.peakConcurrency).toBeLessThanOrEqual(concurrency);
    // Proves a real worker pool, not a disguised Promise.all over all 100.
    expect(tabs.peakConcurrency).toBeLessThan(100);
  });
});

describe("scaling - sequence numbers across chained 50-tab rounds", () => {
  it("issues strictly increasing seq with no reuse, and nextSeq chains round to round", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock, concurrency: 5 });

    const tabIds = openTabs(tabs, 50);

    let prior: readonly QueueReading[] = [];
    let seq = 0;
    const allIssued: number[] = [];

    for (let round = 0; round < 3; round += 1) {
      const result = await poller.runRound({ tabIds, prior, seq });
      const issuedThisRound = tabs.reads
        .slice(-50)
        .map((r) => r.seq)
        .toSorted((a, b) => a - b);
      allIssued.push(...issuedThisRound);
      prior = result.readings;
      seq = result.nextSeq;
    }

    // Strictly increasing overall, across all three rounds chained together.
    for (let i = 1; i < allIssued.length; i += 1) {
      expect(allIssued[i]).toBeGreaterThan(allIssued[i - 1] as number);
    }
    expect(new Set(allIssued).size).toBe(allIssued.length);
    expect(allIssued).toHaveLength(150);
  });
});

describe("scaling - 10% failure mix at 100 tabs", () => {
  it("gives every failed read an explicit error/closed status with progress null, never a stale numeric value", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const tabIds = openTabs(tabs, 100);
    const failingIds = tabIds.slice(0, 10);
    const failureKinds = [
      { kind: "timeout" as const },
      { kind: "throw" as const, detail: "injected" },
      { kind: "unknown" as const },
    ];
    failingIds.forEach((tabId, index) => {
      const behaviour = failureKinds[index % failureKinds.length] as
        | { kind: "timeout" }
        | { kind: "throw"; detail: string }
        | { kind: "unknown" };
      tabs.setBehaviour(tabId, behaviour);
    });

    // Every tab -- including the ones about to fail -- had a prior numeric
    // reading, so a bug that reuses stale progress would be caught.
    const prior = tabIds.map((tabId) =>
      reading({ tabId, status: "waiting", progress: 0.42, seq: 1 }),
    );

    const result = await poller.runRound({ tabIds, prior, seq: 1 });

    expect(result.readings).toHaveLength(100);
    // "unknown" is a successful-but-uninformative read (the content script
    // answered, it just has nothing trustworthy to report); "error"/"closed"
    // are the port-level failure outcomes. All three are required to drop
    // progress to null rather than carry a stale number forward.
    expect(result.failed).toBeGreaterThan(0);
    for (const tabId of failingIds) {
      const r = result.readings.find((item) => item.tabId === tabId);
      expect(r).toBeDefined();
      expect(["error", "closed", "unknown"]).toContain(r?.status);
      expect(r?.progress).toBeNull();
    }
    // Spot-check: no reading anywhere carries progress 0.42 forward unless
    // it was genuinely re-affirmed by a fresh successful read this round.
    for (const r of result.readings) {
      if (failingIds.includes(r.tabId)) {
        expect(r.progress).not.toBe(0.42);
      }
    }
  });
});

describe("scaling - rejectedStale counts out-of-order responses", () => {
  it("counts stale responses rather than merging their values into the accepted reading", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const tabIds = openTabs(tabs, 100);
    const staleIds = tabIds.slice(0, 15);
    for (const tabId of staleIds) {
      tabs.setBehaviour(tabId, { kind: "stale", seq: 2, progress: 0.11 });
    }

    const prior = tabIds.map((tabId) =>
      reading({ tabId, status: "waiting", progress: 0.77, seq: 5 }),
    );

    const result = await poller.runRound({ tabIds, prior, seq: 5 });

    expect(result.rejectedStale).toBe(staleIds.length);
    for (const tabId of staleIds) {
      const r = result.readings.find((item) => item.tabId === tabId);
      // The stale response (progress 0.11) must never be blended in; the
      // prior accepted reading (progress 0.77) is kept untouched.
      expect(r?.progress).toBe(0.77);
      expect(r?.seq).toBe(5);
    }
  });
});

describe("scaling - 100 tabs with 20 closed mid-run", () => {
  it("still returns a complete, consistent set of readings and never throws", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock, concurrency: 8 });

    const tabIds = openTabs(tabs, 100);
    // Closes 20 of the 100 tracked tabs before the round reads them.
    const closedIds = tabIds.slice(30, 50);

    const prior = tabIds.map((tabId) =>
      reading({ tabId, status: "waiting", progress: 0.3, seq: 1 }),
    );

    for (const tabId of closedIds) tabs.closeTab(tabId);

    const result = await poller.runRound({ tabIds, prior, seq: 1 });

    expect(result.readings).toHaveLength(100);
    const byId = new Map(result.readings.map((r) => [r.tabId, r] as const));
    expect(byId.size).toBe(100);
    for (const tabId of closedIds) {
      expect(byId.get(tabId)?.status).toBe("closed");
      expect(byId.get(tabId)?.progress).toBeNull();
    }
    for (const tabId of tabIds) {
      if (!closedIds.includes(tabId)) {
        expect(byId.get(tabId)?.status).not.toBe("closed");
      }
    }
  });
});
