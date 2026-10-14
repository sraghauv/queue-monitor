import { describe, expect, it } from "vitest";

import { createPoller, DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS } from "../../src/app/poller.js";
import { FakeClock, FakeTabs, reading } from "../support/fakePlatform.js";

describe("createPoller defaults", () => {
  it("exposes the documented default concurrency and timeout", () => {
    expect(DEFAULT_CONCURRENCY).toBe(4);
    expect(DEFAULT_TIMEOUT_MS).toBe(2_000);
  });
});

describe("runRound - clean round", () => {
  it("reads every tab and produces one accepted reading each", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const tabIds = [100, 101, 102, 103, 104];
    for (const id of tabIds) tabs.open.push(id);
    for (const id of tabIds) tabs.setBehaviour(id, { kind: "waiting", progress: 0.5 });

    const result = await poller.runRound({ tabIds, prior: [], seq: 0 });

    expect(result.readings).toHaveLength(5);
    expect(result.accepted).toBe(5);
    expect(result.rejectedStale).toBe(0);
    expect(result.failed).toBe(0);
    // Highest number issued this round (1..5), handed straight back as the
    // next round's `seq`.
    expect(result.nextSeq).toBe(5);
    for (const r of result.readings) {
      expect(r.status).toBe("waiting");
      expect(r.progress).toBe(0.5);
      expect(r.latencyMs).toBeDefined();
      expect(r.adapter).toBe("fake");
    }
  });

  it("issues strictly increasing sequence numbers, one per read attempt", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock, concurrency: 2 });

    const tabIds = [200, 201, 202, 203];
    for (const id of tabIds) tabs.open.push(id);

    const result = await poller.runRound({ tabIds, prior: [], seq: 10 });

    // Sorting a fresh array from `map`, not the input.
    // oxlint-disable-next-line unicorn/no-array-sort
    const issued = tabs.reads.map((r) => r.seq).sort((a, b) => a - b);
    expect(issued).toEqual([11, 12, 13, 14]);
    expect(new Set(issued).size).toBe(4);
    expect(result.nextSeq).toBe(14);
  });

  it("yields a valid zero-count round for an empty tabIds list", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const result = await poller.runRound({ tabIds: [], prior: [], seq: 5 });

    expect(result.readings).toEqual([]);
    expect(result.accepted).toBe(0);
    expect(result.rejectedStale).toBe(0);
    expect(result.failed).toBe(0);
    // A round that issued nothing must not consume a sequence number.
    expect(result.nextSeq).toBe(5);
    expect(tabs.reads).toHaveLength(0);
  });
});

describe("runRound - bounded concurrency", () => {
  it("never exceeds the configured concurrency bound", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const concurrency = 3;
    const poller = createPoller({ tabs, clock, concurrency });

    const tabIds = Array.from({ length: 20 }, (_, i) => 300 + i);
    for (const id of tabIds) tabs.open.push(id);

    await poller.runRound({ tabIds, prior: [], seq: 0 });

    expect(tabs.peakConcurrency).toBeLessThanOrEqual(concurrency);
    expect(tabs.peakConcurrency).toBeGreaterThan(0);
  });

  it("clamps a caller-supplied concurrency of 0 or negative to at least 1", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock, concurrency: -5 });

    const tabIds = [400, 401, 402];
    for (const id of tabIds) tabs.open.push(id);

    const result = await poller.runRound({ tabIds, prior: [], seq: 0 });

    expect(tabs.peakConcurrency).toBe(1);
    expect(result.accepted).toBe(3);
  });
});

describe("runRound - per-tab timeout", () => {
  it("turns a read-timeout into status error with progress null, never reusing prior progress", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock, timeoutMs: 500 });

    const tabId = 500;
    tabs.open.push(tabId);
    tabs.setBehaviour(tabId, { kind: "timeout" });

    const prior = [reading({ tabId, status: "waiting", progress: 0.7, seq: 1 })];
    const result = await poller.runRound({ tabIds: [tabId], prior, seq: 1 });

    expect(result.failed).toBe(1);
    expect(result.accepted).toBe(0);
    const [r] = result.readings;
    expect(r?.status).toBe("error");
    expect(r?.progress).toBeNull();
    expect(r?.error).toBeDefined();
    expect(tabs.reads[0]?.seq).toBeDefined();
  });
});

