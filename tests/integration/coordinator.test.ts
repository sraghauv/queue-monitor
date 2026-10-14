/**
 * Command-flow tests across the real store, poller and coordinator, wired to
 * the fake browser. These are the tests that would catch the popup and the
 * background disagreeing about a session.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createCoordinator, type Coordinator } from "../../src/app/coordinator.js";
import { createPoller } from "../../src/app/poller.js";
import { createStore } from "../../src/app/store.js";
import { allowlistOf } from "../../src/config/allowlist.js";
import { createFakePlatform, FakeTabs, type FakePlatform } from "../support/fakePlatform.js";

const MOCK_URL = "http://localhost:8787/";

function build(tabs?: FakeTabs): { platform: FakePlatform; coordinator: Coordinator } {
  const platform = createFakePlatform(tabs ? { tabs } : {});
  const store = createStore({
    storage: platform.storage,
    tabs: platform.tabs,
    clock: platform.clock,
  });
  const coordinator = createCoordinator({
    store,
    poller: createPoller({ tabs: platform.tabs, clock: platform.clock }),
    tabs: platform.tabs,
    clock: platform.clock,
    newSessionId: () => platform.ids.newSessionId(),
  });
  return { platform, coordinator };
}

describe("coordinator start", () => {
  let platform: FakePlatform;
  let coordinator: Coordinator;

  beforeEach(() => {
    ({ platform, coordinator } = build());
  });

  it("opens the requested tabs and reaches monitoring", async () => {
    const result = await coordinator.handle({ type: "START", url: MOCK_URL, count: 5 });
    expect(result.ok).toBe(true);
    expect(platform.tabs.open).toHaveLength(5);
    expect(coordinator.snapshot().session?.state).toBe("monitoring");
    expect(coordinator.shouldPoll()).toBe(true);
  });

  it("refuses a host that is not on the allowlist and opens no tabs", async () => {
    const result = await coordinator.handle({
      type: "START",
      url: "https://queue.evil.example/",
      count: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unsupported-host");
    expect(platform.tabs.open).toHaveLength(0);
    expect(coordinator.snapshot().session).toBeNull();
  });

  it("refuses an out-of-range count and opens no tabs", async () => {
    const result = await coordinator.handle({ type: "START", url: MOCK_URL, count: 101 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-count");
    expect(platform.tabs.open).toHaveLength(0);
  });

  it("reports partial tab creation as partial, not success", async () => {
    const tabs = new FakeTabs({ failCreateAfter: 3 });
    ({ platform, coordinator } = build(tabs));

    const result = await coordinator.handle({ type: "START", url: MOCK_URL, count: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("tab-create-failed");
      if (result.error.kind === "tab-create-failed") {
        expect(result.error.opened).toBe(3);
        expect(result.error.requested).toBe(10);
      }
    }
    // The three tabs that did open are still tracked, not abandoned.
    expect(coordinator.snapshot().session?.tabIds).toHaveLength(3);
    expect(platform.tabs.open).toHaveLength(3);
  });

  it("never creates a second set of tabs for a live session", async () => {
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 3 });
    const again = await coordinator.handle({ type: "START", url: MOCK_URL, count: 3 });

    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.kind).toBe("invalid-transition");
    expect(platform.tabs.open).toHaveLength(3);
  });

  it("accepts a custom allowlist without touching the shipped default", async () => {
    const allowed = allowlistOf(["queue.example.com"]);
    const store = createStore({
      storage: platform.storage,
      tabs: platform.tabs,
      clock: platform.clock,
    });
    const scoped = createCoordinator({
      store,
      poller: createPoller({ tabs: platform.tabs, clock: platform.clock }),
      tabs: platform.tabs,
      clock: platform.clock,
      newSessionId: () => platform.ids.newSessionId(),
      allowlist: allowed,
    });

    const good = await scoped.handle({
      type: "START",
      url: "https://queue.example.com/q",
      count: 2,
    });
    expect(good.ok).toBe(true);

    // The default allowlist is unchanged, so loopback is rejected by this one.
    const { coordinator: plain } = build();
    const loopback = await plain.handle({ type: "START", url: MOCK_URL, count: 1 });
    expect(loopback.ok).toBe(true);
  });
});

describe("coordinator commands", () => {
  let platform: FakePlatform;
  let coordinator: Coordinator;

  beforeEach(async () => {
    ({ platform, coordinator } = build());
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 4 });
  });

  it("pause stops polling and resume restarts it", async () => {
    const paused = await coordinator.handle({ type: "PAUSE" });
    expect(paused.ok).toBe(true);
    expect(coordinator.shouldPoll()).toBe(false);

    const resumed = await coordinator.handle({ type: "RESUME" });
    expect(resumed.ok).toBe(true);
    expect(coordinator.shouldPoll()).toBe(true);
  });

  it("treats repeated pause, resume and stop as idempotent", async () => {
    expect((await coordinator.handle({ type: "PAUSE" })).ok).toBe(true);
    expect((await coordinator.handle({ type: "PAUSE" })).ok).toBe(true);
    expect((await coordinator.handle({ type: "RESUME" })).ok).toBe(true);
    expect((await coordinator.handle({ type: "RESUME" })).ok).toBe(true);
    expect((await coordinator.handle({ type: "STOP" })).ok).toBe(true);
    expect((await coordinator.handle({ type: "STOP" })).ok).toBe(true);
  });

  it("stop leaves every tab open", async () => {
    const before = [...platform.tabs.open];
    await coordinator.handle({ type: "STOP" });

    expect(coordinator.snapshot().session?.state).toBe("stopped");
    expect(coordinator.shouldPoll()).toBe(false);
    expect(platform.tabs.open).toEqual(before);
  });

  it("rejects pause on a stopped session instead of pretending it worked", async () => {
    await coordinator.handle({ type: "STOP" });
    const paused = await coordinator.handle({ type: "PAUSE" });

    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.error.kind).toBe("invalid-transition");
  });

  it("focus pauses monitoring first, then activates the tab", async () => {
    const tabId = coordinator.snapshot().session?.tabIds[1];
    expect(tabId).toBeDefined();

    const focused = await coordinator.handle({ type: "FOCUS_TAB", tabId: tabId as number });
    expect(focused.ok).toBe(true);
    expect(platform.tabs.focused).toEqual([tabId]);
    expect(coordinator.snapshot().session?.state).toBe("paused");
  });

  it("refuses to focus a tab it does not track", async () => {
    const result = await coordinator.handle({ type: "FOCUS_TAB", tabId: 999_999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("tab-missing");
    expect(platform.tabs.focused).toHaveLength(0);
  });

  it("returns a snapshot without changing anything", async () => {
    const before = coordinator.snapshot().session?.updatedAt;
    const result = await coordinator.handle({ type: "GET_SNAPSHOT" });

    expect(result.ok).toBe(true);
    expect(coordinator.snapshot().session?.updatedAt).toBe(before);
  });
});

describe("coordinator polling", () => {
  it("ranks a round and keeps row order as tracked-tab order", async () => {
    const tabs = new FakeTabs();
    const { coordinator } = build(tabs);
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 3 });

    const [first, second, third] = tabs.open as [number, number, number];
    tabs.setBehaviour(first, { kind: "waiting", progress: 0.2 });
    tabs.setBehaviour(second, { kind: "waiting", progress: 0.9 });
    tabs.setBehaviour(third, { kind: "waiting", progress: 0.45 });

    const snapshot = await coordinator.tick();

    // Rows follow creation order; rank is carried alongside, not applied to it.
    expect(snapshot.readings.map((r) => r.tabId)).toEqual([first, second, third]);
    expect(snapshot.ranked.map((r) => r.tabId)).toEqual([second, third, first]);
    expect(snapshot.ranked[0]?.score).toBe(100);
    expect(snapshot.metrics.roundsCompleted).toBe(1);
  });

  it("gives a ready tab its own state rather than another percentage", async () => {
    const tabs = new FakeTabs();
    const { coordinator } = build(tabs);
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 2 });

    const [first, second] = tabs.open as [number, number];
    tabs.setBehaviour(first, { kind: "waiting", progress: 0.3 });
    tabs.setBehaviour(second, { kind: "ready" });

    const snapshot = await coordinator.tick();

    expect(snapshot.ready.map((r) => r.tabId)).toEqual([second]);
    expect(snapshot.ranked.map((r) => r.tabId)).toEqual([first]);
  });

  it("does not poll while paused", async () => {
    const tabs = new FakeTabs();
    const { coordinator } = build(tabs);
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 3 });
    await coordinator.handle({ type: "PAUSE" });

    const readsBefore = tabs.reads.length;
    await coordinator.tick();

    expect(tabs.reads.length).toBe(readsBefore);
  });

  it("never carries a failed read's previous number forward", async () => {
    const tabs = new FakeTabs();
    const { coordinator } = build(tabs);
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 1 });
    const tabId = tabs.open[0] as number;

    tabs.setBehaviour(tabId, { kind: "waiting", progress: 0.77 });
    const good = await coordinator.tick();
    expect(good.readings[0]?.progress).toBeCloseTo(0.77);

    tabs.setBehaviour(tabId, { kind: "timeout" });
    const bad = await coordinator.tick();

    expect(bad.readings[0]?.status).toBe("error");
    expect(bad.readings[0]?.progress).toBeNull();
    expect(bad.ranked).toHaveLength(0);
  });

  it("advances sequence numbers across rounds without reuse", async () => {
    const tabs = new FakeTabs();
    const { coordinator } = build(tabs);
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 3 });

    await coordinator.tick();
    await coordinator.tick();
    await coordinator.tick();

    const issued = tabs.reads.map((r) => r.seq);
    expect(new Set(issued).size).toBe(issued.length);
    expect(coordinator.snapshot().session?.seq).toBe(issued.length);
  });
});
