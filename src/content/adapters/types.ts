/**
 * Adapter contract. An adapter is a pure, structural reader of a `Document` —
 * it never touches `chrome`, storage, or anything outside the DOM tree it is
 * given. See `index.ts` for the authorization requirement before adding one.
 */

import type { TabStatus } from "../../domain/types.js";

export type AdapterReading = {
  readonly status: Extract<TabStatus, "loading" | "waiting" | "ready" | "unknown">;
  readonly progress: number | null;
};

export type QueueAdapter = {
  /** Stable identifier reported with each reading. */
  readonly id: string;
  /** Cheap structural test: does this page look like the layout we parse? */
  matches(doc: Document): boolean;
  read(doc: Document): AdapterReading;
};
