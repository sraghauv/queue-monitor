/**
 * Shared data contracts. `unknown`, `error` and `closed` are deliberately
 * distinct from progress 0 — an unread tab is not a tab at the back of the
 * queue.
 */

export type TabStatus = "loading" | "waiting" | "ready" | "unknown" | "error" | "closed";

/** A single observation of one tab. `seq` is monotonic per session. */
export type QueueReading = {
  readonly tabId: number;
  readonly status: TabStatus;
  /** Normalized 0..1, or null when no trustworthy value was observed. */
  readonly progress: number | null;
  readonly readAt: number | null;
  readonly seq: number;
  /** Round-trip latency of the read that produced this reading, in ms. */
  readonly latencyMs?: number;
  /** Identifier of the adapter that parsed the page, when one matched. */
  readonly adapter?: string;
  readonly error?: string;
};

export type SessionState = "idle" | "starting" | "monitoring" | "paused" | "stopped";

export type Session = {
  readonly id: string;
  readonly url: string;
  readonly state: SessionState;
  readonly requestedCount: number;
  /** Numeric browser tab IDs, in creation order. Order is not rank. */
  readonly tabIds: readonly number[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Highest sequence number issued so far. */
  readonly seq: number;
};

export type RankedReading = QueueReading & {
  /** 1-based position among valid waiting readings. */
  readonly place: number;
  /** 0..100 relative to the best observed progress, or null when unrankable. */
  readonly score: number | null;
};

export type Metrics = {
  readonly readsPerSecond: number | null;
  readonly meanLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  /** Fraction (0..1) of tracked tabs whose latest reading is stale or failed. */
  readonly staleFraction: number | null;
  readonly roundDurationMs: number | null;
  readonly lastRoundAt: number | null;
  readonly roundsCompleted: number;
};

export const EMPTY_METRICS: Metrics = {
  readsPerSecond: null,
  meanLatencyMs: null,
  p95LatencyMs: null,
  staleFraction: null,
  roundDurationMs: null,
  lastRoundAt: null,
  roundsCompleted: 0,
};

/** Everything the popup needs for one render. */
export type Snapshot = {
  readonly session: Session | null;
  /** Latest accepted reading per tracked tab, in tab-creation order. */
  readonly readings: readonly QueueReading[];
  /** Ranked view of the waiting readings. Tabs absent here are not waiting. */
  readonly ranked: readonly RankedReading[];
  /** Tabs whose latest reading is `ready`, i.e. top priority. */
  readonly ready: readonly QueueReading[];
  readonly metrics: Metrics;
  readonly takenAt: number;
  /** Most recent command failure, surfaced once to the UI. */
  readonly lastError: string | null;
};
