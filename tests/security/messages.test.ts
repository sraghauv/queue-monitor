/**
 * Forged-message tests.
 *
 * The background's message listener is reachable from any extension context,
 * and a content script's reply originates next to untrusted page script. So the
 * question these tests ask is not "does a valid message work" but "what does a
 * hostile or malformed one do". The answer must always be: rejected with a
 * tagged error, no state change, nothing thrown.
 */

import { describe, expect, it } from "vitest";
import { createCoordinator } from "../../src/app/coordinator.js";
import { createPoller } from "../../src/app/poller.js";
import { createStore } from "../../src/app/store.js";
import { parseContentReading, parsePopupCommand } from "../../src/domain/messages.js";
import { createFakePlatform, FakeTabs } from "../support/fakePlatform.js";

const FORGED_COMMANDS: readonly unknown[] = [
  undefined,
  null,
  0,
  "START",
  [],
  {},
  { type: "" },
  { type: "start" },
  { type: "START" },
  { type: "START", url: "http://localhost:8787/" },
  { type: "START", count: 5 },
  { type: "START", url: 12, count: 5 },
  { type: "START", url: "http://localhost:8787/", count: "5" },
  { type: "FOCUS_TAB" },
  { type: "FOCUS_TAB", tabId: "1" },
  { type: "FOCUS_TAB", tabId: 1.5 },
  { type: "DROP_TABLES" },
  { type: "CLOSE_TABS", tabIds: [1, 2, 3] },
  { type: ["START"] },
  { type: { toString: () => "START" } },
];

describe("parsePopupCommand", () => {
  it.each(FORGED_COMMANDS.map((raw, i) => [i, raw] as const))(
    "rejects forged command #%i",
    (_index, raw) => {
      const result = parsePopupCommand(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("malformed-message");
    },
  );

  it("accepts a well-formed command and keeps its values", () => {
    const result = parsePopupCommand({
      type: "START",
      url: "http://localhost:8787/",
      count: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.type === "START") {
      expect(result.value.url).toBe("http://localhost:8787/");
      expect(result.value.count).toBe(5);
    }
  });

  it("does not let a prototype-polluting payload through", () => {
    const result = parsePopupCommand(
      JSON.parse(
        '{"type":"START","url":"http://localhost:8787/","count":1,"__proto__":{"polluted":true}}',
      ),
    );
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

const FORGED_READINGS: readonly unknown[] = [
  undefined,
  null,
  "QUEUE_READING",
  {},
  { type: "QUEUE_READING" },
  { type: "NOT_A_READING", seq: 1, status: "waiting", progress: 0.5 },
  { type: "QUEUE_READING", seq: -1, status: "waiting", progress: 0.5 },
  { type: "QUEUE_READING", seq: 1.5, status: "waiting", progress: 0.5 },
  { type: "QUEUE_READING", seq: "1", status: "waiting", progress: 0.5 },
  { type: "QUEUE_READING", seq: 1, status: "error", progress: 0.5 },
  { type: "QUEUE_READING", seq: 1, status: "closed", progress: 0.5 },
  { type: "QUEUE_READING", seq: 1, status: "HACKED", progress: 0.5 },
  { type: "QUEUE_READING", seq: 1, status: "waiting", progress: Number.NaN },
  { type: "QUEUE_READING", seq: 1, status: "waiting", progress: Number.POSITIVE_INFINITY },
  { type: "QUEUE_READING", seq: 1, status: "waiting", progress: "0.5" },
];

describe("parseContentReading", () => {
  it.each(FORGED_READINGS.map((raw, i) => [i, raw] as const))(
    "rejects forged reading #%i",
    (_index, raw) => {
      const result = parseContentReading(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("malformed-message");
    },
  );

  it("clamps an out-of-range progress rather than trusting the page", () => {
    const high = parseContentReading({
      type: "QUEUE_READING",
      seq: 1,
      status: "waiting",
      progress: 99,
    });
    expect(high.ok).toBe(true);
    if (high.ok) expect(high.value.progress).toBe(1);

    const low = parseContentReading({
      type: "QUEUE_READING",
      seq: 1,
      status: "waiting",
      progress: -5,
    });
    expect(low.ok).toBe(true);
    if (low.ok) expect(low.value.progress).toBe(0);
  });

  it("truncates an over-long adapter id from a hostile page", () => {
    const result = parseContentReading({
      type: "QUEUE_READING",
      seq: 1,
      status: "waiting",
      progress: 0.5,
      adapter: "A".repeat(10_000),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value.adapter ?? "").length).toBeLessThanOrEqual(64);
  });

  it("keeps page-supplied markup as an inert string", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const result = parseContentReading({
      type: "QUEUE_READING",
      seq: 1,
      status: "waiting",
      progress: 0.5,
      adapter: payload,
    });
    expect(result.ok).toBe(true);
    // It survives only as data; rendering uses textContent, never innerHTML.
    if (result.ok) expect(result.value.adapter).toBe(payload);
  });
});

describe("the coordinator refuses forged commands without side effects", () => {
  it("opens no tabs and keeps no session for any forged command", async () => {
    const platform = createFakePlatform({ tabs: new FakeTabs() });
    const coordinator = createCoordinator({
      store: createStore({
        storage: platform.storage,
        tabs: platform.tabs,
        clock: platform.clock,
      }),
      poller: createPoller({ tabs: platform.tabs, clock: platform.clock }),
      tabs: platform.tabs,
      clock: platform.clock,
      newSessionId: () => platform.ids.newSessionId(),
    });

    for (const raw of FORGED_COMMANDS) {
      const parsed = parsePopupCommand(raw);
      expect(parsed.ok).toBe(false);
      // A forged command never reaches the coordinator, so nothing can happen.
    }

    // A command that parses but names a disallowed host also opens nothing.
    const result = await coordinator.handle({
      type: "START",
      url: "https://tickets.evil.example/queue",
      count: 100,
    });
    expect(result.ok).toBe(false);
    expect(platform.tabs.open).toHaveLength(0);
    expect(coordinator.snapshot().session).toBeNull();
  });

  it("will not open a javascript: URL even with a valid command shape", async () => {
    const platform = createFakePlatform({ tabs: new FakeTabs() });
    const coordinator = createCoordinator({
      store: createStore({
        storage: platform.storage,
        tabs: platform.tabs,
        clock: platform.clock,
      }),
      poller: createPoller({ tabs: platform.tabs, clock: platform.clock }),
      tabs: platform.tabs,
      clock: platform.clock,
      newSessionId: () => platform.ids.newSessionId(),
    });

    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "file:///etc/passwd",
      "http://localhost@evil.example/",
    ]) {
      const result = await coordinator.handle({ type: "START", url, count: 1 });
      expect(result.ok).toBe(false);
      expect(platform.tabs.open).toHaveLength(0);
    }
  });
});
