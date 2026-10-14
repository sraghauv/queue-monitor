import { describe, expect, it } from "vitest";
import {
  addTabId,
  applyCommand,
  canTransition,
  createSession,
  isActive,
  nextState,
  removeTabIds,
  withSeq,
  withTabIds,
  type SessionCommand,
} from "../../src/domain/session.js";
import type { Session, SessionState } from "../../src/domain/types.js";

const STATES: readonly SessionState[] = ["idle", "starting", "monitoring", "paused", "stopped"];
const COMMANDS: readonly SessionCommand[] = ["START", "ACTIVATE", "PAUSE", "RESUME", "STOP"];

/**
 * The transition table from AGENTS.md / the task spec, as data. Every
 * (from, command) pair not listed here is expected to be invalid. Keeping
 * this as a flat table means a future spec change is a one-line diff here
 * too.
 */
const EXPECTED_TRANSITIONS: ReadonlyArray<{
  from: SessionState;
  command: SessionCommand;
  to: SessionState;
}> = [
  { from: "idle", command: "START", to: "starting" },
  { from: "idle", command: "STOP", to: "stopped" },
  { from: "starting", command: "ACTIVATE", to: "monitoring" },
  { from: "starting", command: "STOP", to: "stopped" },
  { from: "monitoring", command: "PAUSE", to: "paused" },
  { from: "monitoring", command: "RESUME", to: "monitoring" },
  { from: "monitoring", command: "STOP", to: "stopped" },
  { from: "monitoring", command: "ACTIVATE", to: "monitoring" },
  { from: "paused", command: "RESUME", to: "monitoring" },
  { from: "paused", command: "PAUSE", to: "paused" },
  { from: "paused", command: "STOP", to: "stopped" },
  { from: "stopped", command: "STOP", to: "stopped" },
  { from: "stopped", command: "START", to: "starting" },
];

function expectedTo(from: SessionState, command: SessionCommand): SessionState | undefined {
  return EXPECTED_TRANSITIONS.find((t) => t.from === from && t.command === command)?.to;
}

describe("nextState / canTransition (exhaustive 25-case table)", () => {
  for (const from of STATES) {
    for (const command of COMMANDS) {
      const to = expectedTo(from, command);
      const label = `${from} + ${command} -> ${to ?? "invalid-transition"}`;

      it(label, () => {
        const result = nextState(from, command);
        if (to === undefined) {
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toEqual({ kind: "invalid-transition", from, command });
          }
          expect(canTransition(from, command)).toBe(false);
        } else {
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value).toBe(to);
          }
          expect(canTransition(from, command)).toBe(true);
        }
      });
    }
  }
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    url: "https://example.com/queue",
    state: "monitoring",
    requestedCount: 3,
    tabIds: [10, 20, 30],
    createdAt: 1000,
    updatedAt: 1000,
    seq: 5,
    ...overrides,
  };
}

describe("createSession", () => {
  it("builds a starting session with zeroed tracking fields", () => {
    const session = createSession({
      id: "abc",
      url: "https://example.com/q",
      requestedCount: 4,
      now: 500,
    });
    expect(session).toEqual({
      id: "abc",
      url: "https://example.com/q",
      state: "starting",
      requestedCount: 4,
      tabIds: [],
      createdAt: 500,
      updatedAt: 500,
      seq: 0,
    });
  });
});

describe("applyCommand", () => {
  it("transitions state and bumps updatedAt on a real change", () => {
    const session = makeSession({ state: "monitoring", updatedAt: 1000 });
    const result = applyCommand(session, "PAUSE", 2000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe("paused");
      expect(result.value.updatedAt).toBe(2000);
    }
    // purity: input untouched
    expect(session.state).toBe("monitoring");
    expect(session.updatedAt).toBe(1000);
  });

  it("returns invalid-transition without touching the session", () => {
    const session = makeSession({ state: "idle", updatedAt: 1000 });
    const result = applyCommand(session, "PAUSE", 2000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "invalid-transition", from: "idle", command: "PAUSE" });
    }
    expect(session.state).toBe("idle");
    expect(session.updatedAt).toBe(1000);
  });

  it("idle + STOP is idempotent (succeeds, no error) but is a real idle->stopped change", () => {
    // Unlike the no-op cases below, idle has no "stopped" state already, so
    // this genuinely changes state and DOES bump updatedAt. "Idempotent"
    // here means repeating STOP never errors, not that nothing changes.
    const session = makeSession({ state: "idle", updatedAt: 1000 });
    const result = applyCommand(session, "STOP", 2000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe("stopped");
      expect(result.value.updatedAt).toBe(2000);
    }
  });
});

