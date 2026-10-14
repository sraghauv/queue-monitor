/**
 * Ranking of queue readings. This module is pure: it never mutates its
 * input, never touches `chrome`, and performs no I/O.
 *
 * Design note: the 0..100 `score` produced by `rank` is an original,
 * self-contained normalization — "100 means the best progress observed in
 * THIS session, among the tabs we actually read." It is NOT a probability
 * of getting tickets, and it is NOT a reconstruction of any queue vendor's
 * internal ranking formula. It exists purely so a user can compare the tabs
 * they opened against each other.
 */

import type { QueueReading, RankedReading } from "./types.js";

/**
 * Returns the subset of `readings` eligible to be ranked: `status ===
 * "waiting"` with a finite, in-range `progress`. Everything else (loading,
 * ready, unknown, error, closed, null/NaN/Infinity progress, or progress
 * outside [0, 1]) is excluded entirely — it is never "ranked last".
 *
 * Sorted by `progress` descending, tie-broken by ascending `tabId` so the
 * output order is deterministic across runs.
 *
 * `place` uses competition ranking ("1224" style): readings that share the
 * same `progress` share the same `place`, and the next distinct progress
 * value jumps to `1 + (number of readings strictly ahead of it)` rather than
 * incrementing by one. E.g. progresses 0.9, 0.9, 0.5 produce places 1, 1, 3.
 *
 * `score` is `Math.round((progress / max) * 100)` where `max` is the best
 * participating progress, EXCEPT when every participating progress is 0 —
 * in that case every `score` is `null`, not 0, because there is no
 * meaningful relative signal to normalize against. `place` is still
 * assigned in that case.
 */
export function rank(readings: readonly QueueReading[]): RankedReading[] {
  const eligible = readings.filter((r) => isRankable(r));

  // `Array#toSorted` would avoid the mutation lint rule outright, but the
  // repo's `tsconfig.json` lib target (ES2022) predates it, and that file is
  // not ours to change. `eligible` is a fresh array from `filter` above, so
  // sorting it in place never touches the caller's input.
  // oxlint-disable-next-line unicorn/no-array-sort
  const sorted = eligible.sort((a, b) => {
    // Cast is safe: `isRankable` guarantees `progress` is a finite number
    // for every entry in `eligible`.
    const progressDiff = (b.progress as number) - (a.progress as number);
    if (progressDiff !== 0) return progressDiff;
    return a.tabId - b.tabId;
  });

  const max = sorted.reduce((best, r) => Math.max(best, r.progress as number), 0);

  const result: RankedReading[] = [];
  let place = 0;
  let seen = 0;
  let previousProgress: number | null = null;

  for (const r of sorted) {
    const progress = r.progress as number;
    seen += 1;
    if (previousProgress === null || progress !== previousProgress) {
      place = seen;
      previousProgress = progress;
    }
    const score = max > 0 ? Math.round((progress / max) * 100) : null;
    result.push({ ...r, place, score });
  }

  return result;
}

/** Ready tabs, sorted by ascending `tabId`. Never given a numeric score. */
export function readyTabs(readings: readonly QueueReading[]): QueueReading[] {
  // Same note as above: sorting a fresh array from `filter`, not the input.
  // oxlint-disable-next-line unicorn/no-array-sort
  return readings.filter((r) => r.status === "ready").sort((a, b) => a.tabId - b.tabId);
}

function isRankable(reading: QueueReading): boolean {
  return (
    reading.status === "waiting" &&
    reading.progress !== null &&
    Number.isFinite(reading.progress) &&
    reading.progress >= 0 &&
    reading.progress <= 1
  );
}
