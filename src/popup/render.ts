/**
 * Pure DOM rendering for the popup. No `chrome` namespace, no network, no
 * timers — only DOM reads/writes against elements handed in by the caller.
 *
 * No raw-markup DOM assignment of any kind appears in this file (AGENTS.md
 * "Render with textContent"). Every row is built with `document.createElement` and
 * `textContent`, including values that originated from a page (`adapter`,
 * `error`) — those are untrusted input and are rendered as literal text,
 * never parsed as markup.
 */

import { isStale } from "../domain/readings.js";
import type {
  QueueReading,
  RankedReading,
  Session,
  SessionState,
  Snapshot,
} from "../domain/types.js";
import {
  formatAge,
  formatFreshness,
  formatProgress,
  formatScore,
  formatThroughput,
  statusLabel,
} from "./format.js";

export type PopupHandlers = {
  onStart(url: string, count: number): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onFocusTab(tabId: number): void;
};

export type PopupElements = {
  readonly url: HTMLInputElement;
  readonly count: HTMLInputElement;
  readonly start: HTMLButtonElement;
  readonly pause: HTMLButtonElement;
  readonly resume: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
  readonly state: HTMLElement;
  readonly tabCount: HTMLElement;
  readonly throughput: HTMLElement;
  readonly freshness: HTMLElement;
  readonly error: HTMLElement;
  readonly rows: HTMLElement;
};

const REQUIRED_IDS = [
  "url",
  "count",
  "start",
  "pause",
  "resume",
  "stop",
  "state",
  "tab-count",
  "throughput",
  "freshness",
  "error",
  "rows",
] as const;

/**
 * Resolves every element `render`/`bindHandlers` need from `root`, throwing
 * a clear error naming the first missing id so a markup drift in
 * `popup.html` fails loudly instead of silently rendering nothing.
 */
export function resolveElements(root: ParentNode): PopupElements {
  const byId = new Map<string, Element>();
  for (const id of REQUIRED_IDS) {
    const el = root.querySelector(`#${id}`);
    if (el === null) {
      throw new Error(`popup markup is missing required element #${id}`);
    }
    byId.set(id, el);
  }

  return {
    url: byId.get("url") as HTMLInputElement,
    count: byId.get("count") as HTMLInputElement,
    start: byId.get("start") as HTMLButtonElement,
    pause: byId.get("pause") as HTMLButtonElement,
    resume: byId.get("resume") as HTMLButtonElement,
    stop: byId.get("stop") as HTMLButtonElement,
    state: byId.get("state") as HTMLElement,
    tabCount: byId.get("tab-count") as HTMLElement,
    throughput: byId.get("throughput") as HTMLElement,
    freshness: byId.get("freshness") as HTMLElement,
    error: byId.get("error") as HTMLElement,
    rows: byId.get("rows") as HTMLElement,
  };
}

/**
 * Binds every listener exactly once. Must be called a single time per
 * popup lifetime — `render` never binds listeners, so repeated `render`
 * calls cannot accumulate duplicate handlers. Per-row focus buttons use one
 * delegated listener on `#rows` (reading `data-tab-id`) rather than one
 * listener per row.
 */
export function bindHandlers(elements: PopupElements, handlers: PopupHandlers): void {
  elements.start.addEventListener("click", () => {
    const url = elements.url.value.trim();
    const count = Number(elements.count.value);
    handlers.onStart(url, count);
  });
  elements.pause.addEventListener("click", () => {
    handlers.onPause();
  });
  elements.resume.addEventListener("click", () => {
    handlers.onResume();
  });
  elements.stop.addEventListener("click", () => {
    handlers.onStop();
  });
  elements.rows.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>("[data-tab-id]");
    if (button === null) return;
    const raw = button.dataset["tabId"];
    if (raw === undefined) return;
    const tabId = Number(raw);
    if (!Number.isInteger(tabId)) return;
    handlers.onFocusTab(tabId);
  });
}

/** Which of the four command buttons are enabled for a given session state. */
function buttonsFor(state: SessionState | null): {
  start: boolean;
  pause: boolean;
  resume: boolean;
  stop: boolean;
} {
  switch (state) {
    case null:
    case "idle":
    case "stopped":
      return { start: true, pause: false, resume: false, stop: false };
    case "starting":
    case "monitoring":
      return { start: false, pause: true, resume: false, stop: true };
    case "paused":
      return { start: false, pause: false, resume: true, stop: true };
  }
}

/**
 * Renders one full snapshot. Idempotent: calling this twice with the same
 * `snapshot`/`now` produces the same DOM — row count never grows, and no
 * listeners are (re)bound here.
 */
export function render(elements: PopupElements, snapshot: Snapshot, now: number): void {
  renderControls(elements, snapshot.session);
  renderStatus(elements, snapshot, now);
  renderError(elements, snapshot.lastError);
  renderRows(elements, snapshot, now);
}

function renderControls(elements: PopupElements, session: Session | null): void {
  const enabled = buttonsFor(session?.state ?? null);
  elements.start.disabled = !enabled.start;
  elements.pause.disabled = !enabled.pause;
  elements.resume.disabled = !enabled.resume;
  elements.stop.disabled = !enabled.stop;
}

