import { describe, expect, it } from "vitest";

import { progressElementAdapter } from "../../src/content/adapters/progressElement.js";
import { selectAdapter } from "../../src/content/adapters/index.js";
import type { QueueAdapter } from "../../src/content/adapters/types.js";
import { readQueue } from "../../src/content/reader.js";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const CONTRACT_FIELDS = ["type", "seq", "status", "progress", "adapter"] as const;

describe("progressElementAdapter", () => {
  it("reports waiting with normalized progress below completion", () => {
    const doc = parse('<progress id="queue" max="100" value="10"></progress>');
    expect(progressElementAdapter.matches(doc)).toBe(true);
    expect(progressElementAdapter.read(doc)).toEqual({ status: "waiting", progress: 0.1 });
  });

  it("reports ready when value equals max", () => {
    const doc = parse('<progress id="queue" max="100" value="100"></progress>');
    expect(progressElementAdapter.read(doc)).toEqual({ status: "ready", progress: 1 });
  });

  it("clamps progress to 1 and stays ready when value exceeds max", () => {
    const doc = parse('<progress id="queue" max="100" value="150"></progress>');
    expect(progressElementAdapter.read(doc)).toEqual({ status: "ready", progress: 1 });
  });

  it("reports unknown when max is zero", () => {
    const doc = parse('<progress id="queue" max="0" value="0"></progress>');
    expect(progressElementAdapter.read(doc)).toEqual({ status: "unknown", progress: null });
  });

  it("reports unknown and matches false when the element is missing", () => {
    const doc = parse("<div>no progress here</div>");
    expect(progressElementAdapter.matches(doc)).toBe(false);
    expect(progressElementAdapter.read(doc)).toEqual({ status: "unknown", progress: null });
  });

  it("reports unknown for a non-numeric value attribute rather than a guessed number", () => {
    const doc = parse('<progress id="queue" max="100" value="not-a-number"></progress>');
    expect(progressElementAdapter.read(doc)).toEqual({ status: "unknown", progress: null });
  });
});

describe("selectAdapter", () => {
  it("returns null for a page that matches no adapter", () => {
    const doc = parse("<div>unrelated page</div>");
    expect(selectAdapter(doc)).toBeNull();
  });

  it("returns the first matching adapter in declared order", () => {
    const doc = parse('<progress id="queue" max="100" value="10"></progress>');
    expect(selectAdapter(doc)?.id).toBe("progress-element");
  });
});

describe("readQueue", () => {
  it("echoes the request seq exactly", () => {
    const doc = parse('<progress id="queue" max="100" value="10"></progress>');
    const reading = readQueue(doc, 42);
    expect(reading.seq).toBe(42);
  });

  it("returns unknown with no adapter when nothing matches", () => {
    const doc = parse("<div>unrelated page</div>");
    const reading = readQueue(doc, 1);
    expect(reading).toEqual({
      type: "QUEUE_READING",
      seq: 1,
      status: "unknown",
      progress: null,
      adapter: null,
    });
  });

  it("returns loading when the document is still loading", () => {
    const doc = parse('<progress id="queue" max="100" value="10"></progress>');
    Object.defineProperty(doc, "readyState", { value: "loading", configurable: true });
    const reading = readQueue(doc, 7);
    expect(reading.status).toBe("loading");
    expect(reading.progress).toBeNull();
    expect(reading.adapter).toBe("progress-element");
  });

  it("delegates to the matched adapter once the document has finished loading", () => {
    const doc = parse('<progress id="queue" max="100" value="100"></progress>');
    const reading = readQueue(doc, 3);
    expect(reading.status).toBe("ready");
    expect(reading.progress).toBe(1);
    expect(reading.adapter).toBe("progress-element");
  });
});

describe("readQueue error handling and leakage", () => {
  it("returns unknown when the matched adapter throws", () => {
    const throwingAdapter: QueueAdapter = {
      id: "throws",
      matches: () => true,
      read: () => {
        throw new Error("boom");
      },
    };
    const doc = parse("<div>anything</div>");
    const reading = readQueue(doc, 9, [throwingAdapter]);
    expect(reading.status).toBe("unknown");
    expect(reading.progress).toBeNull();
    expect(reading.adapter).toBe("throws");
  });

  it("never leaks page data: the response contains exactly the five contract fields", () => {
    const doc = parse(
      '<progress id="queue" max="100" value="10"></progress><input value="secret">',
    );
    const reading = readQueue(doc, 1);
    expect(Object.keys(reading).toSorted()).toEqual(CONTRACT_FIELDS.toSorted());
  });
});
