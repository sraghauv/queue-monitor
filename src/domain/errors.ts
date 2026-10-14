/**
 * Tagged error algebra. Every failure the extension can produce is enumerated
 * here so UI and logs can report causes honestly instead of collapsing them
 * into a single opaque "error".
 */

import type { SessionState } from "./types.js";

export type AppError =
  | { readonly kind: "invalid-url"; readonly detail: string }
  | { readonly kind: "unsupported-scheme"; readonly scheme: string }
  | { readonly kind: "unsupported-host"; readonly host: string }
  | { readonly kind: "invalid-count"; readonly detail: string }
  | {
      readonly kind: "invalid-transition";
      readonly from: SessionState;
      readonly command: string;
    }
  | { readonly kind: "no-session" }
  | {
      readonly kind: "tab-create-failed";
      readonly opened: number;
      readonly requested: number;
      readonly detail: string;
    }
  | { readonly kind: "tab-missing"; readonly tabId: number }
  | { readonly kind: "read-timeout"; readonly tabId: number; readonly timeoutMs: number }
  | { readonly kind: "read-failed"; readonly tabId: number; readonly detail: string }
  | { readonly kind: "malformed-message"; readonly detail: string }
  | { readonly kind: "storage-failed"; readonly detail: string }
  | { readonly kind: "focus-failed"; readonly tabId: number; readonly detail: string };

/** Human-readable text for the popup. Never interpolates page-derived HTML. */
export function describeError(error: AppError): string {
  switch (error.kind) {
    case "invalid-url":
      return `That is not a usable URL: ${error.detail}`;
    case "unsupported-scheme":
      return `Only https: URLs are accepted (got ${error.scheme}).`;
    case "unsupported-host":
      return `${error.host} is not on the allowlist.`;
    case "invalid-count":
      return error.detail;
    case "invalid-transition":
      return `Cannot ${error.command} while ${error.from}.`;
    case "no-session":
      return "No session is active.";
    case "tab-create-failed":
      return `Opened ${error.opened} of ${error.requested} tabs before failing: ${error.detail}`;
    case "tab-missing":
      return `Tab ${error.tabId} is no longer open.`;
    case "read-timeout":
      return `Tab ${error.tabId} did not answer within ${error.timeoutMs}ms.`;
    case "read-failed":
      return `Tab ${error.tabId} could not be read: ${error.detail}`;
    case "malformed-message":
      return `Rejected a malformed message: ${error.detail}`;
    case "storage-failed":
      return `Local storage failed: ${error.detail}`;
    case "focus-failed":
      return `Could not focus tab ${error.tabId}: ${error.detail}`;
  }
}

/** Normalizes a caught unknown into a short, safe detail string. */
export function detailOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message.slice(0, 200);
  if (typeof cause === "string") return cause.slice(0, 200);
  return "unknown cause";
}
