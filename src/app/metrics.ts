/**
 * Metrics workflow: turns one `RoundResult` plus the current readings into
 * the `Metrics` the popup renders. Depends on `src/domain/` and `RoundResult`
 * from `src/app/poller.js` only — no `chrome` namespace, no I/O.
 *
 * Freshness arithmetic the guide calls out: at ~5 reads/s with concurrency 4
 * and a 2s timeout, a full round over 100 tabs takes roughly
 * 100 / 5 ≈ 20 seconds. Any score or rank shown to the user must be read
 * next to that number — a reading that is tens of seconds old is not "now".
 */

import { staleFraction, STALE_AFTER_MS } from "../domain/readings.js";
import type { Metrics, QueueReading } from "../domain/types.js";
import type { RoundResult } from "./poller.js";

/**
 * Nearest-rank percentile over a sorted copy of `values`. Does not mutate
 * the input. `null` for an empty input — there is no percentile of nothing.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  // Sorting a fresh copy, never the caller's input.
  // oxlint-disable-next-line unicorn/no-array-sort
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  const value = sorted[index];
  return value === undefined ? null : value;
}

export function computeMetrics(args: {
  round: RoundResult;
  readings: readonly QueueReading[];
  now: number;
  previous: Metrics;
  staleAfterMs?: number;
}): Metrics {
  const { round, readings, now, previous } = args;
  const staleAfterMs = args.staleAfterMs ?? STALE_AFTER_MS;

  const roundDurationMs = round.finishedAt - round.startedAt;

  // A zero-duration round is an immeasurably fast round, not an infinitely
  // fast one: `null` (unknown rate) rather than `Infinity`, which would
  // otherwise poison any average or chart that consumes this value.
  const readsPerSecond = roundDurationMs > 0 ? round.accepted / (roundDurationMs / 1000) : null;

  const latencies: number[] = [];
  for (const reading of round.readings) {
    if (reading.latencyMs !== undefined) latencies.push(reading.latencyMs);
  }

  const meanLatencyMs =
    latencies.length > 0 ? latencies.reduce((sum, v) => sum + v, 0) / latencies.length : null;
  const p95LatencyMs = percentile(latencies, 95);

  return {
    readsPerSecond,
    meanLatencyMs,
    p95LatencyMs,
    staleFraction: staleFraction(readings, now, staleAfterMs),
    roundDurationMs,
    lastRoundAt: round.finishedAt,
    roundsCompleted: previous.roundsCompleted + 1,
  };
}