function renderStatus(elements: PopupElements, snapshot: Snapshot, now: number): void {
  const state = snapshot.session?.state ?? "idle";
  elements.state.textContent = `Status: ${state}`;

  const tabCount = snapshot.session?.tabIds.length ?? 0;
  elements.tabCount.textContent = `Tabs tracked: ${tabCount}`;

  elements.throughput.textContent = formatThroughput(snapshot.metrics);
  elements.freshness.textContent = formatFreshness(snapshot.metrics);
  // `now` is accepted for symmetry with `render`'s contract and because a
  // future freshness refinement may need "now" rather than `Date.now()`
  // internally; it is intentionally unused today.
  void now;
}

function renderError(elements: PopupElements, lastError: string | null): void {
  elements.error.textContent = lastError ?? "";
}

/** Status values that never carry a numeric score/progress on screen. */
const NEVER_NUMERIC = new Set(["error", "closed", "unknown"]);

function renderRows(elements: PopupElements, snapshot: Snapshot, now: number): void {
  const rankedByTab = new Map<number, RankedReading>(snapshot.ranked.map((r) => [r.tabId, r]));
  const readyTabIds = new Set<number>(snapshot.ready.map((r) => r.tabId));

  // Rebuild the tbody from scratch each render. This keeps `render`
  // idempotent (no accumulation across calls) at the cost of discarding
  // and recreating row elements; the delegated click listener on `#rows`
  // (bound once in `bindHandlers`) is unaffected because it never attaches
  // to individual rows.
  elements.rows.replaceChildren();

  // Row order follows `snapshot.readings` (tracked tab order), NOT rank —
  // AGENTS.md: ranking must never reorder the tracked IDs.
  for (const reading of snapshot.readings) {
    const ranked = rankedByTab.get(reading.tabId);
    const isReady = readyTabIds.has(reading.tabId);
    elements.rows.append(buildRow(reading, ranked, isReady, now));
  }
}

function buildRow(
  reading: QueueReading,
  ranked: RankedReading | undefined,
  isReady: boolean,
  now: number,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.classList.add(rowClassFor(reading.status));

  const stale = isStale(reading, now);
  if (stale) tr.classList.add("row--stale");

  tr.append(cell(ranked?.place === undefined ? "—" : String(ranked.place)));
  tr.append(cell(String(reading.tabId)));
  tr.append(statusCell(reading, isReady, stale, now));
  tr.append(cell(statusAllowsNumber(reading.status) ? formatProgress(reading.progress) : "—"));
  tr.append(scoreCell(ranked, isReady));
  tr.append(lastReadCell(reading, now));
  tr.append(actionsCell(reading.tabId));

  return tr;
}

function rowClassFor(status: QueueReading["status"]): string {
  switch (status) {
    case "ready":
      return "row--ready";
    case "error":
      return "row--error";
    case "closed":
      return "row--closed";
    case "unknown":
      return "row--unknown";
    case "loading":
    case "waiting":
      return "row--waiting";
  }
}

function statusAllowsNumber(status: QueueReading["status"]): boolean {
  return !NEVER_NUMERIC.has(status);
}

function statusCell(
  reading: QueueReading,
  isReady: boolean,
  stale: boolean,
  now: number,
): HTMLTableCellElement {
  const td = document.createElement("td");

  const badge = document.createElement("span");
  badge.classList.add("status-badge", `status-badge--${reading.status}`);
  badge.textContent = statusLabel(reading.status);
  td.append(badge);

  if (isReady) {
    // `ready` is never presented as just another percentage — it gets its
    // own top-priority label, distinct from any numeric score.
    const flag = document.createElement("span");
    flag.classList.add("ready-flag");
    flag.textContent = " Top priority";
    td.append(flag);
  }

  if (stale) {
    const marker = document.createElement("span");
    marker.classList.add("stale-marker");
    marker.textContent = `Stale (${formatAge(ageOrNull(reading, now))})`;
    td.append(marker);
  }

  if (reading.error !== undefined && reading.error.length > 0) {
    const detail = document.createElement("div");
    detail.classList.add("row-error-detail");
    detail.textContent = reading.error;
    td.append(detail);
  }

  if (reading.adapter !== undefined && reading.adapter.length > 0) {
    // Adapter ids are reported by a content script reading an untrusted
    // page (see messages.ts doc comment); render as literal text only,
    // same as `error` above, never as markup.
    const adapterTag = document.createElement("div");
    adapterTag.classList.add("row-adapter-tag");
    adapterTag.textContent = `via ${reading.adapter}`;
    td.append(adapterTag);
  }

  return td;
}

function ageOrNull(reading: QueueReading, now: number): number | null {
  if (reading.readAt === null) return null;
  return Math.max(0, now - reading.readAt);
}

function scoreCell(ranked: RankedReading | undefined, isReady: boolean): HTMLTableCellElement {
  const td = document.createElement("td");
  if (isReady) {
    td.textContent = "—";
    return td;
  }
  td.textContent = formatScore(ranked?.score ?? null);
  return td;
}

function lastReadCell(reading: QueueReading, now: number): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = formatAge(ageOrNull(reading, now));
  return td;
}

function actionsCell(tabId: number): HTMLTableCellElement {
  const td = document.createElement("td");
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("focus-btn");
  button.textContent = "Focus";
  button.dataset["tabId"] = String(tabId);
  td.append(button);
  return td;
}

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}
