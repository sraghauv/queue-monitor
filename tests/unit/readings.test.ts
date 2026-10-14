import { describe, expect, it } from "vitest";

import {
  ageMs,
  closeReading,
  isStale,
  latestByTab,
  mergeReading,
  mergeReadings,
  orderByTabIds,
  staleFraction,
  STALE_AFTER_MS,
} from "../../src/domain/readings.js";
import { reading } from "../support/fakePlatform.js";

const NOW = 2_000_000;

describe("ageMs", () => {
  it("returns null when readAt is null (never read)", () => {
    expect(ageMs(reading({ tabId: 1, readAt: null }), NOW)).toBeNull();
  });

  it("returns the elapsed time when readAt is in the past", () => {
    expect(ageMs(reading({ tabId: 1, readAt: NOW - 500 }), NOW)).toBe(500);
  });

  it("floors at 0 when the clock moved backwards relative to readAt", () => {
    expect(ageMs(reading({ tabId: 1, readAt: NOW + 500 }), NOW)).toBe(0);
  });
});

describe("isStale", () => {
  it("is stale when readAt is null", () => {
    expect(isStale(reading({ tabId: 1, readAt: null }), NOW)).toBe(true);
  });

  it("is stale for status error regardless of age", () => {
    expect(isStale(reading({ tabId: 1, status: "error", readAt: NOW }), NOW)).toBe(true);
  });

  it("is stale for status closed regardless of age", () => {
    expect(isStale(reading({ tabId: 1, status: "closed", readAt: NOW }), NOW)).toBe(true);
  });

  it("is stale when age exceeds staleAfterMs", () => {
    const r = reading({ tabId: 1, readAt: NOW - (STALE_AFTER_MS + 1) });
    expect(isStale(r, NOW)).toBe(true);
  });

  it("is NOT stale exactly at the staleAfterMs boundary", () => {
    const r = reading({ tabId: 1, readAt: NOW - STALE_AFTER_MS });
    expect(isStale(r, NOW)).toBe(false);
  });

  it("is not stale just under the boundary", () => {
    const r = reading({ tabId: 1, readAt: NOW - (STALE_AFTER_MS - 1) });
    expect(isStale(r, NOW)).toBe(false);
  });

  it("honors a custom staleAfterMs", () => {
    const r = reading({ tabId: 1, readAt: NOW - 100 });
    expect(isStale(r, NOW, 50)).toBe(true);
    expect(isStale(r, NOW, 100)).toBe(false);
    expect(isStale(r, NOW, 150)).toBe(false);
  });
});

describe("staleFraction", () => {
  it("returns null for empty input", () => {
    expect(staleFraction([], NOW)).toBeNull();
  });

  it("computes stale count / total", () => {
    // tabId 1 is fresh; tabId 2 is stale (never read); tabId 3 is stale
    // (status); tabId 4 is stale (age).
    const readings = [
      reading({ tabId: 1, readAt: NOW }),
      reading({ tabId: 2, readAt: null }),
      reading({ tabId: 3, status: "error", readAt: NOW }),
      reading({ tabId: 4, readAt: NOW - (STALE_AFTER_MS + 1) }),
    ];
    expect(staleFraction(readings, NOW)).toBe(3 / 4);
  });

  it("returns 0 when nothing is stale", () => {
    const readings = [reading({ tabId: 1, readAt: NOW })];
    expect(staleFraction(readings, NOW)).toBe(0);
  });
});

describe("mergeReading", () => {
  it("accepts incoming when there is no prior reading", () => {
    const incoming = reading({ tabId: 1, seq: 1 });
    expect(mergeReading(undefined, incoming)).toBe(incoming);
  });

  it("accepts incoming when its seq is strictly greater than prior", () => {
    const prior = reading({ tabId: 1, seq: 1, progress: 0.1 });
    const incoming = reading({ tabId: 1, seq: 2, progress: 0.2 });
    expect(mergeReading(prior, incoming)).toBe(incoming);
  });

  it("rejects incoming whose seq is less than prior (out of order)", () => {
    const prior = reading({ tabId: 1, seq: 5, progress: 0.5 });
    const incoming = reading({ tabId: 1, seq: 3, progress: 0.9 });
    expect(mergeReading(prior, incoming)).toBe(prior);
  });

  it("rejects incoming whose seq equals prior (duplicate)", () => {
    const prior = reading({ tabId: 1, seq: 5, progress: 0.5 });
    const incoming = reading({ tabId: 1, seq: 5, progress: 0.9 });
    expect(mergeReading(prior, incoming)).toBe(prior);
  });

  it("never blends fields from both readings", () => {
    const prior = reading({ tabId: 1, seq: 1, progress: 0.1, adapter: "old" });
    const incoming = reading({ tabId: 1, seq: 2, progress: 0.9, adapter: "new" });
    const result = mergeReading(prior, incoming);
    expect(result).toEqual(incoming);
    expect(result).not.toEqual(expect.objectContaining({ adapter: "old" }));
  });
});

