/**
 * Decoders for everything this extension keeps in `chrome.storage`. Stored
 * values are boundary input exactly like a network message: a previous
 * extension version, a corrupted profile, or a partial write can all leave
 * garbage behind. Every value is parsed into a `Result`, never cast.
 */

import type { AppError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { QueueReading, Session, SessionState, TabStatus } from "../domain/types.js";

export const SESSION_KEY = "queue-monitor:session";
export const READINGS_KEY = "queue-monitor:readings";

const SESSION_STATES: ReadonlySet<SessionState> = new Set([
  "idle",
  "starting",
  "monitoring",
  "paused",
  "stopped",
]);

const TAB_STATUSES: ReadonlySet<TabStatus> = new Set([
  "loading",
  "waiting",
  "ready",
  "unknown",
  "error",
  "closed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => isInteger(entry));
}

/** Clamps a finite progress value into the normalized 0..1 range. */
function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function parseStoredSession(raw: unknown): Result<Session | null, AppError> {
  // Nothing stored yet is a valid, un-exceptional state — not an error.
  if (raw === undefined || raw === null) {
    return ok(null);
  }
  if (!isRecord(raw)) {
    return err({ kind: "storage-failed", detail: "stored session was not an object" });
  }

  const id = raw["id"];
  if (typeof id !== "string") {
    return err({ kind: "storage-failed", detail: "stored session id was not a string" });
  }
  const url = raw["url"];
  if (typeof url !== "string") {
    return err({ kind: "storage-failed", detail: "stored session url was not a string" });
  }
  const state = raw["state"];
  if (typeof state !== "string" || !SESSION_STATES.has(state as SessionState)) {
    return err({ kind: "storage-failed", detail: "stored session state was not recognized" });
  }
  const requestedCount = raw["requestedCount"];
  if (!isFiniteNumber(requestedCount)) {
    return err({
      kind: "storage-failed",
      detail: "stored session requestedCount was not a finite number",
    });
  }
  const tabIds = raw["tabIds"];
  if (!isIntegerArray(tabIds)) {
    return err({
      kind: "storage-failed",
      detail: "stored session tabIds was not an array of integers",
    });
  }
  const createdAt = raw["createdAt"];
  if (!isFiniteNumber(createdAt)) {
    return err({
      kind: "storage-failed",
      detail: "stored session createdAt was not a finite number",
    });
  }
  const updatedAt = raw["updatedAt"];
  if (!isFiniteNumber(updatedAt)) {
    return err({
      kind: "storage-failed",
      detail: "stored session updatedAt was not a finite number",
    });
  }
  const seq = raw["seq"];
  if (!isFiniteNumber(seq)) {
    return err({ kind: "storage-failed", detail: "stored session seq was not a finite number" });
  }

  // Only known fields are copied through, so unrecognized extra keys on the
  // stored object (e.g. left behind by a future version) are silently
  // ignored rather than rejected.
  return ok({
    id,
    url,
    state: state as SessionState,
    requestedCount,
    tabIds,
    createdAt,
    updatedAt,
    seq,
  });
}

/**
 * Parses one stored reading. Returns `null` on any structural problem so the
 * caller can drop just this entry.
 */
function parseStoredReading(raw: unknown): QueueReading | null {
  if (!isRecord(raw)) return null;

  const tabId = raw["tabId"];
  if (!isInteger(tabId)) return null;

  const status = raw["status"];
  if (typeof status !== "string" || !TAB_STATUSES.has(status as TabStatus)) return null;

  const rawProgress = raw["progress"];
  let progress: number | null = null;
  if (rawProgress !== null) {
    // Non-finite is a structural problem (dropped); out-of-range is clamped,
    // mirroring parseContentReading's rule so both boundaries agree.
    if (!isFiniteNumber(rawProgress)) return null;
    progress = clampProgress(rawProgress);
  }

  const rawReadAt = raw["readAt"];
  let readAt: number | null = null;
  if (rawReadAt !== null) {
    if (!isFiniteNumber(rawReadAt)) return null;
    readAt = rawReadAt;
  }

  const seq = raw["seq"];
  if (!isInteger(seq) || seq < 0) return null;

  const latencyMs = raw["latencyMs"];
  const adapter = raw["adapter"];
  const error = raw["error"];

  return {
    tabId,
    status: status as TabStatus,
    progress,
    readAt,
    seq,
    ...(isFiniteNumber(latencyMs) ? { latencyMs } : {}),
    ...(typeof adapter === "string" ? { adapter } : {}),
    ...(typeof error === "string" ? { error } : {}),
  };
}

export function parseStoredReadings(raw: unknown): Result<readonly QueueReading[], AppError> {
  // Nothing stored yet is a valid, un-exceptional state — not an error.
  if (raw === undefined || raw === null) {
    return ok([]);
  }
  if (!Array.isArray(raw)) {
    return err({ kind: "storage-failed", detail: "stored readings was not an array" });
  }

  // A malformed entry is dropped, not fatal to the whole read: one corrupt
  // tab record should not erase every other tab's last-known reading.
  // Partial facts beat no facts.
  const readings: QueueReading[] = [];
  for (const entry of raw) {
    const parsed = parseStoredReading(entry);
    if (parsed !== null) readings.push(parsed);
  }
  return ok(readings);
}
