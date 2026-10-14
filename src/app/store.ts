/**
 * Storage workflow: loading, persisting, and reconciling sessions and
 * readings against the live set of browser tabs. Depends on `src/domain/`
 * and on `src/platform/browser.js` interfaces only, per AGENTS.md
 * Architecture layering.
 */

import { closeReading, latestByTab, orderByTabIds } from "../domain/readings.js";
import { removeTabIds } from "../domain/session.js";
import type { AppError } from "../domain/errors.js";
import { isErr, ok, type Result } from "../domain/result.js";
import type { QueueReading, Session } from "../domain/types.js";
import type { Clock, StoragePort, TabsPort } from "../platform/browser.js";

export type LoadedState = {
  readonly session: Session | null;
  readonly readings: readonly QueueReading[];
  /** Non-fatal problems hit while loading; the caller surfaces these. */
  readonly problems: readonly AppError[];
};

export type ReconcileResult = {
  readonly session: Session | null;
  readonly readings: readonly QueueReading[];
  /** Tracked tab IDs that no longer exist in the browser. */
  readonly removed: readonly number[];
};

export type Store = {
  load(): Promise<LoadedState>;
  saveSession(session: Session | null): Promise<Result<void, AppError>>;
  saveReadings(readings: readonly QueueReading[]): Promise<Result<void, AppError>>;
  save(session: Session | null, readings: readonly QueueReading[]): Promise<Result<void, AppError>>;
  /** Drops tab IDs the browser no longer has and marks their readings closed. */
  reconcile(session: Session | null, readings: readonly QueueReading[]): Promise<ReconcileResult>;
  clear(): Promise<Result<void, AppError>>;
};

/** Keeps only the latest reading per tab, so storage never grows per round. */
function dedupeByTab(readings: readonly QueueReading[]): QueueReading[] {
  return [...latestByTab(readings).values()];
}

export function createStore(deps: { storage: StoragePort; tabs: TabsPort; clock: Clock }): Store {
  const { storage, tabs, clock } = deps;

  async function load(): Promise<LoadedState> {
    const problems: AppError[] = [];

    const sessionResult = await storage.readSession();
    const session = sessionResult.ok ? sessionResult.value : null;
    if (!sessionResult.ok) {
      // A failed read is a problem to surface; a successful read of "no
      // session" is a normal state, not a problem.
      problems.push(sessionResult.error);
    }

    const readingsResult = await storage.readReadings();
    const rawReadings = readingsResult.ok ? readingsResult.value : [];
    if (!readingsResult.ok) {
      problems.push(readingsResult.error);
    }

    // Discard readings that belong to no tracked tab. With no session at
    // all, every reading is an orphan: there is nothing for it to belong
    // to, and rendering it would be a lie about current state.
    const trackedIds = new Set(session?.tabIds ?? []);
    const readings =
      session === null ? [] : rawReadings.filter((reading) => trackedIds.has(reading.tabId));

    return { session, readings, problems };
  }

  async function saveSession(session: Session | null): Promise<Result<void, AppError>> {
    return storage.writeSession(session);
  }

  async function saveReadings(readings: readonly QueueReading[]): Promise<Result<void, AppError>> {
    return storage.writeReadings(dedupeByTab(readings));
  }

  async function save(
    session: Session | null,
    readings: readonly QueueReading[],
  ): Promise<Result<void, AppError>> {
    // Session first, then readings, regardless of whether the first write
    // failed: a failed session write must not silently leave readings
    // unsaved with no record of why, so we still attempt the readings
    // write and report whichever error came first.
    const sessionResult = await saveSession(session);
    const readingsResult = await saveReadings(readings);
    if (isErr(sessionResult)) return sessionResult;
    if (isErr(readingsResult)) return readingsResult;
    return ok(undefined);
  }

  async function reconcile(
    session: Session | null,
    readings: readonly QueueReading[],
  ): Promise<ReconcileResult> {
    if (session === null) {
      return { session: null, readings: [], removed: [] };
    }

    // Pure-ish query: reconcile never writes to storage. The caller decides
    // whether/when to persist the result, so a read-only reconcile can be
    // called freely (e.g. before every render) without side effects.
    const liveIds = await tabs.listIds();
    const liveSet = new Set(liveIds);
    const removed = session.tabIds.filter((tabId) => !liveSet.has(tabId));
    const latest = latestByTab(readings);

    if (removed.length === 0) {
      return {
        session,
        readings: orderByTabIds([...latest.values()], session.tabIds),
        removed: [],
      };
    }

    const now = clock.now();
    const nextSession = removeTabIds(session, removed, now);

    const survivingReadings = orderByTabIds([...latest.values()], nextSession.tabIds);
    const closedReadings = removed
      .map((tabId) => latest.get(tabId))
      .filter((reading): reading is QueueReading => reading !== undefined)
      .map((reading) => closeReading(reading, now));

    return {
      session: nextSession,
      readings: [...survivingReadings, ...closedReadings],
      removed,
    };
  }

  async function clear(): Promise<Result<void, AppError>> {
    return save(null, []);
  }

  return { load, saveSession, saveReadings, save, reconcile, clear };
}
