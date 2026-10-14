/**
 * Pure helpers for reasoning about `QueueReading` staleness, merging, and
 * ordering. No `chrome` namespace, no DOM, no I/O.
 */

import type { QueueReading } from "./types.js";

/** Default staleness window for `isStale`/`staleFraction`. */
export const STALE_AFTER_MS = 15_000;

/**
 * Age of a reading relative to `now`, in ms. `null` when the tab has never
 * been read (`readAt === null`) — unknown age, never age 0. A clock that
 * moved backwards (or an optimistic local `now`) never yields a negative
 * age; it floors at 0.
 */
export function ageMs(reading: QueueReading, now: number): number | null {
  if (reading.readAt === null) return null;
  return Math.max(0, now - reading.readAt);
}

/**
 * A reading is stale when: it has never been read (`readAt === null`); its
 * status is `error` or `closed` (both are explicitly untrustworthy, never
 * "current"); or its age exceeds `staleAfterMs`. Exactly at the boundary
 * (`age === staleAfterMs`) is NOT stale — only strictly greater is.
 */
export function isStale(
  reading: QueueReading,
  now: number,
  staleAfterMs: number = STALE_AFTER_MS,
): boolean {
  if (reading.readAt === null) return true;
  if (reading.status === "error" || reading.status === "closed") return true;
  const age = ageMs(reading, now);
  if (age === null) return true;
  return age > staleAfterMs;
}

/**
 * Fraction (0..1) of `readings` that are stale. `null` for an empty input —
 * there is no basis for a fraction, which is a distinct fact from "0% are
 * stale".
 */
export function staleFraction(
  readings: readonly QueueReading[],
  now: number,
  staleAfterMs: number = STALE_AFTER_MS,
): number | null {
  if (readings.length === 0) return null;
  const staleCount = readings.filter((r) => isStale(r, now, staleAfterMs)).length;
  return staleCount / readings.length;
}

/**
 * The sequence guard required by AGENTS.md: a response whose `seq` is not
 * strictly greater than the one already accepted for that tab is
 * discarded, not merged. Returns `incoming` only when there is no prior
 * reading, or `incoming.seq > prior.seq`; otherwise returns `prior`
 * unchanged. Fields are never blended across the two.
 */
export function mergeReading(
  prior: QueueReading | undefined,
  incoming: QueueReading,
): QueueReading {
  if (prior === undefined) return incoming;
  if (incoming.seq > prior.seq) return incoming;
  return prior;
}

/**
 * Merges `incoming` readings into `prior` per `tabId`, using `mergeReading`
 * for each tab. Preserves the order tabs appear in `prior`; genuinely new
 * tabs (present in `incoming` but not `prior`) are appended at the end, in
 * the order they first appear in `incoming`.
 */
export function mergeReadings(
  prior: readonly QueueReading[],
  incoming: readonly QueueReading[],
): QueueReading[] {
  const incomingByTab = latestByTab(incoming);
  const priorTabIds = new Set(prior.map((r) => r.tabId));

  const merged = prior.map((priorReading) => {
    const incomingReading = incomingByTab.get(priorReading.tabId);
    return incomingReading === undefined
      ? priorReading
      : mergeReading(priorReading, incomingReading);
  });

  const appendedTabIds = new Set<number>();
  for (const incomingReading of incoming) {
    const tabId = incomingReading.tabId;
    if (priorTabIds.has(tabId) || appendedTabIds.has(tabId)) continue;
    appendedTabIds.add(tabId);
    // A tab not present in `prior` has no prior reading to guard against;
    // take the latest one seen for it in `incoming`.
    merged.push(incomingByTab.get(tabId) as QueueReading);
  }

  return merged;
}

/**
 * Builds a map of the latest (highest-`seq`) reading per `tabId` within a
 * single list. On a `seq` tie, the earlier-occurring entry wins, matching
 * `mergeReading`'s "incoming must be strictly greater" rule.
 */
export function latestByTab(readings: readonly QueueReading[]): Map<number, QueueReading> {
  const map = new Map<number, QueueReading>();
  for (const reading of readings) {
    const existing = map.get(reading.tabId);
    map.set(reading.tabId, mergeReading(existing, reading));
  }
  return map;
}

/**
 * Returns one reading per id in `tabIds` order, skipping ids with no
 * matching reading. Used so the UI table order follows tracked tab order,
 * not rank.
 */
export function orderByTabIds(
  readings: readonly QueueReading[],
  tabIds: readonly number[],
): QueueReading[] {
  const byTab = new Map(readings.map((r) => [r.tabId, r] as const));
  const result: QueueReading[] = [];
  for (const tabId of tabIds) {
    const r = byTab.get(tabId);
    if (r !== undefined) result.push(r);
  }
  return result;
}

/**
 * Closes a reading: `status: "closed"`, `progress: null`, `readAt: now`.
 * `tabId` and `seq` are preserved. The prior numeric progress is
 * deliberately dropped — keeping it would read as a live value for a tab
 * that is no longer being observed.
 */
export function closeReading(reading: QueueReading, now: number): QueueReading {
  return {
    ...reading,
    status: "closed",
    progress: null,
    readAt: now,
  };
}
