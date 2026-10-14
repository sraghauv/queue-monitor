/**
 * Adapter for the repo's own fixture (`mock-queue/index.html`): a native
 * `<progress id="queue" max="100" value="N">` element.
 */

import type { AdapterReading, QueueAdapter } from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function queueElement(doc: Document): Element | null {
  return doc.querySelector("progress#queue");
}

export const progressElementAdapter: QueueAdapter = {
  id: "progress-element",

  matches(doc: Document): boolean {
    return queueElement(doc) !== null;
  },

  read(doc: Document): AdapterReading {
    const el = queueElement(doc);
    // A disappeared element (navigated page, removed node) must report
    // `unknown` here, never a remembered previous number — this function is
    // re-run from scratch against the live `doc` on every call and holds no
    // state of its own, so there is nothing to fall back to and nothing
    // should be invented.
    if (el === null) {
      return { status: "unknown", progress: null };
    }

    // Parse the attributes directly rather than via the `.value`/`.max` IDL
    // getters: those getters silently coerce an invalid `value` attribute to
    // `0`, which would masquerade as a real reading of "just started"
    // instead of the parse failure it actually is.
    const value = Number(el.getAttribute("value"));
    const max = Number(el.getAttribute("max"));
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
      return { status: "unknown", progress: null };
    }

    const progress = clamp(value / max, 0, 1);
    return { status: value >= max ? "ready" : "waiting", progress };
  },
};
