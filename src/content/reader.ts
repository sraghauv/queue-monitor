/**
 * Turns a `Document` into a `ContentReading`. This is the only place in the
 * content script that assembles the response sent back to the background —
 * the returned object must contain ONLY the five contract fields (`type`,
 * `seq`, `status`, `progress`, `adapter`). Never add page text, URLs, form
 * values, cookies, or any other page-derived data to it.
 */

import { QUEUE_READING, type ContentReading } from "../domain/messages.js";
import { ADAPTERS, selectAdapter } from "./adapters/index.js";
import type { QueueAdapter } from "./adapters/types.js";

export function readQueue(
  doc: Document,
  seq: number,
  adapters: readonly QueueAdapter[] = ADAPTERS,
): ContentReading {
  const matched = selectAdapter(doc, adapters);

  if (matched === null) {
    return { type: QUEUE_READING, seq, status: "unknown", progress: null, adapter: null };
  }

  // A page still loading has no trustworthy reading yet — report `loading`
  // without attempting to parse a layout that may not have finished
  // rendering.
  if (doc.readyState === "loading") {
    return { type: QUEUE_READING, seq, status: "loading", progress: null, adapter: matched.id };
  }

  try {
    const reading = matched.read(doc);
    return {
      type: QUEUE_READING,
      seq,
      status: reading.status,
      progress: reading.progress,
      adapter: matched.id,
    };
  } catch {
    // A throwing adapter must never let an exception cross into the page;
    // it degrades to `unknown` instead.
    return { type: QUEUE_READING, seq, status: "unknown", progress: null, adapter: matched.id };
  }
}
