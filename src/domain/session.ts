/**
 * Session state machine. This module is pure: it never mutates its input,
 * never touches `chrome`, and performs no I/O.
 *
 * `PAUSE` while paused, `RESUME` while monitoring, `STOP` while stopped, and
 * `ACTIVATE` while monitoring are idempotent no-ops per AGENTS.md
 * "Idempotent commands" — they succeed and leave state unchanged rather than
 * erroring. Every other command pair not in the table below is a genuinely
 * invalid transition and returns `err({ kind: "invalid-transition", ... })`.
 */

import type { Result } from "./result.js";
import { err, ok } from "./result.js";
import type { AppError } from "./errors.js";
import type { Session, SessionState } from "./types.js";

export type SessionCommand = "START" | "ACTIVATE" | "PAUSE" | "RESUME" | "STOP";

/**
 * The transition table. Each `from` state maps commands to a destination
 * state; a command absent from a state's entry is invalid for that state.
 * Kept as data (not a switch) so AGENTS.md changes to this table stay a
 * one-line diff, and so `canTransition`/`nextState` cannot disagree.
 */
const TRANSITIONS: Readonly<
  Record<SessionState, Readonly<Partial<Record<SessionCommand, SessionState>>>>
> = {
  idle: {
    START: "starting",
    // Idempotent no-op: stopping an idle monitor is not an error.
    STOP: "stopped",
  },
  starting: {
    ACTIVATE: "monitoring",
    STOP: "stopped",
  },
  monitoring: {
    // Idempotent no-op.
    ACTIVATE: "monitoring",
    PAUSE: "paused",
    // Idempotent no-op.
    RESUME: "monitoring",
    STOP: "stopped",
  },
  paused: {
    // Idempotent no-op.
    PAUSE: "paused",
    RESUME: "monitoring",
    STOP: "stopped",
  },
  stopped: {
    START: "starting",
    // Idempotent no-op.
    STOP: "stopped",
  },
};

/** True when `command` has a defined destination state from `from`. */
export function canTransition(from: SessionState, command: SessionCommand): boolean {
  return TRANSITIONS[from][command] !== undefined;
}

/**
 * Computes the destination state for `(from, command)` per the transition
 * table above. Returns `err({ kind: "invalid-transition", from, command })`
 * for any pair not present in the table.
 */
export function nextState(
  from: SessionState,
  command: SessionCommand,
): Result<SessionState, AppError> {
  const to = TRANSITIONS[from][command];
  if (to === undefined) {
    return err({ kind: "invalid-transition", from, command });
  }
  return ok(to);
}

/** Creates a brand-new session in the `starting` state. */
export function createSession(args: {
  id: string;
  url: string;
  requestedCount: number;
  now: number;
}): Session {
  return {
    id: args.id,
    url: args.url,
    state: "starting",
    requestedCount: args.requestedCount,
    tabIds: [],
    createdAt: args.now,
    updatedAt: args.now,
    seq: 0,
  };
}

/**
 * Applies `command` to `session`, returning a new `Session` with the
 * resulting `state` (and `updatedAt` bumped to `now`) on success, or
 * `err(invalid-transition)` on failure. Idempotent commands succeed and
 * still return a (shallow-copied) session; per the project convention,
 * `updatedAt` is only bumped when the state actually changes.
 */
export function applyCommand(
  session: Session,
  command: SessionCommand,
  now: number,
): Result<Session, AppError> {
  const result = nextState(session.state, command);
  if (!result.ok) return result;

  if (result.value === session.state) {
    // No-op transition (idempotent command): nothing changed, so leave
    // `updatedAt` untouched rather than implying an update occurred.
    return ok(session);
  }

  return ok({ ...session, state: result.value, updatedAt: now });
}

/** Replaces the tracked tab IDs wholesale, preserving the given order. */
export function withTabIds(session: Session, tabIds: readonly number[], now: number): Session {
  return { ...session, tabIds: [...tabIds], updatedAt: now };
}

/**
 * Appends `tabId` to the tracked set in creation order. A no-op (state
 * unchanged, `updatedAt` untouched) if `tabId` is already tracked — tab IDs
 * are unique and tab creation order is meaningful, so duplicates would
 * corrupt that order's meaning.
 */
export function addTabId(session: Session, tabId: number, now: number): Session {
  if (session.tabIds.includes(tabId)) return session;
  return { ...session, tabIds: [...session.tabIds, tabId], updatedAt: now };
}

/**
 * Removes every ID in `removed` from the tracked set, preserving the
 * relative order of the surviving IDs (tab creation order is meaningful; see
 * AGENTS.md "Tab identity is numeric"). A no-op (state unchanged, `updatedAt`
 * untouched) if none of `removed` were actually tracked.
 */
export function removeTabIds(session: Session, removed: readonly number[], now: number): Session {
  if (removed.length === 0) return session;
  const toRemove = new Set(removed);
  const remaining = session.tabIds.filter((id) => !toRemove.has(id));
  if (remaining.length === session.tabIds.length) return session;
  return { ...session, tabIds: remaining, updatedAt: now };
}

/**
 * Sets `seq` to the larger of the session's current `seq` and `seq`. A
 * restarted service worker must never reissue a sequence number that was
 * already used (see AGENTS.md "Sequence numbers win"), so this can only
 * move forward, never backward. A no-op (state unchanged, `updatedAt`
 * untouched) if the argument would not actually advance it.
 */
export function withSeq(session: Session, seq: number, now: number): Session {
  if (seq <= session.seq) return session;
  return { ...session, seq, updatedAt: now };
}

/** True only while a session is `"starting"` or `"monitoring"`. */
export function isActive(session: Session | null): boolean {
  if (session === null) return false;
  return session.state === "starting" || session.state === "monitoring";
}
