/**
 * Projects coordinator state into the single contract the popup renders from.
 *
 * Kept separate from the coordinator so the projection — which decides what the
 * user is actually shown — can be read and tested on its own. Row order here is
 * tracked-tab order; rank is carried alongside and never applied to the rows.
 */

import { rank, readyTabs } from "../domain/rank.js";
import { orderByTabIds } from "../domain/readings.js";
import type { Metrics, QueueReading, Session, Snapshot } from "../domain/types.js";

export function projectSnapshot(args: {
  session: Session | null;
  readings: readonly QueueReading[];
  metrics: Metrics;
  lastError: string | null;
  now: number;
}): Snapshot {
  const ordered = orderRows(args.session, args.readings);
  return {
    session: args.session,
    readings: ordered,
    ranked: rank(ordered),
    ready: readyTabs(ordered),
    metrics: args.metrics,
    takenAt: args.now,
    lastError: args.lastError,
  };
}

/**
 * Tracked tabs in creation order, then any reading whose tab is no longer
 * tracked — a tab the user closed.
 *
 * Those trailing rows matter: a session that opened five tabs and now tracks
 * three should show two closed rows, not quietly render three and let the user
 * believe that is all there ever were. Reconciliation has already stripped
 * their numeric progress, so they display as closed rather than as live data.
 */
function orderRows(
  session: Session | null,
  readings: readonly QueueReading[],
): readonly QueueReading[] {
  if (!session) return [];
  const tracked = orderByTabIds(readings, session.tabIds);
  const trackedIds = new Set(session.tabIds);
  const detached = readings.filter((reading) => !trackedIds.has(reading.tabId));
  return detached.length > 0 ? [...tracked, ...detached] : tracked;
}
