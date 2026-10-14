import { describe, expect, it } from "vitest";

import { computeMetrics, percentile } from "../../src/app/metrics.js";
import type { RoundResult } from "../../src/app/poller.js";
import { EMPTY_METRICS } from "../../src/domain/types.js";
import { reading } from "../support/fakePlatform.js";

function makeRound(overrides: Partial<RoundResult> = {}): RoundResult {
  return {
    readings: [],
    accepted: 0,
    rejectedStale: 0,
    failed: 0,
    startedAt: 1_000_000,
    finishedAt: 1_000_000,
    nextSeq: 1,
    ...overrides,
  };
}

describe("percentile", () => {
  it("returns null for an empty array", () => {
    expect(percentile([], 95)).toBeNull();
  });

  it("returns the only value for a single-element array", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("uses nearest-rank on a known array", () => {
    const values = [1, 2, 3, 4, 5];
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 95)).toBe(5);
    expect(percentile(values, 0)).toBe(1);
  });

  it("does not mutate the input array", () => {
    const values = [5, 3, 1, 4, 2];
    const copy = [...values];
    percentile(values, 95);
    expect(values).toEqual(copy);
  });
});

describe("computeMetrics", () => {
  it("returns null readsPerSecond for a zero-duration round, never Infinity", () => {
    const round = makeRound({ accepted: 5, startedAt: 2_000, finishedAt: 2_000 });
    const metrics = computeMetrics({
      round,
      readings: [],
      now: 2_000,
      previous: EMPTY_METRICS,
    });
    expect(metrics.readsPerSecond).toBeNull();
    expect(metrics.readsPerSecond).not.toBe(Infinity);
  });

  it("computes readsPerSecond from accepted reads over round duration", () => {
    // 2s duration.
    const round = makeRound({ accepted: 10, startedAt: 1_000, finishedAt: 3_000 });
    const metrics = computeMetrics({
      round,
      readings: [],
      now: 3_000,
      previous: EMPTY_METRICS,
    });
    expect(metrics.readsPerSecond).toBe(5);
  });

  it("increments roundsCompleted from previous", () => {
    const round = makeRound();
    const metrics = computeMetrics({
      round,
      readings: [],
      now: 1_000_000,
      previous: { ...EMPTY_METRICS, roundsCompleted: 7 },
    });
    expect(metrics.roundsCompleted).toBe(8);
  });

  it("returns null mean and p95 latency when no reading has latencyMs", () => {
    const round = makeRound({
      readings: [reading({ tabId: 1, status: "waiting", progress: 0.5 })],
    });
    const metrics = computeMetrics({
      round,
      readings: round.readings,
      now: 1_000_000,
      previous: EMPTY_METRICS,
    });
    expect(metrics.meanLatencyMs).toBeNull();
    expect(metrics.p95LatencyMs).toBeNull();
  });

  it("computes mean and p95 latency from this round's readings only", () => {
    const round = makeRound({
      readings: [
        reading({ tabId: 1, latencyMs: 10 }),
        reading({ tabId: 2, latencyMs: 20 }),
        reading({ tabId: 3, latencyMs: 30 }),
      ],
    });
    const metrics = computeMetrics({
      round,
      readings: round.readings,
      now: 1_000_000,
      previous: EMPTY_METRICS,
    });
    expect(metrics.meanLatencyMs).toBe(20);
    expect(metrics.p95LatencyMs).toBe(30);
  });

  it("derives staleFraction from the full readings set via src/domain/readings.js", () => {
    const now = 2_000_000;
    const round = makeRound();
    const freshReading = reading({ tabId: 1, status: "waiting", readAt: now });
    const staleReading = reading({ tabId: 2, status: "error", readAt: now });
    const metrics = computeMetrics({
      round,
      readings: [freshReading, staleReading],
      now,
      previous: EMPTY_METRICS,
    });
    expect(metrics.staleFraction).toBe(0.5);
  });

  it("sets roundDurationMs and lastRoundAt from the round", () => {
    const round = makeRound({ startedAt: 5_000, finishedAt: 5_750 });
    const metrics = computeMetrics({
      round,
      readings: [],
      now: 5_750,
      previous: EMPTY_METRICS,
    });
    expect(metrics.roundDurationMs).toBe(750);
    expect(metrics.lastRoundAt).toBe(5_750);
  });
});
