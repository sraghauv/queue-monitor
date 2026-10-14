import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Metrics, RankedReading, Session, Snapshot } from "../../src/domain/types.js";
import { EMPTY_METRICS } from "../../src/domain/types.js";
import type { PopupHandlers } from "../../src/popup/render.js";
import {
  formatAge,
  formatFreshness,
  formatProgress,
  formatScore,
  formatThroughput,
  statusLabel,
} from "../../src/popup/format.js";
import { bindHandlers, render, resolveElements } from "../../src/popup/render.js";
import { reading } from "../support/fakePlatform.js";

const POPUP_HTML = readFileSync(resolve(process.cwd(), "extension/popup.html"), "utf-8");

/** Loads the real popup.html into the jsdom document via DOMParser. */
function mountPopup(): void {
  const parsed = new DOMParser().parseFromString(POPUP_HTML, "text/html");
  document.documentElement.innerHTML = parsed.documentElement.innerHTML;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    url: "http://localhost/queue",
    state: "monitoring",
    requestedCount: 1,
    tabIds: [],
    createdAt: 0,
    updatedAt: 0,
    seq: 0,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<Metrics> = {}): Metrics {
  return { ...EMPTY_METRICS, ...overrides };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    session: makeSession(),
    readings: [],
    ranked: [],
    ready: [],
    metrics: makeMetrics(),
    takenAt: 0,
    lastError: null,
    ...overrides,
  };
}

function ranked(r: ReturnType<typeof reading>, place: number, score: number | null): RankedReading {
  return { ...r, place, score };
}

beforeEach(() => {
  mountPopup();
});

describe("format", () => {
  describe("formatAge", () => {
    it("renders null as never", () => {
      expect(formatAge(null)).toBe("never");
    });
    it("renders sub-second as just now", () => {
      expect(formatAge(0)).toBe("just now");
      expect(formatAge(999)).toBe("just now");
    });
    it("renders seconds", () => {
      expect(formatAge(3000)).toBe("3s ago");
      expect(formatAge(59_000)).toBe("59s ago");
    });
    it("renders minutes", () => {
      expect(formatAge(120_000)).toBe("2m ago");
      expect(formatAge(59 * 60_000)).toBe("59m ago");
    });
    it("renders hours", () => {
      expect(formatAge(60 * 60_000)).toBe("1h ago");
      expect(formatAge(3 * 60 * 60_000)).toBe("3h ago");
    });
  });

  describe("formatProgress", () => {
    it("renders null as an em dash, never 0", () => {
      expect(formatProgress(null)).toBe("—");
    });
    it("renders a fraction as a whole percent", () => {
      expect(formatProgress(0.41)).toBe("41%");
      expect(formatProgress(0)).toBe("0%");
      expect(formatProgress(1)).toBe("100%");
    });
    it("renders NaN as an em dash, never NaN text", () => {
      expect(formatProgress(Number.NaN)).toBe("—");
    });
  });

  describe("formatScore", () => {
    it("renders null as an em dash, never 0", () => {
      expect(formatScore(null)).toBe("—");
    });
    it("renders a rounded score", () => {
      expect(formatScore(87.4)).toBe("87");
    });
    it("renders non-finite as an em dash", () => {
      expect(formatScore(Number.POSITIVE_INFINITY)).toBe("—");
    });
  });

  describe("formatThroughput", () => {
    it("renders null rate as an em dash", () => {
      expect(formatThroughput(makeMetrics({ readsPerSecond: null }))).toBe("—");
    });
    it("renders a rate with one decimal", () => {
      expect(formatThroughput(makeMetrics({ readsPerSecond: 4.2 }))).toBe("4.2 reads/s");
    });
  });

  describe("formatFreshness", () => {
    it("renders null staleFraction as no readings yet", () => {
      expect(formatFreshness(makeMetrics({ staleFraction: null }))).toBe("no readings yet");
    });
    it("describes stale percentage and last round age", () => {
      const now = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const text = formatFreshness(makeMetrics({ staleFraction: 0.5, lastRoundAt: now - 3000 }));
      expect(text).toContain("50% stale");
      expect(text).toContain("3s ago");
      vi.restoreAllMocks();
    });
  });

  describe("statusLabel", () => {
    it("labels every status distinctly", () => {
      expect(statusLabel("loading")).toBe("Loading");
      expect(statusLabel("waiting")).toBe("Waiting");
      expect(statusLabel("ready")).toBe("Ready");
      expect(statusLabel("unknown")).toBe("Unknown");
      expect(statusLabel("error")).toBe("Read error");
      expect(statusLabel("closed")).toBe("Tab closed");
    });
  });
});

