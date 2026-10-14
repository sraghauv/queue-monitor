/**
 * Message contracts plus parsers. Every inbound message is validated: a content
 * script talks to pages, and any page script can post to the extension, so
 * nothing from the wire is trusted by shape alone.
 */

import type { AppError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import type { Snapshot, TabStatus } from "./types.js";

export const READ_QUEUE = "READ_QUEUE" as const;
export const QUEUE_READING = "QUEUE_READING" as const;

export type ReadQueueRequest = {
  readonly type: typeof READ_QUEUE;
  readonly seq: number;
};

/** What a content script may report. No page text is forwarded verbatim. */
export type ContentReading = {
  readonly type: typeof QUEUE_READING;
  readonly seq: number;
  readonly status: Extract<TabStatus, "loading" | "waiting" | "ready" | "unknown">;
  readonly progress: number | null;
  readonly adapter: string | null;
};

export type PopupCommand =
  | { readonly type: "START"; readonly url: string; readonly count: number }
  | { readonly type: "PAUSE" }
  | { readonly type: "RESUME" }
  | { readonly type: "STOP" }
  | { readonly type: "FOCUS_TAB"; readonly tabId: number }
  | { readonly type: "GET_SNAPSHOT" };

export type CommandName = PopupCommand["type"];

export type CommandResponse =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly error: AppError; readonly snapshot: Snapshot };

const CONTENT_STATUSES = new Set(["loading", "waiting", "ready", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseContentReading(raw: unknown): Result<ContentReading, AppError> {
  if (!isRecord(raw)) {
    return err({ kind: "malformed-message", detail: "reading was not an object" });
  }
  if (raw["type"] !== QUEUE_READING) {
    return err({ kind: "malformed-message", detail: "reading had the wrong type tag" });
  }
  const seq = raw["seq"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return err({ kind: "malformed-message", detail: "reading seq was not a non-negative integer" });
  }
  const status = raw["status"];
  if (typeof status !== "string" || !CONTENT_STATUSES.has(status)) {
    return err({ kind: "malformed-message", detail: "reading status was not recognized" });
  }
  const rawProgress = raw["progress"];
  let progress: number | null = null;
  if (rawProgress !== null && rawProgress !== undefined) {
    if (typeof rawProgress !== "number" || !Number.isFinite(rawProgress)) {
      return err({ kind: "malformed-message", detail: "reading progress was not a finite number" });
    }
    progress = Math.max(0, Math.min(1, rawProgress));
  }
  const rawAdapter = raw["adapter"];
  const adapter =
    typeof rawAdapter === "string" && rawAdapter.length > 0 ? rawAdapter.slice(0, 64) : null;

  return ok({
    type: QUEUE_READING,
    seq,
    status: status as ContentReading["status"],
    progress,
    adapter,
  });
}

export function parsePopupCommand(raw: unknown): Result<PopupCommand, AppError> {
  if (!isRecord(raw)) {
    return err({ kind: "malformed-message", detail: "command was not an object" });
  }
  switch (raw["type"]) {
    case "START": {
      const url = raw["url"];
      if (typeof url !== "string") {
        return err({ kind: "malformed-message", detail: "START url was not a string" });
      }
      const count = raw["count"];
      if (typeof count !== "number") {
        return err({ kind: "malformed-message", detail: "START count was not a number" });
      }
      return ok({ type: "START", url, count });
    }
    case "PAUSE":
      return ok({ type: "PAUSE" });
    case "RESUME":
      return ok({ type: "RESUME" });
    case "STOP":
      return ok({ type: "STOP" });
    case "GET_SNAPSHOT":
      return ok({ type: "GET_SNAPSHOT" });
    case "FOCUS_TAB": {
      const tabId = raw["tabId"];
      if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
        return err({ kind: "malformed-message", detail: "FOCUS_TAB tabId was not an integer" });
      }
      return ok({ type: "FOCUS_TAB", tabId });
    }
    default:
      return err({ kind: "malformed-message", detail: "unrecognized command type" });
  }
}
