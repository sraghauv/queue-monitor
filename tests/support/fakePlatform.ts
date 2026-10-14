/**
 * Deterministic fakes for every browser port. Tests drive time and tab
 * behaviour explicitly; nothing here sleeps on a real timer, so a 100-tab
 * polling round costs microseconds.
 */

import {
  QUEUE_READING,
  type ContentReading,
  type ReadQueueRequest,
} from "../../src/domain/messages.js";
import { err, ok, type Result } from "../../src/domain/result.js";
import type { AppError } from "../../src/domain/errors.js";
import type { QueueReading, Session } from "../../src/domain/types.js";
import type {
  Clock,
  IdSource,
  Platform,
  StoragePort,
  TabsPort,
  TimerHandle,
  Timers,
} from "../../src/platform/browser.js";

export class FakeClock implements Clock {
  constructor(private current = 1_000_000) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

type Scheduled = { handle: TimerHandle; fn: () => void; dueAt: number };

/**
 * Manual timers: scheduled callbacks only run when a test asks. `delay`
 * resolves on the microtask queue so polling rounds still interleave.
 */
export class FakeTimers implements Timers {
  private nextId = 1;
  private scheduled: Scheduled[] = [];

  constructor(private readonly clock: FakeClock) {}

  async delay(_ms: number): Promise<void> {
    await Promise.resolve();
  }

  schedule(fn: () => void, ms: number): TimerHandle {
    const handle: TimerHandle = { id: this.nextId++ };
    this.scheduled.push({ handle, fn, dueAt: this.clock.now() + ms });
    return handle;
  }

  cancel(handle: TimerHandle): void {
    this.scheduled = this.scheduled.filter((entry) => entry.handle.id !== handle.id);
  }

  pending(): number {
    return this.scheduled.length;
  }

  /** Runs every callback due at or before the current clock time. */
  runDue(): number {
    const now = this.clock.now();
    const due = this.scheduled.filter((entry) => entry.dueAt <= now);
    this.scheduled = this.scheduled.filter((entry) => entry.dueAt > now);
    for (const entry of due) entry.fn();
    return due.length;
  }

  /** Advances the clock to the next due callback and runs it. */
  runNext(): boolean {
    const next = this.scheduled.shift();
    if (!next) return false;
    this.clock.set(Math.max(this.clock.now(), next.dueAt));
    next.fn();
    return true;
  }
}

export class FakeIdSource implements IdSource {
  private counter = 0;

  newSessionId(): string {
    this.counter += 1;
    return `session-${this.counter}`;
  }
}

export class FakeStorage implements StoragePort {
  session: Session | null = null;
  readings: readonly QueueReading[] = [];
  failNextWrite = false;
  failNextRead = false;
  writes = 0;

  async readSession(): Promise<Result<Session | null, AppError>> {
    if (this.failNextRead) {
      this.failNextRead = false;
      return err({ kind: "storage-failed", detail: "injected read failure" });
    }
    return ok(this.session);
  }

  async writeSession(session: Session | null): Promise<Result<void, AppError>> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return err({ kind: "storage-failed", detail: "injected write failure" });
    }
    this.writes += 1;
    this.session = session;
    return ok(undefined);
  }

  async readReadings(): Promise<Result<readonly QueueReading[], AppError>> {
    if (this.failNextRead) {
      this.failNextRead = false;
      return err({ kind: "storage-failed", detail: "injected read failure" });
    }
    return ok(this.readings);
  }

  async writeReadings(readings: readonly QueueReading[]): Promise<Result<void, AppError>> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return err({ kind: "storage-failed", detail: "injected write failure" });
    }
    this.writes += 1;
    this.readings = readings;
    return ok(undefined);
  }
}

/** What a faked tab does when read. */
export type TabBehaviour =
  | { kind: "waiting"; progress: number; adapter?: string }
  | { kind: "ready"; adapter?: string }
  | { kind: "unknown" }
  | { kind: "timeout" }
  | { kind: "throw"; detail: string }
  | { kind: "malformed"; payload: unknown }
  /** Answers with a stale sequence number, simulating a late response. */
  | { kind: "stale"; seq: number; progress: number };

