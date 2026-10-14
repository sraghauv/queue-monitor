/**
 * Polling workflow: reads a round of tabs with bounded concurrency, per-tab
 * timeouts, and sequence-number protection against out-of-order responses.
 * Depends on `src/domain/` and on `src/platform/browser.js` interfaces only,
 * per AGENTS.md Architecture layering.
 */

import { READ_QUEUE } from "../domain/messages.js";
import { latestByTab, mergeReading } from "../domain/readings.js";
import type { AppError } from "../domain/errors.js";
import { detailOf } from "../domain/errors.js";
import type { QueueReading } from "../domain/types.js";
import type { Clock, TabsPort } from "../platform/browser.js";

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 2_000;

export type RoundResult = {
  /** Latest accepted reading per tab, merged over `prior`. */
  readonly readings: readonly QueueReading[];
  readonly accepted: number;
  /** Responses discarded because their seq was not newer. */
  readonly rejectedStale: number;
  readonly failed: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  /**
   * The highest sequence number issued this round. Callers persist it and pass
   * it straight back as the next round's `seq`; returning one past it would
   * skip a number on every round.
   */
  readonly nextSeq: number;
};

export type Poller = {
  runRound(args: {
    tabIds: readonly number[];
    prior: readonly QueueReading[];
    seq: number;
  }): Promise<RoundResult>;
  /** True while a round is in flight. */
  isRunning(): boolean;
};

/** Builds the short, safe string stored on an "error" reading. */
function describeReadError(error: AppError): string {
  switch (error.kind) {
    case "read-timeout":
      return "read-timeout";
    case "read-failed":
      return `read-failed: ${error.detail}`;
    case "malformed-message":
      return `malformed-message: ${error.detail}`;
    default:
      return error.kind;
  }
}

/**
 * Converts one read attempt's outcome into a candidate `QueueReading`. Never
 * reuses a prior numeric progress: every branch sets `progress` explicitly,
 * `null` unless a fresh successful read supplied a number.
 */
function buildCandidate(
  tabId: number,
  issuedSeq: number,
  outcome:
    | {
        ok: true;
        status: QueueReading["status"];
        progress: number | null;
        seq: number;
        adapter: string | null;
      }
    | { ok: false; error: AppError },
  readAt: number,
  latencyMs: number,
): QueueReading {
  if (outcome.ok) {
    return {
      tabId,
      status: outcome.status,
      progress: outcome.progress,
      readAt,
      seq: outcome.seq,
      latencyMs,
      ...(outcome.adapter === null ? {} : { adapter: outcome.adapter }),
    };
  }

  const { error } = outcome;
  if (error.kind === "tab-missing") {
    // A closed tab is a known state, not a failure: status "closed", not
    // "error". Progress is dropped, never carried over from a prior reading.
    return {
      tabId,
      status: "closed",
      progress: null,
      readAt,
      seq: issuedSeq,
      latencyMs,
    };
  }

  return {
    tabId,
    status: "error",
    progress: null,
    readAt,
    seq: issuedSeq,
    latencyMs,
    error: describeReadError(error),
  };
}

export function createPoller(deps: {
  tabs: TabsPort;
  clock: Clock;
  concurrency?: number;
  timeoutMs?: number;
}): Poller {
  const { tabs, clock } = deps;
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let inFlightRound: Promise<RoundResult> | null = null;

  /** One read attempt for one tab: never throws, always yields a candidate. */
  async function attemptRead(
    tabId: number,
    issuedSeq: number,
  ): Promise<{ candidate: QueueReading; succeeded: boolean }> {
    const attemptStart = clock.now();
    try {
      const result = await tabs.read(tabId, { type: READ_QUEUE, seq: issuedSeq }, timeoutMs);
      const attemptFinish = clock.now();
      const latencyMs = attemptFinish - attemptStart;
      if (result.ok) {
        const candidate = buildCandidate(
          tabId,
          issuedSeq,
          {
            ok: true,
            status: result.value.status,
            progress: result.value.progress,
            seq: result.value.seq,
            adapter: result.value.adapter,
          },
          attemptFinish,
          latencyMs,
        );
        return { candidate, succeeded: true };
      }
      const candidate = buildCandidate(
        tabId,
        issuedSeq,
        { ok: false, error: result.error },
        attemptFinish,
        latencyMs,
      );
      return { candidate, succeeded: result.error.kind === "tab-missing" };
    } catch (cause) {
      // Defensive: TabsPort must never throw, but the poller itself must
      // never throw either. A thrown value becomes an "error" reading.
      const attemptFinish = clock.now();
      const candidate = buildCandidate(
        tabId,
        issuedSeq,
        { ok: false, error: { kind: "read-failed", tabId, detail: detailOf(cause) } },
        attemptFinish,
        attemptFinish - attemptStart,
      );
      return { candidate, succeeded: false };
    }
  }

  async function executeRound(args: {
    tabIds: readonly number[];
    prior: readonly QueueReading[];
    seq: number;
  }): Promise<RoundResult> {
    const { tabIds, prior, seq } = args;
    const startedAt = clock.now();

    // Only tabs in this round's tabIds carry a prior reading forward;
    // readings for untracked tabs are dropped per requirement 8.
    const trackedPrior = prior.filter((reading) => tabIds.includes(reading.tabId));
    const priorByTab = latestByTab(trackedPrior);

    const results: QueueReading[] = Array.from({ length: tabIds.length });
    let accepted = 0;
    let rejectedStale = 0;
    let failed = 0;
    let nextSeqCounter = seq;
    let cursor = 0;

    async function worker(): Promise<void> {
      while (cursor < tabIds.length) {
        const index = cursor;
        cursor += 1;
        const tabId = tabIds[index] as number;

        nextSeqCounter += 1;
        const issuedSeq = nextSeqCounter;

        const { candidate, succeeded } = await attemptRead(tabId, issuedSeq);

        const priorReading = priorByTab.get(tabId);
        const merged = mergeReading(priorReading, candidate);
        if (merged === candidate) {
          results[index] = candidate;
          if (succeeded) accepted += 1;
          else failed += 1;
        } else {
          // Out-of-order: the response's seq was not newer than the one
          // already accepted for this tab. Keep the prior reading.
          rejectedStale += 1;
          results[index] = priorReading as QueueReading;
        }
      }
    }

    const workerCount = Math.min(concurrency, tabIds.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i += 1) workers.push(worker());
    await Promise.all(workers);

    const finishedAt = clock.now();
    return {
      readings: results,
      accepted,
      rejectedStale,
      failed,
      startedAt,
      finishedAt,
      nextSeq: nextSeqCounter,
    };
  }

  function runRound(args: {
    tabIds: readonly number[];
    prior: readonly QueueReading[];
    seq: number;
  }): Promise<RoundResult> {
    if (inFlightRound !== null) return inFlightRound;
    const promise = executeRound(args).finally(() => {
      if (inFlightRound === promise) inFlightRound = null;
    });
    inFlightRound = promise;
    return promise;
  }

  function isRunning(): boolean {
    return inFlightRound !== null;
  }

  return { runRound, isRunning };
}
