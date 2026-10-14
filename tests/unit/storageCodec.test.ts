import { describe, expect, it } from "vitest";
import {
  parseStoredReadings,
  parseStoredSession,
  READINGS_KEY,
  SESSION_KEY,
} from "../../src/platform/storageCodec.js";
import type { QueueReading, Session } from "../../src/domain/types.js";

const VALID_SESSION: Session = {
  id: "session-1",
  url: "https://example.com/queue",
  state: "monitoring",
  requestedCount: 5,
  tabIds: [100, 101, 102],
  createdAt: 1_000_000,
  updatedAt: 1_000_500,
  seq: 7,
};

const VALID_READING: QueueReading = {
  tabId: 100,
  status: "waiting",
  progress: 0.42,
  readAt: 1_000_100,
  seq: 1,
};

describe("storage keys", () => {
  it("are stable, namespaced strings", () => {
    expect(SESSION_KEY).toBe("queue-monitor:session");
    expect(READINGS_KEY).toBe("queue-monitor:readings");
  });
});

describe("parseStoredSession", () => {
  it("treats undefined as nothing stored, not an error", () => {
    const result = parseStoredSession(undefined);
    expect(result).toEqual({ ok: true, value: null });
  });

  it("treats null as nothing stored, not an error", () => {
    const result = parseStoredSession(null);
    expect(result).toEqual({ ok: true, value: null });
  });

  it("round-trips a valid session", () => {
    const result = parseStoredSession(VALID_SESSION);
    expect(result).toEqual({ ok: true, value: VALID_SESSION });
  });

  it("accepts extra unknown fields, ignoring them", () => {
    const result = parseStoredSession({
      ...VALID_SESSION,
      somethingFromAFutureVersion: "extra",
      nested: { a: 1 },
    });
    expect(result).toEqual({ ok: true, value: VALID_SESSION });
  });

  it("rejects a non-object top-level value", () => {
    const result = parseStoredSession("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("storage-failed");
  });

  it("rejects an array top-level value even though typeof is object", () => {
    const result = parseStoredSession([VALID_SESSION]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("storage-failed");
  });

  it("rejects an unrecognized state", () => {
    const result = parseStoredSession({ ...VALID_SESSION, state: "bogus" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("storage-failed");
  });

  it("rejects a non-array tabIds", () => {
    const result = parseStoredSession({ ...VALID_SESSION, tabIds: "100,101" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("storage-failed");
  });

  it("rejects tabIds containing a non-integer", () => {
    const result = parseStoredSession({ ...VALID_SESSION, tabIds: [100, 101.5, 102] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("storage-failed");
  });

  it("rejects a missing/non-string url", () => {
    const result = parseStoredSession({ ...VALID_SESSION, url: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("storage-failed");
  });

  it("rejects a non-finite seq", () => {
    const result = parseStoredSession({ ...VALID_SESSION, seq: Number.POSITIVE_INFINITY });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("storage-failed");
  });
});

describe("parseStoredReadings", () => {
  it("treats undefined as no readings, not an error", () => {
    const result = parseStoredReadings(undefined);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("treats null as no readings, not an error", () => {
    const result = parseStoredReadings(null);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("round-trips a valid readings array", () => {
    const result = parseStoredReadings([VALID_READING]);
    expect(result).toEqual({ ok: true, value: [VALID_READING] });
  });

  it("accepts extra unknown fields on a reading, ignoring them", () => {
    const result = parseStoredReadings([{ ...VALID_READING, futureField: "x" }]);
    expect(result).toEqual({ ok: true, value: [VALID_READING] });
  });

  it("preserves optional latencyMs, adapter, and error fields", () => {
    const withExtras: QueueReading = {
      ...VALID_READING,
      latencyMs: 123,
      adapter: "ticketmaster",
      error: "boom",
    };
    const result = parseStoredReadings([withExtras]);
    expect(result).toEqual({ ok: true, value: [withExtras] });
  });

  it("rejects a non-array top-level value", () => {
    const result = parseStoredReadings({ not: "an array" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("storage-failed");
  });

  it("drops a malformed entry (bad status) while keeping valid ones", () => {
    const bad = { ...VALID_READING, tabId: 101, status: "bogus-status" };
    const result = parseStoredReadings([VALID_READING, bad, { ...VALID_READING, tabId: 102 }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value.map((r) => r.tabId)).toEqual([100, 102]);
    }
  });

  it("drops an entry with a non-integer tabId", () => {
    const bad = { ...VALID_READING, tabId: 100.5 };
    const result = parseStoredReadings([bad]);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("drops an entry whose top-level shape is not an object", () => {
    const result = parseStoredReadings([VALID_READING, "not an object", 42, null]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([VALID_READING]);
  });

  it("clamps out-of-range progress into 0..1 rather than rejecting it", () => {
    const tooHigh = { ...VALID_READING, tabId: 100, progress: 5 };
    const tooLow = { ...VALID_READING, tabId: 101, progress: -3 };
    const result = parseStoredReadings([tooHigh, tooLow]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.progress).toBe(1);
      expect(result.value[1]?.progress).toBe(0);
    }
  });

  it("drops an entry whose progress is non-finite (NaN/Infinity)", () => {
    const nanEntry = { ...VALID_READING, tabId: 100, progress: Number.NaN };
    const infEntry = { ...VALID_READING, tabId: 101, progress: Number.POSITIVE_INFINITY };
    const result = parseStoredReadings([nanEntry, infEntry]);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("accepts a null progress as a valid 'no trustworthy value' reading", () => {
    const result = parseStoredReadings([{ ...VALID_READING, progress: null }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.progress).toBeNull();
  });

  it("drops an entry with a bad status value", () => {
    const result = parseStoredReadings([{ ...VALID_READING, status: "pending" }]);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("drops an entry with a negative or non-integer seq", () => {
    const negative = { ...VALID_READING, tabId: 100, seq: -1 };
    const fractional = { ...VALID_READING, tabId: 101, seq: 1.5 };
    const result = parseStoredReadings([negative, fractional]);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("accepts every TabStatus value", () => {
    const statuses = ["loading", "waiting", "ready", "unknown", "error", "closed"];
    const entries = statuses.map((status, index) => ({ ...VALID_READING, tabId: index, status }));
    const result = parseStoredReadings(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(statuses.length);
      expect(result.value.map((r) => r.status)).toEqual(statuses);
    }
  });
});
