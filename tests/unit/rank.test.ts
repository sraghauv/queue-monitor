import { describe, expect, it } from "vitest";

import { rank, readyTabs } from "../../src/domain/rank.js";
import { reading } from "../support/fakePlatform.js";

describe("rank", () => {
  it("returns empty for empty input", () => {
    expect(rank([])).toEqual([]);
  });

  it("excludes non-waiting statuses entirely rather than ranking them last", () => {
    const readings = [
      reading({ tabId: 1, status: "waiting", progress: 0.5 }),
      reading({ tabId: 2, status: "unknown", progress: null }),
      reading({ tabId: 3, status: "error", progress: null }),
      reading({ tabId: 4, status: "closed", progress: null }),
      reading({ tabId: 5, status: "loading", progress: null }),
      reading({ tabId: 6, status: "ready", progress: 1 }),
    ];
    const result = rank(readings);
    expect(result).toHaveLength(1);
    expect(result[0]?.tabId).toBe(1);
  });

  it("excludes null progress", () => {
    const result = rank([reading({ tabId: 1, status: "waiting", progress: null })]);
    expect(result).toEqual([]);
  });

  it("excludes NaN progress", () => {
    const result = rank([reading({ tabId: 1, status: "waiting", progress: Number.NaN })]);
    expect(result).toEqual([]);
  });

  it("excludes Infinity progress", () => {
    const result = rank([
      reading({ tabId: 1, status: "waiting", progress: Number.POSITIVE_INFINITY }),
      reading({ tabId: 2, status: "waiting", progress: Number.NEGATIVE_INFINITY }),
    ]);
    expect(result).toEqual([]);
  });

  it("excludes progress outside [0, 1]", () => {
    const result = rank([
      reading({ tabId: 1, status: "waiting", progress: -0.01 }),
      reading({ tabId: 2, status: "waiting", progress: 1.01 }),
    ]);
    expect(result).toEqual([]);
  });

  it("includes progress exactly at the boundaries 0 and 1", () => {
    const result = rank([
      reading({ tabId: 1, status: "waiting", progress: 0 }),
      reading({ tabId: 2, status: "waiting", progress: 1 }),
    ]);
    expect(result).toHaveLength(2);
  });

  it("sorts by descending progress with ascending tabId tie-break, assigns competition places and scores", () => {
    const readings = [
      reading({ tabId: 30, status: "waiting", progress: 0.4 }),
      reading({ tabId: 10, status: "waiting", progress: 0.9 }),
      reading({ tabId: 20, status: "waiting", progress: 0.9 }),
      reading({ tabId: 40, status: "waiting", progress: 0.2 }),
    ];
    const result = rank(readings);
    expect(result.map((r) => r.tabId)).toEqual([10, 20, 30, 40]);
    expect(result.map((r) => r.place)).toEqual([1, 1, 3, 4]);
    // max progress is 0.9 -> score 100 for the tied leaders.
    expect(result[0]?.score).toBe(100);
    expect(result[1]?.score).toBe(100);
    // 0.4 / 0.9 * 100 = 44.44... -> rounds to 44.
    expect(result[2]?.score).toBe(44);
    // 0.2 / 0.9 * 100 = 22.22... -> rounds to 22.
    expect(result[3]?.score).toBe(22);
  });

  it("gives equal progress the same place and skips ahead for the next distinct value (competition ranking)", () => {
    const readings = [
      reading({ tabId: 1, status: "waiting", progress: 0.8 }),
      reading({ tabId: 2, status: "waiting", progress: 0.8 }),
      reading({ tabId: 3, status: "waiting", progress: 0.8 }),
      reading({ tabId: 4, status: "waiting", progress: 0.1 }),
    ];
    const result = rank(readings);
    expect(result.map((r) => r.place)).toEqual([1, 1, 1, 4]);
  });

  it("keeps stable deterministic tie ordering by ascending tabId across repeated calls", () => {
    const readings = [
      reading({ tabId: 5, status: "waiting", progress: 0.5 }),
      reading({ tabId: 3, status: "waiting", progress: 0.5 }),
      reading({ tabId: 4, status: "waiting", progress: 0.5 }),
    ];
    const first = rank(readings).map((r) => r.tabId);
    const second = rank(readings).map((r) => r.tabId);
    expect(first).toEqual([3, 4, 5]);
    expect(second).toEqual([3, 4, 5]);
  });

  it("scores null for every reading when all participating progress is zero, but still assigns place", () => {
    const readings = [
      reading({ tabId: 1, status: "waiting", progress: 0 }),
      reading({ tabId: 2, status: "waiting", progress: 0 }),
    ];
    const result = rank(readings);
    expect(result.map((r) => r.score)).toEqual([null, null]);
    expect(result.map((r) => r.place)).toEqual([1, 1]);
  });

  it("does not mutate the input array or its readings", () => {
    const original = [
      reading({ tabId: 2, status: "waiting", progress: 0.3 }),
      reading({ tabId: 1, status: "waiting", progress: 0.7 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    rank(original);
    expect(original).toEqual(snapshot);
  });

  it("never renumbers or drops tabId", () => {
    const readings = [
      reading({ tabId: 101, status: "waiting", progress: 0.6 }),
      reading({ tabId: 202, status: "waiting", progress: 0.3 }),
    ];
    const result = rank(readings);
    expect(result.map((r) => r.tabId)).toEqual([101, 202]);
  });
});

describe("readyTabs", () => {
  it("returns empty for empty input", () => {
    expect(readyTabs([])).toEqual([]);
  });

  it("selects only ready status, sorted ascending by tabId", () => {
    const readings = [
      reading({ tabId: 30, status: "ready", progress: 1 }),
      reading({ tabId: 10, status: "ready", progress: 1 }),
      reading({ tabId: 20, status: "waiting", progress: 0.5 }),
    ];
    const result = readyTabs(readings);
    expect(result.map((r) => r.tabId)).toEqual([10, 30]);
  });

  it("does not mutate the input array", () => {
    const original = [
      reading({ tabId: 2, status: "ready", progress: 1 }),
      reading({ tabId: 1, status: "ready", progress: 1 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    readyTabs(original);
    expect(original).toEqual(snapshot);
  });

  it("a ready tab mixed with waiting tabs is excluded from rank() but present in readyTabs()", () => {
    const readings = [
      reading({ tabId: 1, status: "ready", progress: 1 }),
      reading({ tabId: 2, status: "waiting", progress: 0.5 }),
    ];
    expect(rank(readings).map((r) => r.tabId)).toEqual([2]);
    expect(readyTabs(readings).map((r) => r.tabId)).toEqual([1]);
  });
});