describe("resolveElements", () => {
  it("resolves every element from the real popup.html without throwing", () => {
    expect(() => resolveElements(document)).not.toThrow();
  });

  it("throws a clear error naming a missing id", () => {
    const broken = new DOMParser().parseFromString(
      POPUP_HTML.replace('id="start"', "data-start"),
      "text/html",
    );
    expect(() => resolveElements(broken)).toThrowError(/#start/u);
  });
});

describe("render", () => {
  it("follows readings order, not ranked order", () => {
    const elements = resolveElements(document);
    const r1 = reading({ tabId: 1, status: "waiting", progress: 0.2, readAt: 1000 });
    const r2 = reading({ tabId: 2, status: "waiting", progress: 0.9, readAt: 1000 });
    const r3 = reading({ tabId: 3, status: "waiting", progress: 0.5, readAt: 1000 });
    // Ranked (by progress desc) order would be 2, 3, 1 — readings order is 1, 2, 3.
    const snapshot = makeSnapshot({
      readings: [r1, r2, r3],
      ranked: [ranked(r2, 1, 100), ranked(r3, 2, 56), ranked(r1, 3, 22)],
    });
    render(elements, snapshot, 1000);

    const tabIdCells = [...elements.rows.children].map(
      (row) => row.querySelector("td:nth-child(2)")?.textContent,
    );
    expect(tabIdCells).toEqual(["1", "2", "3"]);
  });

  it("shows em dashes for place and score when a tab is absent from ranked", () => {
    const elements = resolveElements(document);
    const r1 = reading({ tabId: 1, status: "waiting", progress: 0.2, readAt: 1000 });
    const snapshot = makeSnapshot({ readings: [r1], ranked: [] });
    render(elements, snapshot, 1000);

    const row = elements.rows.children[0]!;
    expect(row.querySelector("td:nth-child(1)")?.textContent).toBe("—");
    expect(row.querySelector("td:nth-child(5)")?.textContent).toBe("—");
  });

  it("labels a ready tab as top priority instead of a percentage", () => {
    const elements = resolveElements(document);
    const r1 = reading({ tabId: 1, status: "ready", progress: 1, readAt: 1000 });
    const snapshot = makeSnapshot({ readings: [r1], ranked: [], ready: [r1] });
    render(elements, snapshot, 1000);

    const row = elements.rows.children[0]!;
    expect(row.textContent).toContain("Top priority");
    // A ready tab never shows a numeric score.
    expect(row.querySelector("td:nth-child(5)")?.textContent).toBe("—");
    expect(row.classList.contains("row--ready")).toBe(true);
  });

  it("marks a stale reading as stale and shows its age, never hiding the number", () => {
    const elements = resolveElements(document);
    const staleReading = reading({ tabId: 1, status: "waiting", progress: 0.3, readAt: 0 });
    // Well past the 15s STALE_AFTER_MS default.
    const now = 20_000;
    const snapshot = makeSnapshot({
      readings: [staleReading],
      ranked: [ranked(staleReading, 1, 100)],
    });
    render(elements, snapshot, now);

    const row = elements.rows.children[0]!;
    expect(row.classList.contains("row--stale")).toBe(true);
    expect(row.textContent).toContain("Stale");
    // The progress number is still shown, not hidden.
    expect(row.querySelector("td:nth-child(4)")?.textContent).toBe("30%");
  });

  it("renders closed, error, and unknown rows distinctly and never with a number", () => {
    const elements = resolveElements(document);
    const closed = reading({ tabId: 1, status: "closed", progress: null, readAt: 500 });
    const errored = reading({
      tabId: 2,
      status: "error",
      progress: null,
      readAt: 500,
      error: "boom",
    });
    const unknown = reading({ tabId: 3, status: "unknown", progress: null, readAt: 500 });
    const snapshot = makeSnapshot({ readings: [closed, errored, unknown], ranked: [] });
    render(elements, snapshot, 1000);

    const rows = [...elements.rows.children];
    expect(rows[0]!.classList.contains("row--closed")).toBe(true);
    expect(rows[1]!.classList.contains("row--error")).toBe(true);
    expect(rows[2]!.classList.contains("row--unknown")).toBe(true);

    for (const row of rows) {
      expect(row.querySelector("td:nth-child(4)")?.textContent).toBe("—");
      expect(row.querySelector("td:nth-child(5)")?.textContent).toBe("—");
    }

    // Each status badge carries distinct, non-color-only markers.
    expect(rows[0]!.querySelector(".status-badge--closed")).not.toBeNull();
    expect(rows[1]!.querySelector(".status-badge--error")).not.toBeNull();
    expect(rows[2]!.querySelector(".status-badge--unknown")).not.toBeNull();
  });

  it("enables/disables buttons correctly for every session state", () => {
    const elements = resolveElements(document);
    const cases: Array<[Session["state"] | null, [boolean, boolean, boolean, boolean]]> = [
      ["idle", [false, true, true, true]],
      ["starting", [true, false, true, false]],
      ["monitoring", [true, false, true, false]],
      ["paused", [true, true, false, false]],
      ["stopped", [false, true, true, true]],
      [null, [false, true, true, true]],
    ];

    for (const [state, [startDisabled, pauseDisabled, resumeDisabled, stopDisabled]] of cases) {
      const snapshot = makeSnapshot({ session: state === null ? null : makeSession({ state }) });
      render(elements, snapshot, 1000);
      expect(elements.start.disabled).toBe(startDisabled);
      expect(elements.pause.disabled).toBe(pauseDisabled);
      expect(elements.resume.disabled).toBe(resumeDisabled);
      expect(elements.stop.disabled).toBe(stopDisabled);
    }
  });

  it("is idempotent: rendering the same snapshot twice does not duplicate rows", () => {
    const elements = resolveElements(document);
    const r1 = reading({ tabId: 1, status: "waiting", progress: 0.4, readAt: 1000 });
    const r2 = reading({ tabId: 2, status: "waiting", progress: 0.6, readAt: 1000 });
    const snapshot = makeSnapshot({ readings: [r1, r2], ranked: [] });

    render(elements, snapshot, 1000);
    render(elements, snapshot, 1000);

    expect(elements.rows.children.length).toBe(2);
  });

  it("renders lastError via textContent and clears it when absent", () => {
    const elements = resolveElements(document);
    render(elements, makeSnapshot({ lastError: "Tab 7 is no longer open." }), 1000);
    expect(elements.error.textContent).toBe("Tab 7 is no longer open.");

    render(elements, makeSnapshot({ lastError: null }), 1000);
    expect(elements.error.textContent).toBe("");
  });

  it("renders adapter/error strings containing HTML as literal text, never as markup", () => {
    const elements = resolveElements(document);
    const payload = "<img src=x onerror=alert(1)>";
    const r1 = reading({
      tabId: 1,
      status: "error",
      progress: null,
      readAt: 1000,
      error: payload,
      adapter: payload,
    });
    const snapshot = makeSnapshot({ readings: [r1], ranked: [] });
    render(elements, snapshot, 1000);

    const row = elements.rows.children[0]!;
    expect(row.textContent).toContain(payload);
    expect(row.querySelector("img")).toBeNull();
    expect(elements.rows.querySelector("img")).toBeNull();
  });
});

function makeHandlers(): PopupHandlers {
  return {
    onStart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStop: vi.fn(),
    onFocusTab: vi.fn(),
  };
}

describe("bindHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches onFocusTab with the clicked row's tab id via delegation", () => {
    const elements = resolveElements(document);
    const handlers = makeHandlers();
    bindHandlers(elements, handlers);

    const r1 = reading({ tabId: 1, status: "waiting", progress: 0.1, readAt: 1000 });
    const r2 = reading({ tabId: 42, status: "waiting", progress: 0.1, readAt: 1000 });
    render(elements, makeSnapshot({ readings: [r1, r2], ranked: [] }), 1000);

    const secondRowButton = elements.rows.children[1]!.querySelector("button")!;
    secondRowButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(handlers.onFocusTab).toHaveBeenCalledWith(42);
    expect(handlers.onFocusTab).toHaveBeenCalledTimes(1);
  });

  it("dispatches onStart/onPause/onResume/onStop from their buttons", () => {
    const elements = resolveElements(document);
    const handlers = makeHandlers();
    bindHandlers(elements, handlers);

    elements.url.value = "http://localhost/queue";
    elements.count.value = "5";
    elements.start.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handlers.onStart).toHaveBeenCalledWith("http://localhost/queue", 5);

    elements.pause.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handlers.onPause).toHaveBeenCalledTimes(1);

    elements.resume.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handlers.onResume).toHaveBeenCalledTimes(1);

    elements.stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handlers.onStop).toHaveBeenCalledTimes(1);
  });

  it("binding handlers once and rendering twice does not duplicate click dispatches", () => {
    const elements = resolveElements(document);
    const handlers = makeHandlers();
    bindHandlers(elements, handlers);

    const r1 = reading({ tabId: 7, status: "waiting", progress: 0.1, readAt: 1000 });
    const snapshot = makeSnapshot({ readings: [r1], ranked: [] });
    render(elements, snapshot, 1000);
    render(elements, snapshot, 1000);

    const button = elements.rows.children[0]!.querySelector("button")!;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(handlers.onFocusTab).toHaveBeenCalledTimes(1);
    expect(handlers.onFocusTab).toHaveBeenCalledWith(7);
  });
});
