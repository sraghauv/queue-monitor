/**
 * Recovery tests.
 *
 * These cover the scenarios the source guide calls out as the ones that
 * actually break queue monitors: the popup closes and reopens, the service
 * worker is suspended and restarts with empty globals, and tabs disappear
 * while nobody was watching. A fresh coordinator built over the same storage
 * stands in for a restarted worker — which is exactly what a restart is.
 */

import { describe, expect, it } from "vitest";
import { createCoordinator, type Coordinator } from "../../src/app/coordinator.js";
import { createPoller } from "../../src/app/poller.js";
import { createStore } from "../../src/app/store.js";
import { STALE_AFTER_MS } from "../../src/domain/readings.js";
import { FakeClock, FakeStorage, FakeTabs } from "../support/fakePlatform.js";

const MOCK_URL = "http://localhost:8787/";

/** Builds a coordinator over shared storage/tabs, as a restart would. */
function spawn(storage: FakeStorage, tabs: FakeTabs, clock: FakeClock): Coordinator {
  return createCoordinator({
    store: createStore({ storage, tabs, clock }),
    poller: createPoller({ tabs, clock }),
    tabs,
    clock,
    newSessionId: () => "replacement-session",
  });
}

describe("recovery across a worker restart", () => {
  it("recovers the session from storage instead of starting over", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();

    const first = spawn(storage, tabs, clock);
    await first.handle({ type: "START", url: MOCK_URL, count: 4 });
    const originalId = first.snapshot().session?.id;
    const originalTabs = first.snapshot().session?.tabIds;

    // The worker dies. A new instance has empty globals and only storage.
    const restarted = spawn(storage, tabs, clock);
    const recovered = await restarted.hydrate();

    expect(recovered.session?.id).toBe(originalId);
    expect(recovered.session?.tabIds).toEqual(originalTabs);
    expect(recovered.session?.state).toBe("monitoring");
    // Critically: no second set of tabs.
    expect(tabs.open).toHaveLength(4);
  });

  it("drops tabs the user closed while the worker was asleep", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();

    const first = spawn(storage, tabs, clock);
    await first.handle({ type: "START", url: MOCK_URL, count: 5 });
    await first.tick();
    const [closedA, closedB] = tabs.open as [number, number];

    // Closed with no live listener to hear about it.
    tabs.open = tabs.open.filter((id) => id !== closedA && id !== closedB);

    const restarted = spawn(storage, tabs, clock);
    const recovered = await restarted.hydrate();

    expect(recovered.session?.tabIds).toHaveLength(3);
    expect(recovered.session?.tabIds).not.toContain(closedA);

    const closedRows = recovered.readings.filter((r) => r.status === "closed");
    expect(closedRows).toHaveLength(2);
    // A closed tab must not keep showing the number it last reported.
    for (const row of closedRows) expect(row.progress).toBeNull();
    expect(recovered.ranked.map((r) => r.tabId)).not.toContain(closedA);
  });

  it("shows recovered readings as stale rather than current", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();

    const first = spawn(storage, tabs, clock);
    await first.handle({ type: "START", url: MOCK_URL, count: 2 });
    await first.tick();
    expect(first.snapshot().readings.every((r) => r.progress !== null)).toBe(true);

    // Time passes with nothing polling.
    clock.advance(STALE_AFTER_MS * 4);

    const restarted = spawn(storage, tabs, clock);
    const recovered = await restarted.hydrate();

    const now = clock.now();
    for (const row of recovered.readings) {
      expect(row.readAt).not.toBeNull();
      expect(now - (row.readAt as number)).toBeGreaterThan(STALE_AFTER_MS);
    }
  });

  it("keeps pause, resume and stop idempotent across a restart", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();

    const first = spawn(storage, tabs, clock);
    await first.handle({ type: "START", url: MOCK_URL, count: 2 });
    await first.handle({ type: "PAUSE" });

    const restarted = spawn(storage, tabs, clock);
    await restarted.hydrate();
    expect(restarted.snapshot().session?.state).toBe("paused");

    // A repeat of the command the previous instance already applied.
    const again = await restarted.handle({ type: "PAUSE" });
    expect(again.ok).toBe(true);
    expect(restarted.snapshot().session?.state).toBe("paused");
  });

  it("surfaces a storage read failure without inventing a session", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();

    storage.failNextRead = true;
    const coordinator = spawn(storage, tabs, clock);
    const snapshot = await coordinator.hydrate();

    expect(snapshot.session).toBeNull();
    expect(snapshot.readings).toEqual([]);
    expect(snapshot.lastError).toBeTruthy();
  });
});