export class FakeTabs implements TabsPort {
  /** Tab ids currently open, in creation order. */
  open: number[] = [];
  focused: number[] = [];
  reads: Array<{ tabId: number; seq: number }> = [];
  /** Highest number of reads observed in flight at once. */
  peakConcurrency = 0;

  private inFlight = 0;
  private nextTabId = 100;
  private behaviours = new Map<number, TabBehaviour>();
  private removedListeners = new Set<(tabId: number) => void>();

  constructor(
    private readonly options: {
      /** Fail `create` once this many tabs have been opened. */
      failCreateAfter?: number;
      defaultBehaviour?: TabBehaviour;
    } = {},
  ) {}

  setBehaviour(tabId: number, behaviour: TabBehaviour): void {
    this.behaviours.set(tabId, behaviour);
  }

  async create(url: string): Promise<Result<number, AppError>> {
    const limit = this.options.failCreateAfter;
    if (limit !== undefined && this.open.length >= limit) {
      return err({
        kind: "tab-create-failed",
        opened: this.open.length,
        requested: limit + 1,
        detail: `injected create failure for ${url}`,
      });
    }
    const tabId = this.nextTabId++;
    this.open.push(tabId);
    return ok(tabId);
  }

  async read(
    tabId: number,
    request: ReadQueueRequest,
    timeoutMs: number,
  ): Promise<Result<ContentReading, AppError>> {
    this.inFlight += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.inFlight);
    this.reads.push({ tabId, seq: request.seq });
    try {
      await Promise.resolve();
      if (!this.open.includes(tabId)) {
        return err({ kind: "tab-missing", tabId });
      }
      const behaviour = this.behaviours.get(tabId) ??
        this.options.defaultBehaviour ?? { kind: "waiting", progress: 0.5 };
      switch (behaviour.kind) {
        case "waiting":
          return ok({
            type: QUEUE_READING,
            seq: request.seq,
            status: "waiting",
            progress: behaviour.progress,
            adapter: behaviour.adapter ?? "fake",
          });
        case "ready":
          return ok({
            type: QUEUE_READING,
            seq: request.seq,
            status: "ready",
            progress: 1,
            adapter: behaviour.adapter ?? "fake",
          });
        case "unknown":
          return ok({
            type: QUEUE_READING,
            seq: request.seq,
            status: "unknown",
            progress: null,
            adapter: null,
          });
        case "stale":
          return ok({
            type: QUEUE_READING,
            seq: behaviour.seq,
            status: "waiting",
            progress: behaviour.progress,
            adapter: "fake",
          });
        case "timeout":
          return err({ kind: "read-timeout", tabId, timeoutMs });
        case "throw":
          return err({ kind: "read-failed", tabId, detail: behaviour.detail });
        case "malformed":
          return err({ kind: "malformed-message", detail: "fake malformed payload" });
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  async listIds(): Promise<readonly number[]> {
    return [...this.open];
  }

  async focus(tabId: number): Promise<Result<void, AppError>> {
    if (!this.open.includes(tabId)) {
      return err({ kind: "focus-failed", tabId, detail: "tab is not open" });
    }
    this.focused.push(tabId);
    return ok(undefined);
  }

  onRemoved(listener: (tabId: number) => void): () => void {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }

  /** Simulates the user closing a tab. */
  closeTab(tabId: number): void {
    this.open = this.open.filter((id) => id !== tabId);
    for (const listener of this.removedListeners) listener(tabId);
  }
}

export type FakePlatform = Platform & {
  readonly tabs: FakeTabs;
  readonly storage: FakeStorage;
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  readonly ids: FakeIdSource;
};

export function createFakePlatform(
  options: { tabs?: FakeTabs; storage?: FakeStorage; clock?: FakeClock } = {},
): FakePlatform {
  const clock = options.clock ?? new FakeClock();
  return {
    tabs: options.tabs ?? new FakeTabs(),
    storage: options.storage ?? new FakeStorage(),
    clock,
    timers: new FakeTimers(clock),
    ids: new FakeIdSource(),
  };
}

/** Builds a reading without repeating every field in each test. */
export function reading(overrides: Partial<QueueReading> & { tabId: number }): QueueReading {
  return {
    status: "waiting",
    progress: 0.5,
    readAt: 1_000_000,
    seq: 1,
    ...overrides,
  };
}