describe("mergeReadings", () => {
  it("merges per tab via the seq guard", () => {
    const prior = [
      reading({ tabId: 1, seq: 1, progress: 0.1 }),
      reading({ tabId: 2, seq: 3, progress: 0.4 }),
    ];
    // tabId 1's incoming seq 2 is accepted (2 > 1); tabId 2's incoming seq 2
    // is rejected (2 < 3).
    const incoming = [
      reading({ tabId: 1, seq: 2, progress: 0.2 }),
      reading({ tabId: 2, seq: 2, progress: 0.9 }),
    ];
    const result = mergeReadings(prior, incoming);
    expect(result.map((r) => r.tabId)).toEqual([1, 2]);
    expect(result[0]?.progress).toBe(0.2);
    expect(result[1]?.progress).toBe(0.4);
  });

  it("preserves the order tabs appear in prior", () => {
    const prior = [
      reading({ tabId: 9, seq: 1 }),
      reading({ tabId: 3, seq: 1 }),
      reading({ tabId: 7, seq: 1 }),
    ];
    const incoming = [
      reading({ tabId: 3, seq: 2, progress: 0.3 }),
      reading({ tabId: 7, seq: 2, progress: 0.7 }),
    ];
    const result = mergeReadings(prior, incoming);
    expect(result.map((r) => r.tabId)).toEqual([9, 3, 7]);
  });

  it("appends genuinely new tabs at the end", () => {
    const prior = [reading({ tabId: 1, seq: 1 })];
    const incoming = [reading({ tabId: 1, seq: 2 }), reading({ tabId: 99, seq: 1 })];
    const result = mergeReadings(prior, incoming);
    expect(result.map((r) => r.tabId)).toEqual([1, 99]);
  });

  it("does not mutate either input array", () => {
    const prior = [reading({ tabId: 1, seq: 1 })];
    const incoming = [reading({ tabId: 1, seq: 2 }), reading({ tabId: 2, seq: 1 })];
    const priorSnapshot = JSON.parse(JSON.stringify(prior));
    const incomingSnapshot = JSON.parse(JSON.stringify(incoming));
    mergeReadings(prior, incoming);
    expect(prior).toEqual(priorSnapshot);
    expect(incoming).toEqual(incomingSnapshot);
  });

  it("returns prior unchanged when incoming is empty", () => {
    const prior = [reading({ tabId: 1, seq: 1 }), reading({ tabId: 2, seq: 1 })];
    expect(mergeReadings(prior, [])).toEqual(prior);
  });

  it("returns incoming (as new tabs) when prior is empty", () => {
    const incoming = [reading({ tabId: 1, seq: 1 }), reading({ tabId: 2, seq: 1 })];
    expect(mergeReadings([], incoming).map((r) => r.tabId)).toEqual([1, 2]);
  });
});

describe("latestByTab", () => {
  it("keeps the highest-seq reading per tab", () => {
    const readings = [
      reading({ tabId: 1, seq: 1, progress: 0.1 }),
      reading({ tabId: 1, seq: 3, progress: 0.3 }),
      reading({ tabId: 1, seq: 2, progress: 0.2 }),
    ];
    const map = latestByTab(readings);
    expect(map.get(1)?.seq).toBe(3);
    expect(map.get(1)?.progress).toBe(0.3);
  });

  it("includes every distinct tab", () => {
    const readings = [reading({ tabId: 1, seq: 1 }), reading({ tabId: 2, seq: 1 })];
    const map = latestByTab(readings);
    expect(map.size).toBe(2);
  });
});

describe("orderByTabIds", () => {
  it("orders readings by the given tabIds order, not rank order", () => {
    const readings = [
      reading({ tabId: 1, progress: 0.1 }),
      reading({ tabId: 2, progress: 0.9 }),
      reading({ tabId: 3, progress: 0.5 }),
    ];
    const result = orderByTabIds(readings, [3, 1, 2]);
    expect(result.map((r) => r.tabId)).toEqual([3, 1, 2]);
  });

  it("skips tabIds with no matching reading", () => {
    const readings = [reading({ tabId: 1 }), reading({ tabId: 3 })];
    const result = orderByTabIds(readings, [1, 2, 3]);
    expect(result.map((r) => r.tabId)).toEqual([1, 3]);
  });

  it("returns empty for empty tabIds", () => {
    const readings = [reading({ tabId: 1 })];
    expect(orderByTabIds(readings, [])).toEqual([]);
  });
});

describe("closeReading", () => {
  it("sets status closed, progress null, readAt now, preserving tabId and seq", () => {
    const original = reading({ tabId: 42, seq: 7, status: "waiting", progress: 0.8, readAt: 1 });
    const closed = closeReading(original, NOW);
    expect(closed).toEqual({
      ...original,
      status: "closed",
      progress: null,
      readAt: NOW,
    });
  });

  it("drops the prior numeric progress so a closed tab never reads as live", () => {
    const original = reading({ tabId: 1, progress: 0.99 });
    const closed = closeReading(original, NOW);
    expect(closed.progress).toBeNull();
  });

  it("does not mutate the original reading", () => {
    const original = reading({ tabId: 1, progress: 0.5 });
    const snapshot = { ...original };
    closeReading(original, NOW);
    expect(original).toEqual(snapshot);
  });
});
