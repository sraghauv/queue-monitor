/**
 * Adapter registry. Adding an adapter for a real site is a product decision,
 * not a code-only change: it requires authorization for that site and a
 * matching entry in the extension's host allowlist/manifest before it can
 * ever run against that host's pages. Until then, an unrecognized page must
 * read as `unknown` rather than be guessed at by a loosely-matching adapter.
 */

import { progressElementAdapter } from "./progressElement.js";
import type { QueueAdapter } from "./types.js";

export const ADAPTERS: readonly QueueAdapter[] = [progressElementAdapter];

/** First match wins, in declared order. `null` when nothing matches. */
export function selectAdapter(
  doc: Document,
  adapters: readonly QueueAdapter[] = ADAPTERS,
): QueueAdapter | null {
  for (const adapter of adapters) {
    if (adapter.matches(doc)) {
      return adapter;
    }
  }
  return null;
}
