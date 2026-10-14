/**
 * Pure, testable formatting for the popup. No DOM, no `chrome` namespace.
 *
 * The single rule every function here obeys: an unknown value must look
 * unknown. `null` never renders as `0`, `NaN`, `Infinity`, or an empty
 * string — each of those would read as a confident, current number when
 * there isn't one, which AGENTS.md calls the worst failure this UI can
 * ship ("Unknown is not zero").
 */

import type { Metrics, TabStatus } from "../domain/types.js";

/**
 * Age of a reading, humanized. `null` -> "never" (no reading has ever
 * happened — a distinct fact from "0 seconds ago"). Otherwise buckets into
 * seconds / minutes / hours, always rounding down so "2m ago" means at
 * least 2 full minutes have elapsed.
 */
export function formatAge(ms: number | null): string {
  if (ms === null) return "never";
  if (ms < 0) return "just now";
  if (ms < 1000) return "just now";

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/** `null` -> "—" (unknown, never 0%). Otherwise a whole-percent string. */
export function formatProgress(progress: number | null): string {
  if (progress === null || !Number.isFinite(progress)) return "—";
  return `${Math.round(progress * 100)}%`;
}

/** `null` -> "—" (unranked, never 0). Otherwise the rounded 0..100 score. */
export function formatScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "—";
  return `${Math.round(score)}`;
}

/** `null` rate -> "—" (no basis for a rate yet, never 0 reads/s). */
export function formatThroughput(metrics: Metrics): string {
  const rate = metrics.readsPerSecond;
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${rate.toFixed(1)} reads/s`;
}

/**
 * Describes overall data freshness: the fraction of tracked tabs whose
 * latest reading is stale or failed, plus how long ago the last polling
 * round finished. `null` staleFraction -> "no readings yet" since there is
 * no basis for a fraction (AGENTS.md: a stale reading is never presented as
 * current, and "no data" is never presented as "0% stale").
 */
export function formatFreshness(metrics: Metrics): string {
  const { staleFraction, lastRoundAt } = metrics;
  if (staleFraction === null) return "no readings yet";

  const percentStale = Math.round(staleFraction * 100);
  const lastRoundAge = lastRoundAt === null ? "never" : formatAge(Date.now() - lastRoundAt);
  return `${percentStale}% stale · last round ${lastRoundAge}`;
}

const STATUS_LABELS: Readonly<Record<TabStatus, string>> = {
  loading: "Loading",
  waiting: "Waiting",
  ready: "Ready",
  unknown: "Unknown",
  error: "Read error",
  closed: "Tab closed",
};

/** Human-readable label for a `TabStatus`. */
export function statusLabel(status: TabStatus): string {
  return STATUS_LABELS[status];
}