describe("runRound - thrown/failed read", () => {
  it("turns a read-failed error into an error reading", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const tabId = 600;
    tabs.open.push(tabId);
    tabs.setBehaviour(tabId, { kind: "throw", detail: "boom" });

    const result = await poller.runRound({ tabIds: [tabId], prior: [], seq: 0 });

    expect(result.failed).toBe(1);
    expect(result.readings[0]?.status).toBe("error");
    expect(result.readings[0]?.progress).toBeNull();
    expect(result.readings[0]?.error).toContain("boom");
  });

  it("turns a malformed payload into an error reading", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const tabId = 650;
    tabs.open.push(tabId);
    tabs.setBehaviour(tabId, { kind: "malformed", payload: { weird: true } });

    const result = await poller.runRound({ tabIds: [tabId], prior: [], seq: 0 });

    expect(result.failed).toBe(1);
    expect(result.readings[0]?.status).toBe("error");
    expect(result.readings[0]?.progress).toBeNull();
  });
});

describe("runRound - tab-missing becomes closed", () => {
  it("maps a closed tab to status closed, not error, and drops its progress", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const tabId = 700;
    tabs.open.push(tabId);
    const prior = [reading({ tabId, status: "waiting", progress: 0.9, seq: 1 })];

    // Simulates the tab closing mid-round / before the read.
    tabs.closeTab(tabId);

    const result = await poller.runRound({ tabIds: [tabId], prior, seq: 1 });

    expect(result.readings[0]?.status).toBe("closed");
    expect(result.readings[0]?.progress).toBeNull();
    expect(result.failed).toBe(0);
    expect(result.accepted).toBe(1);
  });
});

describe("runRound - out-of-order rejection", () => {
  it("rejects a stale response and keeps the prior reading", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const tabId = 800;
    tabs.open.push(tabId);
    // Responds with an old seq (5), simulating a late reply.
    tabs.setBehaviour(tabId, { kind: "stale", seq: 5, progress: 0.3 });

    const prior = [reading({ tabId, status: "waiting", progress: 0.6, seq: 10 })];
    const result = await poller.runRound({ tabIds: [tabId], prior, seq: 10 });

    expect(result.rejectedStale).toBe(1);
    expect(result.accepted).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.readings[0]).toEqual(prior[0]);
  });
});

describe("runRound - no overlapping rounds", () => {
  it("returns the in-flight promise instead of starting a second round", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock, concurrency: 2 });

    const tabIds = [900, 901, 902, 903];
    for (const id of tabIds) tabs.open.push(id);

    expect(poller.isRunning()).toBe(false);

    const first = poller.runRound({ tabIds, prior: [], seq: 0 });
    expect(poller.isRunning()).toBe(true);
    const second = poller.runRound({ tabIds, prior: [], seq: 0 });

    expect(second).toBe(first);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    // One round's worth of reads, not two.
    expect(tabs.reads).toHaveLength(4);
    expect(firstResult).toBe(secondResult);
    expect(poller.isRunning()).toBe(false);
  });

  it("allows a new round to start once the prior round has finished", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const tabIds = [910, 911];
    for (const id of tabIds) tabs.open.push(id);

    await poller.runRound({ tabIds, prior: [], seq: 0 });
    expect(poller.isRunning()).toBe(false);

    await poller.runRound({ tabIds, prior: [], seq: 10 });

    expect(tabs.reads).toHaveLength(4);
  });
});

describe("runRound - prior readings for untracked tabs", () => {
  it("drops prior readings whose tab is absent from tabIds", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const trackedTabId = 1000;
    const untrackedTabId = 1001;
    tabs.open.push(trackedTabId, untrackedTabId);
    tabs.setBehaviour(trackedTabId, { kind: "waiting", progress: 0.2 });

    const prior = [
      reading({ tabId: trackedTabId, status: "waiting", progress: 0.1, seq: 1 }),
      reading({ tabId: untrackedTabId, status: "waiting", progress: 0.4, seq: 1 }),
    ];

    const result = await poller.runRound({ tabIds: [trackedTabId], prior, seq: 1 });

    expect(result.readings).toHaveLength(1);
    expect(result.readings[0]?.tabId).toBe(trackedTabId);
  });

  it("does not read tabs absent from tabIds", async () => {
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const poller = createPoller({ tabs, clock });

    const includedId = 1100;
    const excludedId = 1101;
    tabs.open.push(includedId, excludedId);

    await poller.runRound({ tabIds: [includedId], prior: [], seq: 0 });

    expect(tabs.reads.map((r) => r.tabId)).toEqual([includedId]);
  });
});