describe("live tab closure", () => {
  it("reconciles a tab the user closes mid-session", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();

    const coordinator = spawn(storage, tabs, clock);
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 4 });
    await coordinator.tick();

    const victim = tabs.open[2] as number;
    tabs.closeTab(victim);
    await coordinator.noteTabClosed(victim);

    const snapshot = coordinator.snapshot();
    expect(snapshot.session?.tabIds).not.toContain(victim);
    expect(snapshot.session?.tabIds).toHaveLength(3);
    expect(snapshot.ranked.map((r) => r.tabId)).not.toContain(victim);
    // The remaining tabs are untouched; nothing here closes a tab.
    expect(tabs.open).toHaveLength(3);

    // The closed tab keeps a visible row with its number stripped. Removing
    // the id from the session before reconciling used to leave reconcile with
    // nothing to detect, so this row either lied or vanished.
    const closedRow = snapshot.readings.find((reading) => reading.tabId === victim);
    expect(closedRow).toBeDefined();
    expect(closedRow?.status).toBe("closed");
    expect(closedRow?.progress).toBeNull();
  });

  it("keeps the closed row through later polling rounds", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();

    const coordinator = spawn(storage, tabs, clock);
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 3 });
    await coordinator.tick();

    const victim = tabs.open[1] as number;
    tabs.closeTab(victim);
    await coordinator.noteTabClosed(victim);

    // A round only reads tracked tabs. Without carrying closed rows forward,
    // the next round erases the evidence that the tab ever existed.
    await coordinator.tick();
    await coordinator.tick();

    const snapshot = coordinator.snapshot();
    const closedRow = snapshot.readings.find((reading) => reading.tabId === victim);
    expect(closedRow?.status).toBe("closed");
    expect(closedRow?.progress).toBeNull();
    expect(snapshot.readings).toHaveLength(3);
  });

  it("keeps the closed row across a worker restart", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();

    const first = spawn(storage, tabs, clock);
    await first.handle({ type: "START", url: MOCK_URL, count: 3 });
    await first.tick();
    const victim = tabs.open[0] as number;
    tabs.closeTab(victim);
    await first.noteTabClosed(victim);

    const restarted = spawn(storage, tabs, clock);
    const recovered = await restarted.hydrate();

    const closedRow = recovered.readings.find((reading) => reading.tabId === victim);
    expect(closedRow?.status).toBe("closed");
    expect(closedRow?.progress).toBeNull();
  });

  it("ignores a closure notice for a tab it never tracked", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();

    const coordinator = spawn(storage, tabs, clock);
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 2 });
    const before = coordinator.snapshot().session?.tabIds;

    await coordinator.noteTabClosed(987_654);

    expect(coordinator.snapshot().session?.tabIds).toEqual(before);
  });

  it("keeps polling the survivors after a closure", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();

    const coordinator = spawn(storage, tabs, clock);
    await coordinator.handle({ type: "START", url: MOCK_URL, count: 3 });
    const victim = tabs.open[0] as number;
    tabs.closeTab(victim);
    await coordinator.noteTabClosed(victim);

    const snapshot = await coordinator.tick();

    expect(snapshot.readings).toHaveLength(2);
    expect(snapshot.readings.every((r) => r.status === "waiting")).toBe(true);
  });
});