describe("applyCommand: idempotent no-op commands succeed without changing state or updatedAt", () => {
  const cases: ReadonlyArray<{ state: SessionState; command: SessionCommand }> = [
    { state: "monitoring", command: "RESUME" },
    { state: "monitoring", command: "ACTIVATE" },
    { state: "paused", command: "PAUSE" },
    { state: "stopped", command: "STOP" },
  ];

  for (const { state, command } of cases) {
    it(`${state} + ${command}`, () => {
      const session = makeSession({ state, updatedAt: 1000 });
      const result = applyCommand(session, command, 9999);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.state).toBe(state);
        // No actual change occurred, so updatedAt must not be bumped.
        expect(result.value.updatedAt).toBe(1000);
      }
      // Purity: input untouched.
      expect(session.state).toBe(state);
      expect(session.updatedAt).toBe(1000);
    });
  }
});

describe("withTabIds", () => {
  it("replaces tab IDs and bumps updatedAt, without mutating input", () => {
    const session = makeSession({ tabIds: [1, 2], updatedAt: 1000 });
    const result = withTabIds(session, [7, 8, 9], 2000);
    expect(result.tabIds).toEqual([7, 8, 9]);
    expect(result.updatedAt).toBe(2000);
    expect(session.tabIds).toEqual([1, 2]);
    expect(session.updatedAt).toBe(1000);
  });
});

describe("addTabId", () => {
  it("appends a new tab id in creation order and bumps updatedAt", () => {
    const session = makeSession({ tabIds: [1, 2], updatedAt: 1000 });
    const result = addTabId(session, 3, 2000);
    expect(result.tabIds).toEqual([1, 2, 3]);
    expect(result.updatedAt).toBe(2000);
    // purity
    expect(session.tabIds).toEqual([1, 2]);
  });

  it("does not create duplicates and does not bump updatedAt", () => {
    const session = makeSession({ tabIds: [1, 2, 3], updatedAt: 1000 });
    const result = addTabId(session, 2, 2000);
    expect(result.tabIds).toEqual([1, 2, 3]);
    expect(result.updatedAt).toBe(1000);
    expect(session.tabIds).toEqual([1, 2, 3]);
  });
});

describe("removeTabIds", () => {
  it("removes the given ids while preserving relative order of survivors", () => {
    const session = makeSession({ tabIds: [10, 20, 30, 40, 50], updatedAt: 1000 });
    const result = removeTabIds(session, [20, 40], 2000);
    expect(result.tabIds).toEqual([10, 30, 50]);
    expect(result.updatedAt).toBe(2000);
    // purity
    expect(session.tabIds).toEqual([10, 20, 30, 40, 50]);
  });

  it("is a no-op (no updatedAt bump) when nothing to remove is tracked", () => {
    const session = makeSession({ tabIds: [10, 20], updatedAt: 1000 });
    const result = removeTabIds(session, [999], 2000);
    expect(result.tabIds).toEqual([10, 20]);
    expect(result.updatedAt).toBe(1000);
  });

  it("is a no-op when the removed list is empty", () => {
    const session = makeSession({ tabIds: [10, 20], updatedAt: 1000 });
    const result = removeTabIds(session, [], 2000);
    expect(result.tabIds).toEqual([10, 20]);
    expect(result.updatedAt).toBe(1000);
  });
});

describe("withSeq", () => {
  it("advances seq forward and bumps updatedAt", () => {
    const session = makeSession({ seq: 5, updatedAt: 1000 });
    const result = withSeq(session, 9, 2000);
    expect(result.seq).toBe(9);
    expect(result.updatedAt).toBe(2000);
    // purity
    expect(session.seq).toBe(5);
  });

  it("refuses to go backwards, keeping the larger seq and not bumping updatedAt", () => {
    const session = makeSession({ seq: 10, updatedAt: 1000 });
    const result = withSeq(session, 3, 2000);
    expect(result.seq).toBe(10);
    expect(result.updatedAt).toBe(1000);
  });

  it("treats an equal seq as a no-op", () => {
    const session = makeSession({ seq: 10, updatedAt: 1000 });
    const result = withSeq(session, 10, 2000);
    expect(result.seq).toBe(10);
    expect(result.updatedAt).toBe(1000);
  });
});

describe("isActive", () => {
  it("is true for starting and monitoring", () => {
    expect(isActive(makeSession({ state: "starting" }))).toBe(true);
    expect(isActive(makeSession({ state: "monitoring" }))).toBe(true);
  });

  it("is false for idle, paused, stopped, and null", () => {
    expect(isActive(makeSession({ state: "idle" }))).toBe(false);
    expect(isActive(makeSession({ state: "paused" }))).toBe(false);
    expect(isActive(makeSession({ state: "stopped" }))).toBe(false);
    expect(isActive(null)).toBe(false);
  });
});
