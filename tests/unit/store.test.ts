import { describe, expect, it } from "vitest";

import { createStore } from "../../src/app/store.js";
import { createSession } from "../../src/domain/session.js";
import { FakeClock, FakeStorage, FakeTabs, reading } from "../support/fakePlatform.js";

function makeSession(overrides: Partial<ReturnType<typeof createSession>> = {}) {
  const base = createSession({
    id: "s1",
    url: "https://example.com/queue",
    requestedCount: 2,
    now: 1_000_000,
  });
  return { ...base, state: "monitoring" as const, ...overrides };
}

describe("createStore.load", () => {
  it("returns empty state for empty storage", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const result = await store.load();

    expect(result.session).toBeNull();
    expect(result.readings).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("round-trips a session with readings belonging to its tracked tabs", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const session = { ...makeSession(), tabIds: [100, 101] };
    const readings = [
      reading({ tabId: 100, progress: 0.2 }),
      reading({ tabId: 101, progress: 0.4 }),
    ];

    const saveResult = await store.save(session, readings);
    expect(saveResult.ok).toBe(true);

    const loaded = await store.load();
    expect(loaded.session).toEqual(session);
    expect(loaded.readings).toEqual(readings);
    expect(loaded.problems).toEqual([]);
  });

  it("surfaces an injected session read failure in problems without throwing, and treats a null session as normal", async () => {
    const storage = new FakeStorage();
    storage.failNextRead = true;
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const result = await store.load();

    expect(result.session).toBeNull();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toEqual({ kind: "storage-failed", detail: "injected read failure" });
  });

  it("a genuinely null session (no injected failure) produces zero problems", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const result = await store.load();

    expect(result.session).toBeNull();
    expect(result.problems).toEqual([]);
  });

  it("drops orphan readings that belong to no tracked tab when a session exists", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const session = { ...makeSession(), tabIds: [100] };
    storage.session = session;
    storage.readings = [
      reading({ tabId: 100, progress: 0.3 }),
      reading({ tabId: 999, progress: 0.9 }),
    ];

    const result = await store.load();

    expect(result.session).toEqual(session);
    expect(result.readings).toEqual([reading({ tabId: 100, progress: 0.3 })]);
  });

  it("drops every reading when there is no session at all", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    storage.session = null;
    storage.readings = [reading({ tabId: 100, progress: 0.3 })];

    const result = await store.load();

    expect(result.session).toBeNull();
    expect(result.readings).toEqual([]);
  });
});

describe("createStore.save / saveSession / saveReadings / clear", () => {
  it("returns a Result error (not a throw) when the readings write is injected to fail", async () => {
    const storage = new FakeStorage();
    storage.failNextWrite = true;
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const result = await store.saveReadings([reading({ tabId: 100 })]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "storage-failed", detail: "injected write failure" });
    }
  });

  it("saveSession returns a Result error on an injected write failure", async () => {
    const storage = new FakeStorage();
    storage.failNextWrite = true;
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const result = await store.saveSession(makeSession());

    expect(result.ok).toBe(false);
  });

  it("save attempts both writes even when the session write fails, and returns the first error", async () => {
    const storage = new FakeStorage();
    // Fails only the first write (session).
    storage.failNextWrite = true;
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const session = { ...makeSession(), tabIds: [100] };
    const readings = [reading({ tabId: 100 })];

    const result = await store.save(session, readings);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "storage-failed", detail: "injected write failure" });
    }
    // The session write failed and left storage.session unchanged, but the
    // readings write still went through.
    expect(storage.session).toBeNull();
    expect(storage.readings).toEqual(readings);
  });

  it("keeps only the latest reading per tab on save", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const older = reading({ tabId: 100, seq: 1, progress: 0.1 });
    const newer = reading({ tabId: 100, seq: 2, progress: 0.5 });

    const result = await store.saveReadings([older, newer]);
    expect(result.ok).toBe(true);
    expect(storage.readings).toEqual([newer]);
  });

  it("clear wipes session and readings", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    storage.session = { ...makeSession(), tabIds: [100] };
    storage.readings = [reading({ tabId: 100 })];

    const result = await store.clear();

    expect(result.ok).toBe(true);
    expect(storage.session).toBeNull();
    expect(storage.readings).toEqual([]);
  });
});

describe("createStore.reconcile", () => {
  it("returns an unchanged session/readings and empty removed when all tracked tabs are alive", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    tabs.open = [100, 101];
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const session = { ...makeSession(), tabIds: [100, 101] };
    const readings = [
      reading({ tabId: 100, progress: 0.2 }),
      reading({ tabId: 101, progress: 0.4 }),
    ];

    const result = await store.reconcile(session, readings);

    expect(result.session).toEqual(session);
    expect(result.readings).toEqual(readings);
    expect(result.removed).toEqual([]);
  });

  it("shrinks the session and closes the reading for one closed tab, keeping it in the list as closed", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    // 100 is gone.
    tabs.open = [101];
    const clock = new FakeClock(2_000_000);
    const store = createStore({ storage, tabs, clock });

    const session = { ...makeSession(), tabIds: [100, 101] };
    const readings = [
      reading({ tabId: 100, progress: 0.2 }),
      reading({ tabId: 101, progress: 0.4 }),
    ];

    const result = await store.reconcile(session, readings);

    expect(result.removed).toEqual([100]);
    expect(result.session?.tabIds).toEqual([101]);

    const closed = result.readings.find((r) => r.tabId === 100);
    expect(closed?.status).toBe("closed");
    expect(closed?.progress).toBeNull();
    expect(closed?.readAt).toBe(2_000_000);

    const surviving = result.readings.find((r) => r.tabId === 101);
    expect(surviving).toEqual(reading({ tabId: 101, progress: 0.4 }));

    // Surviving tabs first (in surviving tab order), closed ones after.
    expect(result.readings.map((r) => r.tabId)).toEqual([101, 100]);
  });

  it("closes every reading when every tracked tab is gone", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    tabs.open = [];
    const clock = new FakeClock(2_000_000);
    const store = createStore({ storage, tabs, clock });

    const session = { ...makeSession(), tabIds: [100, 101] };
    const readings = [
      reading({ tabId: 100, progress: 0.2 }),
      reading({ tabId: 101, progress: 0.4 }),
    ];

    const result = await store.reconcile(session, readings);

    expect(result.session?.tabIds).toEqual([]);
    expect(result.removed).toHaveLength(2);
    expect(result.removed).toContain(100);
    expect(result.removed).toContain(101);
    expect(result.readings).toHaveLength(2);
    for (const r of result.readings) {
      expect(r.status).toBe("closed");
      expect(r.progress).toBeNull();
    }
  });

  it("returns an all-null/empty result for a null session", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    tabs.open = [100];
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const result = await store.reconcile(null, [reading({ tabId: 100 })]);

    expect(result).toEqual({ session: null, readings: [], removed: [] });
  });

  it("never writes to storage", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    tabs.open = [101];
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const session = { ...makeSession(), tabIds: [100, 101] };
    const readings = [reading({ tabId: 100 }), reading({ tabId: 101 })];

    const writesBefore = storage.writes;
    await store.reconcile(session, readings);
    expect(storage.writes).toBe(writesBefore);
  });

  it("never calls anything that closes a browser tab", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    tabs.open = [101];
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const session = { ...makeSession(), tabIds: [100, 101] };
    const readings = [reading({ tabId: 100 }), reading({ tabId: 101 })];

    const openBefore = [...tabs.open];
    await store.reconcile(session, readings);
    // reconcile must never remove a tab from the browser's own open list;
    // only the browser closing a tab (simulated via tabs.closeTab) may do
    // that, and reconcile never calls it.
    expect(tabs.open).toEqual(openBefore);
  });

  it("keeps only the latest reading per tab when ordering survivors", async () => {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    tabs.open = [100];
    const clock = new FakeClock();
    const store = createStore({ storage, tabs, clock });

    const session = { ...makeSession(), tabIds: [100] };
    const older = reading({ tabId: 100, seq: 1, progress: 0.1 });
    const newer = reading({ tabId: 100, seq: 2, progress: 0.6 });

    const result = await store.reconcile(session, [older, newer]);

    expect(result.readings).toEqual([newer]);
  });
});
